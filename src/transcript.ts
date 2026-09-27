/**
 * Plain-text extraction of one session's transcript for the Learn tab: turns
 * `user/message` / `assistant/message` / `tool/call` / `tool/result` session
 * events into flat `{ role, text }` rows the Client renders through
 * MarkdownText. Read-only, completed-turns only (no live in-progress
 * streaming rows — the Learn tab polls after each turn settles, unlike
 * dsh-better-sidebar's Side Chat which also surfaces in-flight deltas).
 *
 * Text extraction mirrors dsh-better-sidebar's `src/sidechat-core.ts`
 * helpers (`messageTexts`/`toolResultText`/`resultBlocks`, MIT-licensed,
 * same license as this package) simplified for DSH 0.1.7-rc.1+ only (content
 * is always a block array — no legacy bare-string message fallback needed).
 *
 * @module dsh-learn/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { Message } from '@deepseek-ai/dsh-llm'

/** One flattened, renderable transcript row. */
export interface TranscriptRow {
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
}

/** Plain text of a message's `text`-type content blocks (reasoning/other block kinds are not shown). */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') parts.push(block.text)
  }
  return parts.join('')
}

const TOOL_RESULT_TEXT_CAP = 2000

/**
 * Flatten a session's raw event log into transcript rows. Tool calls and
 * their results are folded into one `tool` row per call (name, truncated
 * result). Events with no renderable text (e.g. an empty tool/call whose
 * arguments carry no text) are dropped.
 * @param events - the session's own events, in log order.
 * @returns rows in the same order, one per renderable event.
 */
export function transcriptRows(events: readonly SessionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const pendingCalls = new Map<string, { name: string; seq: number }>()
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = messageText(event.data)
      if (text !== '') rows.push({ seq: event.seq, role: 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      if (text !== '') rows.push({ seq: event.seq, role: 'assistant', text })
      continue
    }
    if (event.type === 'tool/call') {
      pendingCalls.set(event.data.callId, { name: event.data.name, seq: event.seq })
      continue
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.toolCallId
      const pending = pendingCalls.get(callId)
      pendingCalls.delete(callId)
      const name = pending?.name ?? 'tool'
      const failed = event.data.message.isError === true
      const result = messageText(event.data.message).slice(0, TOOL_RESULT_TEXT_CAP)
      const text = `\`${name}\`${failed ? ' (failed)' : ''}${result === '' ? '' : `\n\n${result}`}`
      rows.push({ seq: pending?.seq ?? event.seq, role: 'tool', text })
      continue
    }
  }
  return rows
}
