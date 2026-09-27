/**
 * The Learn tab body: transcript (full markdown + mermaid fidelity), the
 * live quiz picker, a per-session note scratchpad, and a compact composer
 * (send/interrupt) so a learner never has to leave this tab to keep the
 * lesson moving — the whole point of a dedicated Learn tab instead of the
 * main chat composer popup.
 *
 * @module dsh-learn/client/LearnView
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionScope, TabComponentProps } from 'dsh-better-sidebar/client/service'
import { learnApi, LearnApiClientError, type PendingQuizOption, type PendingQuizView } from './api.ts'
import { usePolling } from './use-polling.ts'
import { MermaidMarkdown } from './mermaid.tsx'
import { TRANSCRIPT_MARKDOWN_LABELS } from './markdown-labels.tsx'
import type { TranscriptRow } from '../transcript.ts'

const STATE_POLL_MS = 2000
const TRANSCRIPT_POLL_MS = 2000
const NOTE_STORAGE_PREFIX = 'dsh-learn:note:'

/** One transcript row rendered through the shared markdown+mermaid pipeline. */
function TranscriptRowView({ row }: { row: TranscriptRow }): ReactNode {
  return (
    <div data-learn-row={row.role}>
      <div data-learn-row-label>{row.role === 'user' ? 'You' : row.role === 'assistant' ? 'Assistant' : 'Tool'}</div>
      <MermaidMarkdown text={row.text} labels={TRANSCRIPT_MARKDOWN_LABELS} />
    </div>
  )
}

/** The live quiz picker: clickable options (single or multi-select) plus "I don't know". */
function QuizPicker({ quiz, onSubmit }: { quiz: PendingQuizView; onSubmit: (dontKnow: boolean, values: string[]) => void }): ReactNode {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => { setSelected(new Set()) }, [quiz])

  const toggle = useCallback((value: string): void => {
    setSelected((previous) => {
      const next = new Set(quiz.multiSelect ? previous : [])
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [quiz.multiSelect])

  return (
    <div data-learn-quiz role="group" aria-label="Quiz">
      <div data-learn-quiz-question>{quiz.question}</div>
      {quiz.details !== undefined && quiz.details !== '' && <div data-learn-quiz-details>{quiz.details}</div>}
      <ul data-learn-quiz-options>
        {quiz.options.map((option: PendingQuizOption) => (
          <li key={option.value}>
            <button
              type="button"
              aria-pressed={selected.has(option.value)}
              onClick={() => toggle(option.value)}
            >
              {option.label}
              {option.description !== undefined && option.description !== '' && <span data-learn-quiz-option-desc>{option.description}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div data-learn-quiz-actions>
        <button type="button" disabled={selected.size === 0} onClick={() => onSubmit(false, [...selected])}>
          Submit
        </button>
        <button type="button" onClick={() => onSubmit(true, [])}>
          I don't know
        </button>
      </div>
    </div>
  )
}

/** Per-session scratch note, persisted to localStorage (no server round-trip needed for a private draft). */
function NoteField({ sessionId }: { sessionId: string }): ReactNode {
  const storageKey = `${NOTE_STORAGE_PREFIX}${sessionId}`
  const [note, setNote] = useState<string>(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    try {
      if (note === '') window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, note)
    } catch {
      // Storage may be unavailable (private mode, quota) — the note stays session-local only.
    }
  }, [note, storageKey])

  return (
    <div data-learn-note>
      <label htmlFor="dsh-learn-note-field">Notes</label>
      <textarea
        id="dsh-learn-note-field"
        value={note}
        onChange={event => setNote(event.target.value)}
        placeholder="Jot down anything worth remembering..."
        rows={4}
      />
    </div>
  )
}

/** Compact composer: send a follow-up or interrupt the running turn without leaving the Learn tab. */
function Composer({ scope, running, onSend, onInterrupt }: {
  scope: SessionScope
  running: boolean
  onSend: (text: string) => Promise<void>
  onInterrupt: () => Promise<void>
}): ReactNode {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '' || sending) return
    setSending(true)
    try {
      await onSend(trimmed)
      setText('')
    } finally {
      setSending(false)
    }
  }, [text, sending, onSend])

  return (
    <form
      data-learn-composer
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <textarea
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={running ? 'Steer the lesson...' : 'Ask a question...'}
        rows={2}
        aria-label="Message"
      />
      <div data-learn-composer-actions>
        <button type="submit" disabled={sending || text.trim() === ''}>
          {running ? 'Steer' : 'Send'}
        </button>
        <button type="button" disabled={!running} onClick={() => { void onInterrupt() }}>
          Stop
        </button>
      </div>
    </form>
  )
}

/** The Learn tab's root component. */
export function LearnView({ scope, visible }: TabComponentProps): ReactNode {
  const { sessionId } = scope
  const [active, setActive] = useState(false)
  const [topic, setTopic] = useState<string | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState<TranscriptRow[]>([])
  const [quiz, setQuiz] = useState<PendingQuizView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const pollState = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const [state, pending] = await Promise.all([
        learnApi.state(sessionId, signal),
        learnApi.pendingQuiz(sessionId, signal),
      ])
      setActive(state.active)
      setTopic(state.topic)
      setRunning(state.running)
      setQuiz(pending)
      setError(null)
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not reach the session.')
    }
  }, [sessionId])

  const pollTranscript = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const { rows: nextRows } = await learnApi.transcript(sessionId, signal)
      setRows(nextRows)
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      // The state poll already surfaces connectivity errors; stay quiet here.
    }
  }, [sessionId])

  usePolling(visible, pollState, { intervalMs: STATE_POLL_MS, immediate: true })
  usePolling(visible, pollTranscript, { intervalMs: TRANSCRIPT_POLL_MS, immediate: true })

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' })
  }, [rows])

  const submitAnswer = useCallback(async (dontKnow: boolean, values: string[]): Promise<void> => {
    try {
      await learnApi.submitAnswer(sessionId, dontKnow, values)
      setQuiz(null)
    } catch (reason) {
      setError(reason instanceof LearnApiClientError ? reason.message : 'Could not submit the answer.')
    }
  }, [sessionId])

  const send = useCallback(async (text: string): Promise<void> => {
    await learnApi.send(sessionId, text)
  }, [sessionId])

  const interrupt = useCallback(async (): Promise<void> => {
    await learnApi.interrupt(sessionId)
  }, [sessionId])

  if (!active) {
    return (
      <div data-learn-tab data-learn-inactive>
        <p>Guided learning mode is off for this session.</p>
        <p>Run <code>/learn</code> (optionally with a topic) in the chat to turn it on.</p>
      </div>
    )
  }

  return (
    <div data-learn-tab>
      <header data-learn-header>
        <span>Learning{topic !== undefined ? `: ${topic}` : ''}</span>
      </header>
      {error !== null && <div role="alert" data-learn-error>{error}</div>}
      <div data-learn-transcript>
        {rows.map(row => <TranscriptRowView key={row.seq} row={row} />)}
        <div ref={transcriptEndRef} />
      </div>
      {quiz !== null && <QuizPicker quiz={quiz} onSubmit={(dontKnow, values) => { void submitAnswer(dontKnow, values) }} />}
      <NoteField sessionId={sessionId} />
      <Composer scope={scope} running={running} onSend={send} onInterrupt={interrupt} />
    </div>
  )
}
