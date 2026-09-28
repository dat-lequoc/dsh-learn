/**
 * Typed fetch wrapper over the `/learn/api` JSON routes, mirroring
 * dsh-better-sidebar's own `src/client/api.ts` `call()` pattern (MIT-licensed,
 * same license as this package) so both plugins' Learn/Sidebar client code
 * reads the same way: POST to `/learn/api/<method>` with `{ sessionId, ... }`,
 * parse the shared `{ ok: true, value }` / `{ ok: false, error }` envelope.
 *
 * @module dsh-learn/client/api
 */
import type { TranscriptRow } from '../transcript.ts'

/** One wire failure from a `/learn/api` route. */
export class LearnApiClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new LearnApiClientError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/learn/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new LearnApiClientError('network', error instanceof Error ? error.message : String(error))
  }
  return readEnvelope<T>(response)
}

/** Learn mode state and agent status for the tab header and composer. */
export interface LearnStateView {
  active: boolean
  topic: string | undefined
  running: boolean
}

/** One learner-facing option of a pending quiz. */
export interface PendingQuizOption {
  label: string
  value: string
  description: string | undefined
}

/** The quiz currently waiting on the learner's pick, or `null` when none is pending. */
export interface PendingQuizView {
  question: string
  details: string | undefined
  multiSelect: boolean
  options: PendingQuizOption[]
}

/** The Learn `/learn/api` client surface (session id threaded through every call). */
export const learnApi = {
  state: (sessionId: string, signal?: AbortSignal) =>
    call<LearnStateView>('state', { sessionId }, signal),
  transcript: (sessionId: string, signal?: AbortSignal) =>
    call<{ rows: TranscriptRow[] }>('transcript', { sessionId }, signal),
  pendingQuiz: (sessionId: string, signal?: AbortSignal) =>
    call<PendingQuizView | null>('pending-quiz', { sessionId }, signal),
  submitAnswer: (sessionId: string, dontKnow: boolean, selectedValues: readonly string[]) =>
    call<{ ok: true }>('submit-answer', { sessionId, dontKnow, selectedValues }),
  send: (sessionId: string, text: string) =>
    call<{ ok: true }>('send', { sessionId, text }),
  interrupt: (sessionId: string) =>
    call<{ ok: true }>('interrupt', { sessionId }),
}
