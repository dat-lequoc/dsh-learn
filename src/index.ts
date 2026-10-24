/**
 * dsh-learn host half: a per-session, off-by-default guided-teaching mode.
 * Loosely mirrors @deepseek-ai/dsh-plan-mode's architecture (a slash
 * command, a conditional system-prompt section, an always-registered
 * self-guarding tool) for a teaching workflow instead of a planning one:
 *
 * - `/learn [off|topic]` turns guided learning on/off for the current
 *   session only; a topic is also sent to the model as the opening request
 *   (like `/plan <message>`), so the lesson starts right away. The switch is
 *   kept in memory only (not logged to the session's event log): DSH's
 *   public `Session.append()` API has no way to mark a custom event type
 *   `ignorable`, and an unrecognized non-ignorable event type permanently
 *   breaks that session's history after a host restart. See
 *   {@link LearnController.unit}.
 * - `learn:policy` prompt section (only rendered while active) carries the
 *   teaching method ported from pi-learn's `learn/skills/teach/SKILL.md`.
 * - `quiz` tool posts a graded multiple-choice check and returns at once (it
 *   never blocks, so no tool deadline applies). The learner answers in the
 *   Learn sidebar tab; the graded result reaches the agent as the next user
 *   message, via a small in-memory pending-answer bridge and the plugin's own
 *   `/learn/api/*` routes, the same shape as dsh-better-sidebar's
 *   `/sidebar/api/*` routes.
 *
 * No DSH source and no dsh-better-sidebar source are modified: the Client
 * half only consumes dsh-better-sidebar's public `ctx.betterSidebar` API,
 * and is a no-op when that plugin is absent.
 *
 * @module dsh-learn
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls in these packages' own `declare module '@deepseek-ai/cordis'`
// augmentations (ctx.commands, ctx.webServer) without a runtime import.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LearnUnitState } from './types.ts'
import { isCorrectSelection, normalizeOptions, resolveCorrectIndices, shuffleOptions } from './quiz.ts'
import type { QuizOption } from './quiz.ts'
import {
  deriveLearnState,
  QUIZ_POSTED_TEXT,
  quizAnswerMessage,
  recoverPendingQuiz,
  transcriptRows,
  type QuizGrade,
  type TranscriptRow,
} from './transcript.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { LearnApiError, readJsonBody, requireString, requireStringAllowEmpty, writeError, writeOk } from './wire.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

export type * from './types.ts'

/**
 * The host's bind-derived trust list is registered by `@deepseek-ai/dsh-web-app`
 * without a public Context augmentation — that package has no
 * `declare module '@deepseek-ai/cordis'` for it at all (it's an internal
 * bundle-glue concern). dsh-better-sidebar hits the same gap and resolves it by
 * restating the shape structurally instead of importing a nonexistent type.
 *
 * DSH 0.2.1 moved the list from `ctx.webRuntime` to `ctx.webStartup`; both are
 * optional here so the plugin mounts on either host line.
 */
interface TrustListService {
  trustedHosts: readonly string[]
}

/** Structural slice of `ctx.sessionController` for cold-session reads and agent resume. */
interface SessionControllerSlice {
  inspect(sessionId: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
  resolveAgent(sessionId: SessionId): Promise<{ readonly agent: Agent } | { readonly error: { readonly message: string } }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learn: LearnController
    /** Trust list on DSH 0.2.0 and earlier (removed in 0.2.1). */
    webRuntime?: TrustListService
    /** Trust list on DSH 0.2.1+ (replaces `webRuntime`). */
    webStartup?: TrustListService
    sessionController?: SessionControllerSlice
  }
}

/** The model-facing quiz tool's name. */
export const QUIZ_TOOL = 'quiz'

/** The built-in `@deepseek-ai/dsh-tool-ask-user` tool's name, guarded off while learn mode is active. */
const ASK_USER_QUESTION = 'ask_user_question'

/** Deployment-owned teaching guidance rendered as the `learn:policy` prompt section while active. */
export interface LearnModeConfig {
  section: string
}

/**
 * Validate deployment-owned teaching guidance. Missing, blank, non-string,
 * or unknown fields fail at plugin load rather than being silently ignored.
 * @param config - raw plugin config.
 * @returns a detached validated config; an empty `section` falls back to {@link DEFAULT_SECTION}.
 */
export function resolveConfig(config: LearnModeConfig): LearnModeConfig {
  const section = (config as Partial<LearnModeConfig>).section
  if (section !== undefined && typeof section !== 'string') {
    throw new Error('LearnModeConfig needs a string `section`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error(`LearnModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section }`)
  }
  return { section: section === undefined || section.trim() === '' ? DEFAULT_SECTION : section }
}

/** Default teaching method, adapted from pi-learn's `learn/skills/teach/SKILL.md`. */
export const DEFAULT_SECTION = [
  'Guided learning mode is ON for this session. Teach; do not just answer.',
  '',
  '- Ground every explanation in unconditional truths first (definitions, axioms, directly observable facts),',
  '  then connect derived facts back to them one inferential step at a time. Never assert a derived fact',
  '  before the truths it depends on are already in place.',
  '- Aim for "the click": compress the topic into the smallest set of generating ideas from which the rest',
  '  follows, rather than a long list of unconnected facts to memorize.',
  '- Work one concept node at a time: probe what the learner already knows, agree on the immediate goal,',
  '  outline a short plan, then teach the next node — checking understanding with the `quiz` tool before',
  '  moving on. Do not dump the whole topic in one message.',
  '- Use the `quiz` tool (not `ask_user_question`) for every comprehension check: it grades the answer and',
  '  shows the learner tight right/wrong feedback with an explanation, instead of collecting a free preference.',
  '  A quiz returns immediately and never blocks: after posting one, end your turn with no further text.',
  '  The learner\'s graded answer arrives later as their next message, starting with `[quiz-answer <id>]`;',
  '  continue the lesson from it. Post at most one quiz per turn.',
  '  Write quiz questions, options, and explanations in Markdown, never HTML tags. The learner sees the',
  '  right/wrong verdict separately, so write the explanation to fit either outcome (no "Correct!" opener).',
  '- Use LaTeX for math ($...$ inline, $$...$$ display) and fenced ```mermaid``` blocks for diagrams; both',
  '  render inline in the chat, so prefer them over ASCII art.',
  '- When the learner needs current facts (a definition, a recent event, a citation), use `web_search` /',
  '  `web_fetch` or delegate to a research subagent — do not invent sources.',
].join('\n')

/**
 * One quiz waiting on the learner. The question itself reaches the Learn tab
 * through the transcript (the call's logged arguments); only the call id, the
 * displayed option order, and the resolver live here.
 */
interface PendingQuiz {
  readonly callId: string
  readonly options: readonly QuizOption[]
  /** Values of the correct options (graded against the learner's picks). */
  readonly correctValues: readonly string[]
  readonly explanation: string
}

/**
 * Build a {@link LearnUnitState} whose optional `topic` key is omitted
 * rather than present-with-`undefined`, matching the wire/JSON contract
 * used everywhere else this state is read.
 * @param active - whether guided learning is active.
 * @param topic - the learner-given topic; omitted when absent or inactive.
 * @returns a state object with `topic` present only when defined.
 */
export function learnState(active: boolean, topic: string | undefined): LearnUnitState {
  return topic === undefined ? { active } : { active, topic }
}

/** What `/learn` touches in one session: its learn-mode switch and the agent's steering inbox. */
export interface LearnCommandTarget {
  readonly active: boolean
  set(active: boolean, topic?: string): void
  steer(text: string): void
}

/**
 * Run `/learn [off|topic]` for one session. A topic is also the learner's
 * opening request: like `/plan <message>`, it is sent to the model so the
 * lesson starts now instead of silently waiting for the learner to repeat it.
 * The switch flips first, so the turn the topic starts already renders the
 * `learn:policy` section.
 */
export function runLearnCommand(rawInput: string, target: LearnCommandTarget): { kind: 'success'; text: string } {
  const message = rawInput.trim()
  if (message === 'off') {
    const wasActive = target.active
    target.set(false)
    return { kind: 'success', text: wasActive ? 'Learn mode off.' : 'Learn mode is already off.' }
  }
  if (message === '') {
    target.set(true)
    return {
      kind: 'success',
      text: 'Learn mode on. Say what you want to learn to start the lesson; quizzes appear in the Learn tab. Use /learn off to leave.',
    }
  }
  target.set(true, message)
  target.steer(message)
  return {
    kind: 'success',
    text: `Learn mode on for "${message}". Quizzes appear in the Learn tab in the sidebar. Use /learn off to leave.`,
  }
}

/**
 * `ctx.learn`: owns logged learn-mode state, the `/learn` command, the
 * `learn:policy` prompt section, the `quiz` tool, and the pending-quiz bridge
 * the Learn sidebar tab's routes read and resolve.
 */
export class LearnController extends Service {
  static inject = ['tools', 'systemPrompt', 'webServer']

  private readonly section: string
  private readonly pending = new Map<string, PendingQuiz>()
  /** In-flight assistant text deltas per session, cleared when the attempt ends. */
  private readonly streaming = new Map<string, string>()
  /**
   * Per-session active/topic state in memory, lazily hydrated from the
   * session's logged `/learn` `command/run` events when first read.
   */
  private readonly unit = new Map<string, LearnUnitState>()

  constructor(ctx: Context, config: LearnModeConfig = { section: '' }) {
    super(ctx, 'learn')
    this.section = resolveConfig(config).section

    ctx.on('agent/assistant-stream' as never, ((payload: unknown) => {
      const record = payload as { agent?: { id?: unknown; session?: { id?: unknown } }; frame?: Record<string, unknown> } | null
      const frame = record?.frame
      if (frame === undefined) return
      const rawId = record?.agent?.session?.id ?? record?.agent?.id
      if (typeof rawId !== 'string') return
      const type = frame['type']
      if (type === 'start') {
        this.streaming.set(rawId, '')
      } else if (type === 'end') {
        this.streaming.delete(rawId)
      } else if (type === 'chunk') {
        const chunk = frame['chunk'] as { type?: unknown; text?: unknown } | undefined
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          this.streaming.set(rawId, (this.streaming.get(rawId) ?? '') + chunk.text)
        }
      }
    }) as never)

    ctx.systemPrompt.section({
      name: 'learn:policy',
      // Just after the built-in PLAN_POLICY (500): both are conditional
      // "mode" sections; no PromptSectionOrderName entry exists for an
      // external plugin (that enum is closed over DSH's own built-ins), so a
      // literal number is the correct, minimal choice — `order` is a plain
      // number field, not restricted to named constants.
      order: 550,
      text: (context) => {
        if (context.agent === undefined) return ''
        return this.loggedActive(context.agent.session) ? this.section : ''
      },
    })

    // The model reliably ignores the `learn:policy` guidance to prefer `quiz`
    // over `ask_user_question` for comprehension checks (observed live: it
    // called `ask_user_question` for a calibration question), leaving
    // `dsh-learn`'s pending-quiz bridge — and so the dedicated Learn tab —
    // empty. A guard is a harder backstop than prose: deny the built-in tool
    // outright while learn mode is active for that agent's session, with a
    // denial reason that redirects to `quiz`; a no-op when `dsh-tool-ask-user`
    // isn't installed, since the guard only fires on a call to that name.
    ctx.tools.guard((exec) => {
      if (exec.name !== ASK_USER_QUESTION) return undefined
      if (exec.agent === undefined || !this.loggedActive(exec.agent.session)) return undefined
      return `${ASK_USER_QUESTION} is disabled in guided learning mode; use \`${QUIZ_TOOL}\` for comprehension `
        + 'checks instead, or state the question in your reply for anything else.'
    })

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'learn',
        description: 'Turn guided learning mode on or off for this session',
        input: { hint: '[off|topic]' },
        handler: ({ agent, rawInput }) => runLearnCommand(rawInput, {
          active: this.loggedActive(agent.session),
          set: (active, topic) => this.set(agent.session, active, topic),
          steer: text => agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })),
        }),
      })
    })

    ctx.tools.register(defineTool({
      name: QUIZ_TOOL,
      description: 'Use only in guided learning mode. Pose ONE graded multiple-choice comprehension check. '
        + 'Unlike ask_user_question, this HAS a correct answer: the learner picks in the dedicated Learn sidebar '
        + 'tab, gets instant right/wrong feedback with your explanation, and the graded result comes back to you. '
        + 'Give each option a stable machine value; reference the correct one(s) by value in correctAnswer.',
      parameters: {
        question: { type: 'string', required: true, description: 'The single question to ask.' },
        details: { type: 'string', description: 'Optional extra context shown under the question.' },
        options: {
          type: 'array',
          required: true,
          description: 'Two or more answer options.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true, description: 'Display label.' },
              value: { type: 'string', description: 'Stable machine value; defaults to the label.' },
              description: { type: 'string', description: 'Optional detail shown under the option.' },
            },
          },
        },
        multiSelect: { type: 'boolean', description: 'True when more than one option is correct.' },
        correctAnswer: {
          oneOf: [
            { type: 'string', description: 'Single-select: the correct option\'s value.' },
            { type: 'array', items: { type: 'string' }, description: 'Multi-select: the correct options\' values.' },
          ],
          required: true,
          description: 'The correct option value(s), matching an option\'s `value` exactly.',
        },
        explanation: { type: 'string', required: true, description: 'Revealed after answering, right or wrong.' },
        shuffle: { type: 'boolean', description: 'Randomize display order (default true); set false when order is meaningful.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            posted: { type: 'boolean', required: true },
          },
        },
        render: () => [{ type: 'text', text: QUIZ_POSTED_TEXT }],
      },
      // Returns at once: the learner may think as long as they like, and no
      // run_code or tool deadline ever waits on them. Their graded answer
      // comes back as the next user message (see `submitAnswer`).
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${QUIZ_TOOL} requires a calling agent (no session to quiz)`)
        if (!this.loggedActive(agent.session)) {
          throw new Error(`${QUIZ_TOOL} is only available in learn mode; use /learn to turn it on first`)
        }
        const options = normalizeOptions(args.options)
        if (options.length < 2) throw new Error(`${QUIZ_TOOL} requires at least 2 options`)
        const displayed = args.shuffle === false ? options : shuffleOptions(options)
        const correctIndices = resolveCorrectIndices(args.correctAnswer, displayed)
        // A newer quiz replaces an unanswered older one.
        this.pending.set(String(agent.id), {
          // The Learn tab shows this quiz inline at the transcript row
          // keyed by the same call id, so an answer always reaches the
          // quiz the learner is looking at.
          callId: String(exec.callId),
          options: displayed,
          correctValues: correctIndices.map(index => displayed[index - 1]?.value ?? ''),
          explanation: args.explanation,
        })
        return { posted: true }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Quiz',
        kind: 'other',
        content: [{ type: 'text', text: args.question }],
      }),
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/learn/api',
      handler: async (req, res) => {
        // DSH 0.2.1 moved the list to `webStartup`; read whichever carrier exists.
        const trustedHosts = ctx.get('webStartup')?.trustedHosts ?? ctx.get('webRuntime')?.trustedHosts ?? []
        if (!isTrustedApiRequest(req, trustedHosts)) {
          writeError(res, new LearnApiError('forbidden', 'forbidden', 403))
          return
        }
        if (req.method !== 'POST') {
          writeError(res, new LearnApiError('method-error', 'method not allowed', 405))
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/learn/api/') ? pathname.slice('/learn/api/'.length) : undefined
        try {
          const payload = await readJsonBody(req)
          switch (method) {
            case 'state': {
              writeOk(res, await this.stateView(requireString(payload, 'sessionId')))
              return
            }
            case 'transcript': {
              writeOk(res, await this.transcriptView(requireString(payload, 'sessionId')))
              return
            }
            case 'pending-quiz': {
              writeOk(res, await this.pendingQuizView(requireString(payload, 'sessionId')))
              return
            }
            case 'submit-answer': {
              writeOk(res, await this.submitAnswer(requireString(payload, 'sessionId'), payload))
              return
            }
            case 'toggle': {
              writeOk(res, await this.toggle(requireString(payload, 'sessionId'), payload))
              return
            }
            case 'send': {
              writeOk(res, await this.send(requireString(payload, 'sessionId'), requireStringAllowEmpty(payload, 'text')))
              return
            }
            case 'interrupt': {
              writeOk(res, this.interrupt(requireString(payload, 'sessionId')))
              return
            }
            default: {
              throw new LearnApiError('not-found', `unknown learn API method "${String(method)}"`, 404)
            }
          }
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'dsh-learn: /learn/api routes')
  }

  private liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.get('agents')?.get(SessionId(sessionId))
  }

  private async resolveOrResumeAgent(sessionId: string): Promise<Agent> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const controller = this.ctx.get('sessionController')
    if (controller !== undefined) {
      const resolved = await controller.resolveAgent(SessionId(sessionId))
      if ('agent' in resolved) return resolved.agent
    }
    throw new LearnApiError('not-found', 'session is not live', 404)
  }

  private async readEvents(sessionId: string): Promise<readonly SessionEvent[]> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live.session.snapshotEvents()
    const attached = (this.ctx.get('sessions' as never) as { get(id: SessionId): Session | undefined } | undefined)?.get(SessionId(sessionId))
    if (attached !== undefined) return attached.snapshotEvents()
    const controller = this.ctx.get('sessionController')
    if (controller !== undefined) {
      try {
        const inspected = await controller.inspect(SessionId(sessionId))
        return inspected.events
      } catch {
        return []
      }
    }
    return []
  }

  private resolveState(sessionId: string, events: readonly SessionEvent[]): LearnUnitState | undefined {
    const existing = this.unit.get(sessionId)
    if (existing !== undefined) return existing
    const derived = deriveLearnState(events)
    if (derived !== undefined) this.unit.set(sessionId, derived)
    return derived
  }

  private resolvePending(sessionId: string, events: readonly SessionEvent[]): PendingQuiz | undefined {
    const existing = this.pending.get(sessionId)
    if (existing !== undefined) return existing
    const recovered = recoverPendingQuiz(events)
    if (recovered !== undefined) this.pending.set(sessionId, recovered)
    return recovered
  }

  /** Learn mode state and agent status for the Learn tab header and composer. */
  private async stateView(sessionId: string): Promise<{ active: boolean; topic: string | undefined; running: boolean }> {
    const agent = this.liveAgent(sessionId)
    const events = await this.readEvents(sessionId)
    const learn = this.resolveState(sessionId, events)
    return { active: learn?.active ?? false, topic: learn?.topic, running: agent?.status === 'running' }
  }

  /** The session's completed-turns transcript, flattened to renderable rows, plus any live streaming prose. */
  private async transcriptView(sessionId: string): Promise<{ rows: TranscriptRow[]; streamingText?: string }> {
    const events = await this.readEvents(sessionId)
    const streamingText = this.streaming.get(sessionId)
    return {
      rows: transcriptRows(events),
      ...streamingText !== undefined && streamingText !== '' ? { streamingText } : {},
    }
  }

  /**
   * The quiz waiting on the learner, or `null`: which transcript row is
   * answerable, and its options in the order they are graded against (the
   * logged arguments are pre-shuffle).
   */
  private async pendingQuizView(sessionId: string): Promise<{ callId: string; options: { label: string; value: string; description?: string }[] } | null> {
    const events = await this.readEvents(sessionId)
    const pending = this.resolvePending(sessionId, events)
    if (pending === undefined) return null
    return {
      callId: pending.callId,
      options: pending.options.map(option => ({
        label: option.label,
        value: option.value,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    }
  }

  /** Grade the pending quiz with the learner's picks and hand the result to the model, only when it is the quiz they answered. */
  private async submitAnswer(sessionId: string, payload: unknown): Promise<{ ok: true }> {
    const callId = requireString(payload, 'callId')
    const events = await this.readEvents(sessionId)
    const pending = this.resolvePending(sessionId, events)
    if (pending === undefined || pending.callId !== callId) {
      throw new LearnApiError('not-found', 'this quiz is no longer waiting for an answer', 404)
    }
    const record = payload as Record<string, unknown>
    const dontKnow = record.dontKnow === true
    const known = new Set(pending.options.map(option => option.value))
    const selectedValues = dontKnow || !Array.isArray(record.selectedValues)
      ? []
      : record.selectedValues.filter((v): v is string => typeof v === 'string' && known.has(v))
    if (!dontKnow && selectedValues.length === 0) throw new LearnApiError('bad-request', 'pick at least one option')
    const agent = await this.resolveOrResumeAgent(sessionId)
    const byValue = new Map(pending.options.map((option, index) => [option.value, index + 1]))
    const correctIndices = pending.correctValues.map(value => byValue.get(value)).filter((v): v is number => v !== undefined)
    const selectedIndices = selectedValues.map(value => byValue.get(value)).filter((v): v is number => v !== undefined)
    const grade: QuizGrade = {
      correct: !dontKnow && isCorrectSelection(selectedIndices, correctIndices),
      dontKnow,
      selected: selectedValues,
      correctValues: pending.correctValues,
      explanation: pending.explanation,
    }
    this.pending.delete(sessionId)
    // The graded answer reaches the model as the learner's next message; the
    // Learn tab folds it into the quiz card instead of showing a bubble.
    agent.steer(createUserMessage({ content: [{ type: 'text', text: quizAnswerMessage(pending.callId, grade) }], source: { kind: 'user' } }))
    return { ok: true }
  }

  /** Start or end guided learning directly from the Learn tab UI. */
  private async toggle(sessionId: string, payload: unknown): Promise<{ ok: true }> {
    const record = payload as Record<string, unknown> | null
    const active = record?.active === true
    const rawTopic = typeof record?.topic === 'string' ? record.topic.trim() : ''
    if (!active && this.liveAgent(sessionId) === undefined) {
      this.unit.set(sessionId, { active: false })
      return { ok: true }
    }
    const agent = await this.resolveOrResumeAgent(sessionId)
    const line = !active ? '/learn off' : rawTopic === '' ? '/learn' : `/learn ${rawTopic}`
    const commands = this.ctx.get('commands')
    if (commands !== undefined) {
      await commands.execute(agent, line, [], new AbortController().signal)
    } else {
      runLearnCommand(!active ? 'off' : rawTopic, {
        active: this.loggedActive(agent.session),
        set: (on, topic) => this.set(agent.session, on, topic),
        steer: text => agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })),
      })
    }
    return { ok: true }
  }

  /** Send a free-text learner message from the Learn tab's mobile composer. */
  private async send(sessionId: string, text: string): Promise<{ ok: true }> {
    if (text.trim() === '') throw new LearnApiError('bad-request', 'text must not be empty')
    const agent = await this.resolveOrResumeAgent(sessionId)
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return { ok: true }
  }

  /** Stop an active turn from the Learn tab's mobile composer. */
  private interrupt(sessionId: string): { ok: true } {
    const agent = this.liveAgent(sessionId)
    if (agent === undefined) throw new LearnApiError('not-found', 'session is not live', 404)
    agent.cancel({ kind: 'user' })
    return { ok: true }
  }

  private loggedActive(session: Session): boolean {
    const id = String(session.id)
    const existing = this.unit.get(id)
    if (existing !== undefined) return existing.active
    const derived = deriveLearnState(session.snapshotEvents())
    if (derived !== undefined) {
      this.unit.set(id, derived)
      return derived.active
    }
    return false
  }

  /** Select whether learn mode should be active for a session; kept in memory only (see {@link unit}). */
  private set(session: Session, active: boolean, topic?: string): void {
    this.unit.set(String(session.id), learnState(active, topic))
  }
}

export default LearnController
