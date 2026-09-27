/**
 * dsh-learn host half: a per-session, off-by-default guided-teaching mode.
 * Loosely mirrors @deepseek-ai/dsh-plan-mode's architecture (a slash
 * command, a conditional system-prompt section, an always-registered
 * self-guarding tool) for a teaching workflow instead of a planning one:
 *
 * - `/learn [off|topic]` turns guided learning on/off for the current
 *   session only. Kept in memory only (not logged to the session's event
 *   log): DSH's public `Session.append()` API has no way to mark a custom
 *   event type `ignorable`, and an unrecognized non-ignorable event type
 *   permanently breaks that session's history after a host restart. See
 *   {@link LearnController.unit}.
 * - `learn:policy` prompt section (only rendered while active) carries the
 *   teaching method ported from pi-learn's `learn/skills/teach/SKILL.md`.
 * - `quiz` tool poses a graded multiple-choice check, blocking until the
 *   human answers through the dedicated Learn sidebar tab (never the main
 *   chat composer) — via a small in-memory pending-answer bridge and the
 *   plugin's own `/learn/api/*` routes, the same shape as
 *   dsh-better-sidebar's `/sidebar/api/*` routes.
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
import { transcriptRows, type TranscriptRow } from './transcript.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { LearnApiError, readJsonBody, requireString, requireStringAllowEmpty, writeError, writeOk } from './wire.ts'

export type * from './types.ts'

/**
 * `ctx.webRuntime` (bind-derived trust list) is registered by
 * `@deepseek-ai/dsh-web-app` without a public Context augmentation — that
 * package has no `declare module '@deepseek-ai/cordis'` for it at all (it's
 * an internal bundle-glue concern). dsh-better-sidebar hits the same gap and
 * resolves it by restating the shape structurally instead of importing a
 * nonexistent type; this mirrors that precedent rather than depending on the
 * bundle package.
 */
interface WebRuntimeService {
  trustedHosts: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learn: LearnController
    webRuntime: WebRuntimeService
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
  '- Use LaTeX for math ($...$ inline, $$...$$ display) and fenced ```mermaid``` blocks for diagrams; both',
  '  render inline in the chat, so prefer them over ASCII art.',
  '- When the learner needs current facts (a definition, a recent event, a citation), use `web_search` /',
  '  `web_fetch` or delegate to a research subagent — do not invent sources.',
].join('\n')

/** One learner-facing multiple-choice question and its answer, pending in the Learn tab. */
interface PendingQuiz {
  readonly question: string
  readonly details: string | undefined
  readonly options: readonly QuizOption[]
  readonly multiSelect: boolean
  readonly correctIndices: readonly number[]
  readonly explanation: string
  readonly resolve: (answer: QuizSubmission) => void
}

/** What the Learn tab posts back for one quiz. */
interface QuizSubmission {
  readonly dontKnow: boolean
  readonly selectedValues: readonly string[]
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

/**
 * `ctx.learn`: owns logged learn-mode state, the `/learn` command, the
 * `learn:policy` prompt section, the `quiz` tool, and the pending-quiz bridge
 * the Learn sidebar tab's routes read and resolve.
 */
export class LearnController extends Service {
  static inject = ['tools', 'systemPrompt', 'webServer', 'webRuntime']

  private readonly section: string
  private readonly pending = new Map<string, PendingQuiz>()
  /**
   * Per-session active/topic state, in memory only. Deliberately not logged
   * to the session's event log: DSH's public `Session.append()` API has no
   * way to mark a custom event type `ignorable`, so a logged `learn/mode`
   * event permanently breaks that session's history after any host restart
   * (`dsh-session-persistence` refuses to reload a log containing an
   * unrecognized, non-ignorable event type). Same durability class as
   * {@link pending}: cleared on restart, which only means `/learn` reverts
   * to off — an acceptable tradeoff for this off-by-default dev feature.
   */
  private readonly unit = new Map<string, LearnUnitState>()

  constructor(ctx: Context, config: LearnModeConfig = { section: '' }) {
    super(ctx, 'learn')
    this.section = resolveConfig(config).section

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
        handler: ({ agent, rawInput }) => {
          const message = rawInput.trim()
          if (message === 'off') {
            const wasActive = this.loggedActive(agent.session)
            this.set(agent.session, false)
            return { kind: 'success', text: wasActive ? 'Learn mode off.' : 'Learn mode is already off.' }
          }
          const topic = message === '' ? undefined : message
          this.set(agent.session, true, topic)
          return {
            kind: 'success',
            text: topic === undefined
              ? 'Learn mode on. Open the Learn tab in the sidebar. Use /learn off to leave.'
              : `Learn mode on for "${topic}". Open the Learn tab in the sidebar. Use /learn off to leave.`,
          }
        },
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
            correct: { type: 'boolean', required: true },
            dontKnow: { type: 'boolean', required: true },
            selected: { type: 'array', items: { type: 'string' }, required: true },
            correctValues: { type: 'array', items: { type: 'string' }, required: true },
            explanation: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.dontKnow
            ? `Learner answered "I don't know". ${value.explanation}`
            : `Learner answered ${value.correct ? 'correctly' : 'incorrectly'} (picked: ${value.selected.join(', ') || '(none)'}; correct: ${value.correctValues.join(', ')}). ${value.explanation}`,
        }],
      },
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
        const submission = await new Promise<QuizSubmission>((resolve, reject) => {
          const key = String(agent.id)
          if (this.pending.has(key)) {
            reject(new Error(`${QUIZ_TOOL}: a previous quiz for this session was never answered`))
            return
          }
          this.pending.set(key, {
            question: args.question,
            details: args.details,
            options: displayed,
            multiSelect: args.multiSelect === true,
            correctIndices,
            explanation: args.explanation,
            resolve,
          })
          const onAbort = (): void => {
            this.pending.delete(key)
            reject(new Error(`${QUIZ_TOOL} was cancelled`))
          }
          exec.signal.addEventListener('abort', onAbort, { once: true })
        }).finally(() => this.pending.delete(String(agent.id)))
        if (submission.dontKnow) {
          return {
            correct: false,
            dontKnow: true,
            selected: [] as string[],
            correctValues: correctIndices.map(index => displayed[index - 1]?.value ?? ''),
            explanation: args.explanation,
          }
        }
        const byValue = new Map(displayed.map((option, index) => [option.value, index + 1]))
        const selectedIndices = submission.selectedValues.map(value => byValue.get(value)).filter((v): v is number => v !== undefined)
        const correct = isCorrectSelection(selectedIndices, correctIndices)
        return {
          correct,
          dontKnow: false,
          selected: [...submission.selectedValues],
          correctValues: correctIndices.map(index => displayed[index - 1]?.value ?? ''),
          explanation: args.explanation,
        }
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
        if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
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
              writeOk(res, this.stateView(requireString(payload, 'sessionId')))
              return
            }
            case 'transcript': {
              writeOk(res, this.transcriptView(requireString(payload, 'sessionId')))
              return
            }
            case 'pending-quiz': {
              writeOk(res, this.pendingQuizView(requireString(payload, 'sessionId')))
              return
            }
            case 'submit-answer': {
              writeOk(res, this.submitAnswer(requireString(payload, 'sessionId'), payload))
              return
            }
            case 'send': {
              writeOk(res, this.send(requireString(payload, 'sessionId'), requireStringAllowEmpty(payload, 'text')))
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

  private requireAgent(sessionId: string): Agent {
    const agents = this.ctx.get('agents')
    const agent = agents?.get(SessionId(sessionId))
    if (agent === undefined) throw new LearnApiError('not-found', 'session is not live', 404)
    return agent
  }

  /** Learn mode state and agent status for the Learn tab header and composer. */
  private stateView(sessionId: string): { active: boolean; topic: string | undefined; running: boolean } {
    const agent = this.requireAgent(sessionId)
    const learn = this.unit.get(String(agent.session.id))
    return { active: learn?.active ?? false, topic: learn?.topic, running: agent.status === 'running' }
  }

  /** The session's completed-turns transcript, flattened to renderable rows. */
  private transcriptView(sessionId: string): { rows: TranscriptRow[] } {
    const agent = this.requireAgent(sessionId)
    return { rows: transcriptRows(agent.session.snapshotEvents()) }
  }

  /** Current pending quiz for one session, or `null` when none is waiting. */
  private pendingQuizView(sessionId: string): unknown {
    const pending = this.pending.get(sessionId)
    if (pending === undefined) return null
    return {
      question: pending.question,
      details: pending.details,
      multiSelect: pending.multiSelect,
      options: pending.options.map(option => ({ label: option.label, value: option.value, description: option.description })),
    }
  }

  /** Resolve the pending quiz for one session with the learner's picks. */
  private submitAnswer(sessionId: string, payload: unknown): { ok: true } {
    const pending = this.pending.get(sessionId)
    if (pending === undefined) throw new LearnApiError('not-found', 'no pending quiz for this session', 404)
    const record = payload as Record<string, unknown>
    const dontKnow = record.dontKnow === true
    const selectedValues = dontKnow ? [] : (Array.isArray(record.selectedValues) ? record.selectedValues.filter((v): v is string => typeof v === 'string') : [])
    this.pending.delete(sessionId)
    pending.resolve({ dontKnow, selectedValues })
    return { ok: true }
  }

  /** Send a free-text message into the session's main turn (the Learn tab's compact composer). */
  private send(sessionId: string, text: string): { ok: true } {
    if (text.trim() === '') throw new LearnApiError('bad-request', 'text must not be empty')
    const agent = this.requireAgent(sessionId)
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return { ok: true }
  }

  /** Cancel the session's active turn (the Learn tab's compact composer stop button). */
  private interrupt(sessionId: string): { ok: true } {
    const agent = this.requireAgent(sessionId)
    agent.cancel({ kind: 'user' })
    return { ok: true }
  }

  private loggedActive(session: Session): boolean {
    return this.unit.get(String(session.id))?.active ?? false
  }

  /** Select whether learn mode should be active for a session; kept in memory only (see {@link unit}). */
  private set(session: Session, active: boolean, topic?: string): void {
    this.unit.set(String(session.id), learnState(active, topic))
  }
}

export default LearnController
