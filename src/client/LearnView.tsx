/**
 * The Learn tab body: the lesson as one reading flow (the learner's messages,
 * the assistant's prose with full markdown + mermaid, and each quiz as a card
 * at the point in the conversation where it was asked). A pending quiz is
 * answered right in its card, and a learner can start or end a lesson directly
 * from this tab as well as via `/learn` in chat.
 *
 * @module dsh-learn/client/LearnView
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconSendOutlineRegular,
  IconStopFillRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import { learnApi, LearnApiClientError, type PendingQuizView } from './api.ts'
import { usePolling } from './use-polling.ts'
import { MermaidMarkdown } from './mermaid.tsx'
import { TRANSCRIPT_MARKDOWN_LABELS } from './markdown-labels.tsx'
import type { QuizRow, QuizRowOption, TranscriptRow } from '../transcript.ts'
import css from './LearnView.module.css'

const STATE_POLL_MS = 1000
const TRANSCRIPT_POLL_MS = 1000
const COMPOSER_MAX_HEIGHT = 132
/** How close to the bottom (px) still counts as "reading the latest", so new content follows. */
const FOLLOW_SLACK_PX = 48

const STARTER_TOPICS = [
  'How closures & lexical scope work',
  'TCP congestion control from scratch',
  'Bayes\' theorem & intuition',
  'Git rebase vs merge internals',
] as const

/** Option badge letter (A, B, C, ...). */
function optionLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26))
}

/** One message row: the learner's words as a bubble, the assistant's as full-width markdown. */
function MessageRow({ role, text }: { role: 'user' | 'assistant'; text: string }): ReactNode {
  return (
    <div className={role === 'user' ? css.rowUser : css.rowAssistant}>
      <MermaidMarkdown text={text} labels={TRANSCRIPT_MARKDOWN_LABELS} />
    </div>
  )
}

/** Short status line and badge metadata under an answered or ended quiz. */
function quizVerdict(quiz: QuizRow): { tone: 'correct' | 'wrong' | 'neutral'; badge: string; text: string } | undefined {
  const outcome = quiz.outcome
  if (outcome === undefined) return undefined
  if (outcome.kind === 'answered') {
    return outcome.correct
      ? { tone: 'correct', badge: 'Correct', text: 'You got it right' }
      : { tone: 'wrong', badge: 'Not quite', text: 'Your answer was not correct' }
  }
  if (outcome.kind === 'dont-know') {
    return { tone: 'neutral', badge: 'Skipped', text: 'You chose "I don\'t know"' }
  }
  return { tone: 'neutral', badge: 'Ended', text: 'This quiz ended before it was answered.' }
}

/**
 * One quiz card, in place in the lesson. Live when it is the quiz waiting on
 * the learner; otherwise read-only, marking the correct option and the
 * learner's pick once it has been answered.
 */
function QuizCard({ quiz, live, onSubmit }: {
  quiz: QuizRow
  /** Graded display order of the waiting quiz; undefined when this card is not answerable. */
  live: PendingQuizView | undefined
  onSubmit: (dontKnow: boolean, values: string[]) => Promise<void>
}): ReactNode {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const outcome = quiz.outcome
  // Keep the order the learner answered in: the logged arguments are
  // pre-shuffle, so without this the options would jump after Submit.
  const [shown, setShown] = useState<readonly QuizRowOption[] | undefined>(live?.options)
  useEffect(() => { if (live !== undefined) setShown(live.options) }, [live])
  const options: readonly QuizRowOption[] = live?.options ?? shown ?? quiz.options
  const correct = new Set(outcome !== undefined && outcome.kind !== 'failed' ? outcome.correctValues : [])
  const picked = new Set(outcome?.kind === 'answered' ? outcome.selected : [])
  const verdict = quizVerdict(quiz)

  const toggle = (value: string): void => {
    setSelected((previous) => {
      const next = new Set(quiz.multiSelect ? previous : [])
      if (previous.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const submit = async (dontKnow: boolean): Promise<void> => {
    if (sending) return
    setSending(true)
    try {
      await onSubmit(dontKnow, dontKnow ? [] : [...selected])
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={css.quiz} aria-label="Quiz">
      <div className={css.quizHeader}>
        <span className={css.quizEyebrow}>
          {quiz.multiSelect ? 'Quiz · Pick all that apply' : 'Quiz · Comprehension check'}
        </span>
        {live !== undefined && outcome === undefined && (
          <span className={css.quizBadgeLive}>Waiting for answer</span>
        )}
        {verdict !== undefined && (
          <span
            className={
              verdict.tone === 'correct'
                ? css.quizBadgeCorrect
                : verdict.tone === 'wrong'
                  ? css.quizBadgeWrong
                  : css.quizBadgeNeutral
            }
          >
            {verdict.badge}
          </span>
        )}
      </div>
      <div className={css.quizQuestion}>
        <MermaidMarkdown text={quiz.question} labels={TRANSCRIPT_MARKDOWN_LABELS} />
      </div>
      {quiz.details !== undefined && (
        <div className={css.quizDetails}>
          <MermaidMarkdown text={quiz.details} labels={TRANSCRIPT_MARKDOWN_LABELS} />
        </div>
      )}
      <ul className={css.quizOptions}>
        {options.map((option, index) => {
          const isSelected = outcome === undefined && selected.has(option.value)
          const isCorrect = correct.has(option.value)
          const isPicked = picked.has(option.value)
          const isWrongPick = isPicked && !isCorrect
          const marks = [
            isSelected ? css.optionSelected : '',
            isCorrect ? css.optionCorrect : '',
            isWrongPick ? css.optionWrong : '',
          ].filter(Boolean).join(' ')
          const indicatorText = isCorrect ? '✓' : isWrongPick ? '✗' : optionLetter(index)
          return (
            <li key={option.value}>
              <button
                type="button"
                className={`${css.quizOption} ${marks}`}
                aria-pressed={live === undefined ? undefined : selected.has(option.value)}
                disabled={live === undefined || sending}
                onClick={() => { toggle(option.value) }}
              >
                <span className={css.optionIndex} aria-hidden="true">
                  {indicatorText}
                </span>
                <span className={css.optionBody}>
                  <span className={css.optionTopRow}>
                    <span className={css.optionLabel}>
                      <MermaidMarkdown text={option.label} labels={TRANSCRIPT_MARKDOWN_LABELS} />
                    </span>
                    {(isCorrect || isPicked) && (
                      <span className={css.optionTags}>
                        {isCorrect && <span className={css.optionTagCorrect}>Correct answer</span>}
                        {isPicked && (
                          <span className={isCorrect ? css.optionTagPicked : css.optionTagWrong}>
                            Your answer
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  {option.description !== undefined && (
                    <span className={css.optionDesc}>
                      <MermaidMarkdown text={option.description} labels={TRANSCRIPT_MARKDOWN_LABELS} />
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {live !== undefined && (
        <div className={css.quizActions}>
          <Button variant="primary" size="sm" disabled={selected.size === 0 || sending} onClick={() => { void submit(false) }}>
            Submit answer
          </Button>
          <Button variant="outline" size="sm" disabled={sending} onClick={() => { void submit(true) }}>
            I don't know
          </Button>
        </div>
      )}
      {verdict !== undefined && (
        <div className={css.quizResult}>
          <div className={verdict.tone === 'correct' ? css.verdictCorrect : verdict.tone === 'wrong' ? css.verdictWrong : css.verdictNeutral}>
            {verdict.text}
          </div>
          {quiz.explanation !== undefined && quiz.explanation !== '' && (
            <div className={css.quizExplanation}>
              <MermaidMarkdown text={quiz.explanation} labels={TRANSCRIPT_MARKDOWN_LABELS} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Capsule steering composer that mirrors dsh-better-sidebar's Side Chat input.
 * Enter sends; Shift+Enter inserts a newline.
 */
function Composer({ running, hasPendingQuiz, onSend, onInterrupt }: {
  running: boolean
  hasPendingQuiz: boolean
  onSend: (text: string) => Promise<void>
  onInterrupt: () => Promise<void>
}): ReactNode {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const grow = (): void => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '' || busy) return
    setBusy(true)
    try {
      await onSend(trimmed)
      setText('')
      if (textareaRef.current !== null) textareaRef.current.style.height = ''
    } catch {
      // The parent keeps the API error visible above the lesson.
    } finally {
      setBusy(false)
    }
  }, [text, busy, onSend])

  const stop = useCallback(async (): Promise<void> => {
    if (!running || busy) return
    setBusy(true)
    try {
      await onInterrupt()
    } catch {
      // The parent keeps the API error visible above the lesson.
    } finally {
      setBusy(false)
    }
  }, [busy, onInterrupt, running])

  const placeholder = running
    ? 'Steer the lesson…'
    : hasPendingQuiz
      ? 'Ask a clarifying question or pick an option above…'
      : 'Ask a question or guide the next step…'

  return (
    <form
      className={css.composer}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <textarea
        ref={textareaRef}
        className={css.composerInput}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          grow()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        rows={1}
        aria-label="Message"
        enterKeyHint="send"
        disabled={busy}
      />
      <div className={css.composerBar}>
        <span className={css.composerHint}>
          {running ? 'Generating lesson…' : 'Enter to send · Shift+Enter for newline'}
        </span>
        {running && text.trim() === '' ? (
          <button
            key="stop"
            type="button"
            className={css.composerSendBtn}
            disabled={busy}
            onClick={() => { void stop() }}
            title="Stop generating"
            aria-label="Stop"
          >
            <IconStopFillRegular />
          </button>
        ) : (
          <button
            key="send"
            type="submit"
            className={css.composerSendBtn}
            disabled={busy || text.trim() === ''}
            title={running ? 'Steer lesson' : 'Send message'}
            aria-label={running ? 'Steer' : 'Send'}
          >
            <IconSendOutlineRegular size={16} />
          </button>
        )}
      </div>
    </form>
  )
}

/** Inactive hero view: lets the learner start a lesson with a topic or enable learn mode in one click. */
function InactiveHero({ hasMessages, error, onStart }: {
  hasMessages: boolean
  error: string | null
  onStart: (topic?: string) => Promise<void>
}): ReactNode {
  const [draftTopic, setDraftTopic] = useState('')
  const [busy, setBusy] = useState(false)

  const handleStart = async (topic?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onStart(topic)
    } catch {
      // surfaced via error prop
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.inactive}>
      <div className={css.heroCard}>
        <div className={css.heroBadge} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 2L1.25 5.5L8 9L13.5 6.15V10.5H14.75V5.5L8 2Z" fill="currentColor" />
            <path d="M3.75 7.9V11.1C3.75 12.35 5.65 13.5 8 13.5C10.35 13.5 12.25 12.35 12.25 11.1V7.9L8 10.1L3.75 7.9Z" fill="currentColor" fillOpacity="0.82" />
          </svg>
        </div>
        <h2 className={css.heroTitle}>Guided Learning</h2>
        <p className={css.heroDesc}>
          Learn one concept node at a time from first principles, with interactive graded quizzes inline.
        </p>
        <form
          className={css.heroForm}
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = draftTopic.trim()
            if (trimmed !== '') void handleStart(trimmed)
          }}
        >
          <input
            type="text"
            className={css.heroInput}
            value={draftTopic}
            onChange={event => setDraftTopic(event.target.value)}
            placeholder="What do you want to learn?"
            aria-label="Lesson topic"
            disabled={busy}
          />
          <Button type="submit" variant="primary" size="sm" disabled={busy || draftTopic.trim() === ''}>
            Start lesson
          </Button>
        </form>
        <div className={css.heroSuggestions}>
          <span className={css.heroSuggestionsLabel}>Try a topic:</span>
          <div className={css.heroChips}>
            {STARTER_TOPICS.map(item => (
              <button
                key={item}
                type="button"
                className={css.heroChip}
                disabled={busy}
                onClick={() => {
                  setDraftTopic(item)
                  void handleStart(item)
                }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        {hasMessages && (
          <div className={css.heroSecondary}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { void handleStart(undefined) }}
            >
              Turn on for current chat
            </Button>
          </div>
        )}
        {error !== null && <div role="alert" className={css.error}>{error}</div>}
        <p className={css.heroFootnote}>
          You can also type <code>/learn &lt;topic&gt;</code> or <code>/learn off</code> in the main chat.
        </p>
      </div>
    </div>
  )
}

/** Two row lists render the same lesson (the transcript poll returns a fresh array every tick). */
function sameRows(a: readonly TranscriptRow[], b: readonly TranscriptRow[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

/** The Learn tab's root component. */
export function LearnView({ scope, visible }: TabComponentProps): ReactNode {
  const { sessionId } = scope
  const [active, setActive] = useState(false)
  const [topic, setTopic] = useState<string | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState<readonly TranscriptRow[]>([])
  const [streamingText, setStreamingText] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<PendingQuizView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow new content only while the learner is already at the bottom:
  // scrolling up to re-read must never be yanked back down by a poll.
  const followRef = useRef(true)

  const pollState = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const [state, waiting] = await Promise.all([
        learnApi.state(sessionId, signal),
        learnApi.pendingQuiz(sessionId, signal),
      ])
      if (signal.aborted) return
      setActive(state.active)
      setTopic(state.topic)
      setRunning(state.running)
      setPending(previous => (JSON.stringify(previous) === JSON.stringify(waiting) ? previous : waiting))
      setError(null)
    } catch (reason) {
      if (signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not reach the session.')
    }
  }, [sessionId])

  const pollTranscript = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const { rows: next, streamingText: nextStream } = await learnApi.transcript(sessionId, signal)
      if (signal.aborted) return
      // Keep the old array when nothing changed, so an idle lesson renders
      // (and scrolls) nothing on each poll.
      setRows(previous => (sameRows(previous, next) ? previous : next))
      setStreamingText(nextStream)
    } catch {
      // The state poll already surfaces connectivity errors; stay quiet here.
    }
  }, [sessionId])

  const refreshNow = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    await Promise.all([
      pollState(controller.signal),
      pollTranscript(controller.signal),
    ])
  }, [pollState, pollTranscript])

  usePolling(visible, pollState, { intervalMs: STATE_POLL_MS, immediate: true, mode: 'self-scheduling' })
  usePolling(visible, pollTranscript, { intervalMs: TRANSCRIPT_POLL_MS, immediate: true, mode: 'self-scheduling' })

  // A different session starts at its latest content.
  useEffect(() => { followRef.current = true }, [sessionId])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller !== null && followRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [rows.length, pending?.callId, streamingText])

  const onScroll = (): void => {
    const scroller = scrollRef.current
    if (scroller === null) return
    followRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK_PX
  }

  const submitAnswer = useCallback(async (dontKnow: boolean, values: string[]): Promise<void> => {
    if (pending === null) return
    try {
      await learnApi.submitAnswer(sessionId, pending.callId, dontKnow, values)
      setPending(null)
      setError(null)
      followRef.current = true
      await refreshNow()
    } catch (reason) {
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not submit the answer.')
    }
  }, [sessionId, pending, refreshNow])

  const startLesson = useCallback(async (nextTopic?: string): Promise<void> => {
    try {
      await learnApi.toggle(sessionId, true, nextTopic)
      setError(null)
      followRef.current = true
      await refreshNow()
    } catch (reason) {
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not start learn mode.')
      throw reason
    }
  }, [sessionId, refreshNow])

  const stopLesson = useCallback(async (): Promise<void> => {
    try {
      await learnApi.toggle(sessionId, false)
      setError(null)
      await refreshNow()
    } catch (reason) {
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not leave learn mode.')
    }
  }, [sessionId, refreshNow])

  const send = useCallback(async (text: string): Promise<void> => {
    try {
      await learnApi.send(sessionId, text)
      setError(null)
      followRef.current = true
      await refreshNow()
    } catch (reason) {
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not send the message.')
      throw reason
    }
  }, [sessionId, refreshNow])

  const interrupt = useCallback(async (): Promise<void> => {
    try {
      await learnApi.interrupt(sessionId)
      setError(null)
      await refreshNow()
    } catch (reason) {
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not stop the lesson.')
      throw reason
    }
  }, [sessionId, refreshNow])

  const quizStats = useMemo(() => {
    let total = 0
    let answered = 0
    let correct = 0
    for (const row of rows) {
      if (row.role !== 'quiz') continue
      total += 1
      if (row.outcome !== undefined && row.outcome.kind !== 'failed') {
        answered += 1
        if (row.outcome.kind === 'answered' && row.outcome.correct) correct += 1
      }
    }
    return { total, answered, correct }
  }, [rows])

  const lastRow = rows[rows.length - 1]
  const showStreamingRow = streamingText !== undefined
    && streamingText.trim() !== ''
    && !(lastRow?.role === 'assistant' && lastRow.text === streamingText)

  if (!active) {
    return (
      <InactiveHero
        hasMessages={rows.length > 0}
        error={error}
        onStart={startLesson}
      />
    )
  }

  return (
    <div className={css.tab}>
      <header className={css.header}>
        {running ? (
          <StateDot state="ongoing" size={8} />
        ) : (
          <span className={css.headerActiveDot} aria-hidden="true" />
        )}
        <span className={css.headerTitle} title={topic ?? 'Guided learning'}>
          {topic ?? 'Guided learning'}
        </span>
        <span className={css.headerSpacer} />
        {pending !== null ? (
          <span className={css.headerPillAccent}>Quiz waiting</span>
        ) : quizStats.answered > 0 ? (
          <span className={css.headerPill}>
            {quizStats.correct}/{quizStats.answered} correct
          </span>
        ) : null}
        <button
          type="button"
          className={css.headerEndBtn}
          onClick={() => { void stopLesson() }}
          title="Leave guided learning mode (/learn off)"
        >
          End lesson
        </button>
      </header>
      <div className={css.lesson} ref={scrollRef} onScroll={onScroll}>
        {rows.length === 0 && !running && !showStreamingRow && (
          <div className={css.emptyLesson}>
            Guided learning is on. Ask what you would like to learn below to start the first concept.
          </div>
        )}
        {rows.map(row => (row.role === 'quiz'
          ? (
            <QuizCard
              key={row.callId}
              quiz={row}
              live={pending !== null && pending.callId === row.callId && row.outcome === undefined ? pending : undefined}
              onSubmit={submitAnswer}
            />
          )
          : <MessageRow key={row.seq} role={row.role} text={row.text} />))}
        {showStreamingRow && <MessageRow role="assistant" text={streamingText} />}
        {running && pending === null && (
          <div className={css.thinking} aria-live="polite">
            <StateDot state="ongoing" size={8} />
            <span className={css.thinkingText}>Thinking…</span>
          </div>
        )}
      </div>
      {error !== null && <div role="alert" className={css.error}>{error}</div>}
      <Composer
        running={running}
        hasPendingQuiz={pending !== null}
        onSend={send}
        onInterrupt={interrupt}
      />
    </div>
  )
}
