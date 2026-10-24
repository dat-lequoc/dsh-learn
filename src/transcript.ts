/**
 * The Learn tab's lesson view of one session: the learner's own messages, the
 * assistant's prose, and every quiz at the point in the conversation where it
 * was asked. Everything else is left out on purpose: tool plumbing (a
 * `run_code` program, a file read) and harness-injected context (workspace
 * instructions, runtime snapshots, skill catalogs) are how the lesson is
 * produced, not the lesson itself, and the main Chat view already shows them.
 *
 * A quiz reaches the log two ways: as a model-direct `quiz` tool call (native
 * presentation) or as a `tools.quiz(...)` sub-dispatch inside a `run_code`
 * program (PTC presentation). Both carry the same arguments and settle with
 * the same `render` text, so both fold into one quiz row.
 *
 * @module dsh-learn/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { Message } from '@deepseek-ai/dsh-llm'
import { normalizeOptions, resolveCorrectIndices, type QuizOption, type QuizOptionInput } from './quiz.ts'
import type { LearnUnitState } from './types.ts'

/** One option of a quiz, as the learner saw it. */
export interface QuizRowOption {
  readonly label: string
  readonly value: string
  readonly description?: string
}

/** How a quiz ended, parsed from the tool's rendered result text. */
export type QuizOutcome =
  | { readonly kind: 'answered'; readonly correct: boolean; readonly selected: readonly string[]; readonly correctValues: readonly string[] }
  | { readonly kind: 'dont-know'; readonly correctValues: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string }

/** One quiz, keyed by the tool call id that asked it. */
export interface QuizRow {
  readonly seq: number
  readonly role: 'quiz'
  readonly callId: string
  readonly question: string
  readonly details?: string
  readonly multiSelect: boolean
  readonly options: readonly QuizRowOption[]
  /** Absent while the learner has not answered yet. */
  readonly outcome?: QuizOutcome
  /** The model's explanation, revealed once the quiz is answered. */
  readonly explanation?: string
}

/** One lesson row: a message, or a quiz in its conversational position. */
export type TranscriptRow =
  | { readonly seq: number; readonly role: 'user' | 'assistant'; readonly text: string }
  | QuizRow

/** Text of the `{ type: 'text' }` blocks in an untyped content array (reasoning and other kinds are skipped). */
function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('')
}

/** A tool call's arguments as an object: native calls log a JSON string, PTC sub-dispatches an object. */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Build a quiz row from its call arguments; undefined when they are not a renderable quiz. */
function quizFromArguments(seq: number, callId: string, raw: unknown): QuizRow | undefined {
  const args = parseArguments(raw)
  if (args === undefined || typeof args.question !== 'string' || !Array.isArray(args.options)) return undefined
  const options: QuizRowOption[] = []
  for (const option of args.options) {
    if (typeof option !== 'object' || option === null) continue
    const { label, value, description } = option as { label?: unknown; value?: unknown; description?: unknown }
    if (typeof label !== 'string' || label.trim() === '') continue
    options.push({
      label: label.trim(),
      value: typeof value === 'string' && value.trim() !== '' ? value.trim() : label.trim(),
      ...typeof description === 'string' && description.trim() !== '' ? { description: description.trim() } : {},
    })
  }
  return {
    seq,
    role: 'quiz',
    callId,
    question: args.question,
    ...typeof args.details === 'string' && args.details.trim() !== '' ? { details: args.details } : {},
    multiSelect: args.multiSelect === true,
    options,
  }
}

/** Tool result of a posted quiz: it returns at once, so no run_code/tool deadline ever waits on the learner. */
export const QUIZ_POSTED_TEXT = 'Quiz shown to the learner in the Learn tab. Do not answer it yourself and do not continue the lesson: '
  + 'end your turn now with no further text. The learner\'s graded answer will arrive as their next message.'

/** What a graded quiz answer looks like to the model; also what {@link quizOutcome} parses back. */
export interface QuizGrade {
  readonly correct: boolean
  readonly dontKnow: boolean
  readonly selected: readonly string[]
  readonly correctValues: readonly string[]
  readonly explanation: string
}

/** The graded result as one line of prose (the model reads it; the Learn tab parses it). */
export function quizResultText(grade: QuizGrade): string {
  return grade.dontKnow
    ? `Learner answered "I don't know" (correct: ${grade.correctValues.join(', ')}). ${grade.explanation}`
    : `Learner answered ${grade.correct ? 'correctly' : 'incorrectly'} (picked: ${grade.selected.join(', ') || '(none)'}; correct: ${grade.correctValues.join(', ')}). ${grade.explanation}`
}

const ANSWER_MESSAGE = /^\[quiz-answer ([^\]\s]+)\]\n([\s\S]*)$/

/** The user message that delivers a graded answer back to the model. */
export function quizAnswerMessage(callId: string, grade: QuizGrade): string {
  return `[quiz-answer ${callId}]\n${quizResultText(grade)}`
}

const ANSWERED = /^Learner answered (correctly|incorrectly) \(picked: (.*?); correct: (.*?)\)\. ([\s\S]*)$/
// The `(correct: …)` part is absent in logs written before it was added.
const DONT_KNOW = /^Learner answered "I don't know"(?: \(correct: (.*?)\))?\. ([\s\S]*)$/

/** Split a rendered `a, b` value list back into values (`(none)` means no pick). */
function valueList(text: string): string[] {
  return text === '(none)' ? [] : text.split(', ').filter(value => value !== '')
}

/**
 * Parse how a quiz ended from its tool result. The text is the quiz tool's own
 * `render` output (see `src/index.ts`), so this package owns both ends of the
 * format.
 * @param text - the settled result text.
 * @param isError - whether the call failed (cancelled, timed out, rejected).
 */
export function quizOutcome(text: string, isError: boolean): { outcome: QuizOutcome; explanation?: string } {
  if (!isError) {
    const answered = ANSWERED.exec(text)
    if (answered !== null) {
      return {
        outcome: {
          kind: 'answered',
          correct: answered[1] === 'correctly',
          selected: valueList(answered[2] ?? ''),
          correctValues: valueList(answered[3] ?? ''),
        },
        explanation: answered[4] ?? '',
      }
    }
    const dontKnow = DONT_KNOW.exec(text)
    if (dontKnow !== null) {
      return { outcome: { kind: 'dont-know', correctValues: valueList(dontKnow[1] ?? '') }, explanation: dontKnow[2] ?? '' }
    }
  }
  return { outcome: { kind: 'failed', reason: (text.replace(/^Error:\s*/, '').split('\n')[0] ?? '').trim() } }
}

/** Untyped view of the PTC dispatch events (their payload types live in `@deepseek-ai/dsh-tools`). */
interface PtcDispatchData {
  readonly subCallId?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly content?: unknown
  readonly isError?: unknown
}

/**
 * Flatten a session's raw event log into lesson rows, in log order.
 * @param events - the session's own events.
 * @returns learner messages, assistant prose, and quizzes; nothing else.
 */
export function transcriptRows(events: readonly SessionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const quizIndex = new Map<string, number>()
  const addQuiz = (quiz: QuizRow | undefined): void => {
    if (quiz === undefined || quizIndex.has(quiz.callId)) return
    quizIndex.set(quiz.callId, rows.length)
    rows.push(quiz)
  }
  const settleQuiz = (callId: string, text: string, isError: boolean): void => {
    if (text === QUIZ_POSTED_TEXT) return
    const index = quizIndex.get(callId)
    if (index === undefined) return
    const quiz = rows[index]
    if (quiz?.role !== 'quiz' || quiz.outcome !== undefined) return
    const { outcome, explanation } = quizOutcome(text, isError)
    rows[index] = { ...quiz, outcome, ...explanation === undefined ? {} : { explanation } }
  }
  for (const event of events) {
    const type: string = event.type
    const data = event.data as Record<string, unknown>
    if (type === 'user/message') {
      // Only what the learner typed: harness-injected context (instructions,
      // runtime snapshots, skill catalogs) rides the same event type under
      // its own source kind.
      if ((data.source as { kind?: unknown } | undefined)?.kind !== 'user') continue
      const text = blocksText(data.content)
      // A quiz answer is delivered as a user message, but it belongs to its
      // quiz card, not to the conversation as a bubble.
      const answer = ANSWER_MESSAGE.exec(text)
      if (answer !== null) {
        settleQuiz(answer[1] ?? '', answer[2] ?? '', false)
        continue
      }
      if (text !== '') rows.push({ seq: event.seq, role: 'user', text })
    } else if (type === 'assistant/message') {
      const text = blocksText((data.message as { content?: unknown } | undefined)?.content)
      if (text !== '') rows.push({ seq: event.seq, role: 'assistant', text })
    } else if (type === 'tool/call') {
      if (data.name === 'quiz' && typeof data.callId === 'string') addQuiz(quizFromArguments(event.seq, data.callId, data.arguments))
    } else if (type === 'tool/result') {
      const message = data.message as { toolCallId?: unknown; content?: unknown; isError?: unknown } | undefined
      if (typeof message?.toolCallId === 'string') settleQuiz(message.toolCallId, blocksText(message.content), message.isError === true)
    } else if (type === 'tool/ptc-dispatch-start') {
      const ptc = data as PtcDispatchData
      if (ptc.name === 'quiz' && typeof ptc.subCallId === 'string') addQuiz(quizFromArguments(event.seq, ptc.subCallId, ptc.arguments))
    } else if (type === 'tool/ptc-dispatch') {
      const ptc = data as PtcDispatchData
      if (ptc.name === 'quiz' && typeof ptc.subCallId === 'string') settleQuiz(ptc.subCallId, blocksText(ptc.content), ptc.isError === true)
    }
  }
  return rows
}

/**
 * Derive a session's learn-mode state from its logged `/learn` command runs
 * and quiz tool calls, so learn mode and its topic survive host restarts and
 * plugin reloads without custom session event types.
 * @param events - the session's own events.
 * @returns the derived state, or `undefined` when the session never entered learn mode.
 */
export function deriveLearnState(events: readonly SessionEvent[]): LearnUnitState | undefined {
  let state: LearnUnitState | undefined
  for (const event of events) {
    const type: string = event.type
    const data = event.data as Record<string, unknown>
    if (type === 'command/run' && data.name === 'learn') {
      const arg = typeof data.args === 'string' ? data.args.trim() : ''
      if (arg === 'off') {
        state = { active: false }
      } else if (arg === '') {
        state = state?.topic !== undefined ? { active: true, topic: state.topic } : { active: true }
      } else {
        state = { active: true, topic: arg }
      }
    } else if ((type === 'tool/call' || type === 'tool/ptc-dispatch-start') && data.name === 'quiz') {
      if (state === undefined) state = { active: true }
    }
  }
  return state
}

/** Reconstructed pending-quiz record from an unanswered quiz call in the session log. */
export interface RecoveredPendingQuiz {
  readonly callId: string
  readonly options: readonly QuizOption[]
  readonly correctValues: readonly string[]
  readonly explanation: string
}

/**
 * Recover the latest unanswered quiz from a session's event log, so an open
 * quiz remains interactive and gradable across plugin reloads or host restarts.
 * @param events - the session's own events.
 * @returns the unanswered quiz's grading state, or `undefined` if none is waiting.
 */
export function recoverPendingQuiz(events: readonly SessionEvent[]): RecoveredPendingQuiz | undefined {
  let candidate: { callId: string; raw: unknown } | undefined
  for (const event of events) {
    const type: string = event.type
    const data = event.data as Record<string, unknown>
    if (type === 'tool/call' && data.name === 'quiz' && typeof data.callId === 'string') {
      candidate = { callId: data.callId, raw: data.arguments }
    } else if (type === 'tool/ptc-dispatch-start' && data.name === 'quiz' && typeof data.subCallId === 'string') {
      candidate = { callId: data.subCallId, raw: data.arguments }
    } else if (type === 'tool/result' && candidate !== undefined) {
      const message = data.message as { toolCallId?: unknown; content?: unknown } | undefined
      if (message?.toolCallId === candidate.callId && blocksText(message.content) !== QUIZ_POSTED_TEXT) {
        candidate = undefined
      }
    } else if (type === 'tool/ptc-dispatch' && candidate !== undefined) {
      const ptc = data as PtcDispatchData
      if (ptc.subCallId === candidate.callId && blocksText(ptc.content) !== QUIZ_POSTED_TEXT) {
        candidate = undefined
      }
    } else if (type === 'user/message' && candidate !== undefined) {
      if ((data.source as { kind?: unknown } | undefined)?.kind !== 'user') continue
      const answer = ANSWER_MESSAGE.exec(blocksText(data.content))
      if (answer !== null && answer[1] === candidate.callId) {
        candidate = undefined
      }
    }
  }
  if (candidate === undefined) return undefined
  const args = parseArguments(candidate.raw)
  if (args === undefined || !Array.isArray(args.options)) return undefined
  try {
    const rawOptions: QuizOptionInput[] = []
    for (const item of args.options) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as { label?: unknown; value?: unknown; description?: unknown }
      if (typeof rec.label !== 'string') continue
      rawOptions.push({
        label: rec.label,
        ...typeof rec.value === 'string' ? { value: rec.value } : {},
        ...typeof rec.description === 'string' ? { description: rec.description } : {},
      })
    }
    const options = normalizeOptions(rawOptions)
    if (options.length < 2) return undefined
    const rawCorrect = args.correctAnswer
    const correctInput = typeof rawCorrect === 'string'
      ? rawCorrect
      : Array.isArray(rawCorrect)
        ? rawCorrect.filter((v): v is string => typeof v === 'string')
        : []
    const correctIndices = resolveCorrectIndices(correctInput, options)
    const correctValues = correctIndices.map(index => options[index - 1]?.value ?? '').filter(v => v !== '')
    const explanation = typeof args.explanation === 'string' ? args.explanation : ''
    return {
      callId: candidate.callId,
      options,
      correctValues,
      explanation,
    }
  } catch {
    return undefined
  }
}
