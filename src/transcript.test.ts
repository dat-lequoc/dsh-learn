import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { transcriptRows } from './transcript.ts'

function ev(partial: object): SessionEvent {
  return partial as unknown as SessionEvent
}

function userMsg(seq: number, text: string): SessionEvent {
  return ev({ type: 'user/message', seq, data: { content: [{ type: 'text', text }] } })
}

function assistantMsg(seq: number, text: string): SessionEvent {
  return ev({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } })
}

describe('transcriptRows', () => {
  it('extracts user and assistant text rows in order', () => {
    const rows = transcriptRows([userMsg(0, 'Explain closures'), assistantMsg(1, 'A closure is...')])
    expect(rows).toEqual([
      { seq: 0, role: 'user', text: 'Explain closures' },
      { seq: 1, role: 'assistant', text: 'A closure is...' },
    ])
  })

  it('drops messages with no text content', () => {
    const rows = transcriptRows([ev({ type: 'user/message', seq: 0, data: { content: [] } })])
    expect(rows).toEqual([])
  })

  it('joins multiple text blocks with no separator', () => {
    const event = ev({
      type: 'assistant/message',
      seq: 0,
      data: { message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] } },
    })
    expect(transcriptRows([event])).toEqual([{ seq: 0, role: 'assistant', text: 'Hello world' }])
  })

  it('folds a tool/call + tool/result pair into one row keyed at the call seq', () => {
    const call = ev({ type: 'tool/call', seq: 5, data: { callId: 'c1', name: 'web_search', arguments: '{}' } })
    const result = ev({
      type: 'tool/result',
      seq: 6,
      data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'top result' }] } },
    })
    expect(transcriptRows([call, result])).toEqual([
      { seq: 5, role: 'tool', text: '`web_search`\n\ntop result' },
    ])
  })

  it('marks a failed tool result', () => {
    const call = ev({ type: 'tool/call', seq: 0, data: { callId: 'c1', name: 'bash' } })
    const result = ev({
      type: 'tool/result',
      seq: 1,
      data: { message: { toolCallId: 'c1', content: [], isError: true } },
    })
    expect(transcriptRows([call, result])).toEqual([{ seq: 0, role: 'tool', text: '`bash` (failed)' }])
  })

  it('falls back to a generic tool name when the call was never seen', () => {
    const result = ev({
      type: 'tool/result',
      seq: 0,
      data: { message: { toolCallId: 'unknown', content: [{ type: 'text', text: 'x' }] } },
    })
    expect(transcriptRows([result])).toEqual([{ seq: 0, role: 'tool', text: '`tool`\n\nx' }])
  })

  it('truncates a very long tool result', () => {
    const long = 'x'.repeat(3000)
    const call = ev({ type: 'tool/call', seq: 0, data: { callId: 'c1', name: 'bash' } })
    const result = ev({
      type: 'tool/result',
      seq: 1,
      data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: long }] } },
    })
    const rows = transcriptRows([call, result])
    expect(rows[0]?.text.length).toBeLessThan(long.length)
  })
})
