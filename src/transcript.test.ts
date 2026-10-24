import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  deriveLearnState,
  QUIZ_POSTED_TEXT,
  quizAnswerMessage,
  quizOutcome,
  recoverPendingQuiz,
  transcriptRows,
} from './transcript.ts'

function ev(partial: object): SessionEvent {
  return partial as unknown as SessionEvent
}

function userMsg(seq: number, text: string, kind = 'user'): SessionEvent {
  return ev({ type: 'user/message', seq, data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } })
}

function assistantMsg(seq: number, text: string): SessionEvent {
  return ev({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } })
}

const QUIZ_ARGS = {
  question: 'What must a list be for binary search?',
  details: 'Answer by instinct.',
  options: [{ label: 'Sorted', value: 'sorted', description: 'Ascending order' }, { label: 'Odd length' }],
  correctAnswer: 'sorted',
  explanation: 'secret until answered',
}

describe('transcriptRows', () => {
  it('keeps only what the learner typed and the assistant prose', () => {
    const rows = transcriptRows([
      userMsg(0, 'Explain closures'),
      userMsg(1, '<system-reminder>workspace instructions</system-reminder>', 'agent-instructions'),
      userMsg(2, 'Current runtime context...', 'runtime-context'),
      assistantMsg(3, 'A closure is...'),
    ])
    expect(rows).toEqual([
      { seq: 0, role: 'user', text: 'Explain closures' },
      { seq: 3, role: 'assistant', text: 'A closure is...' },
    ])
  })

  it('drops tool plumbing entirely', () => {
    const rows = transcriptRows([
      ev({ type: 'tool/call', seq: 0, data: { callId: 'c1', name: 'run_code', arguments: '{"code":"..."}' } }),
      ev({ type: 'tool/result', seq: 1, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'diff output' }] } } }),
    ])
    expect(rows).toEqual([])
  })

  it('shows a pending native quiz in place, without its answer or explanation', () => {
    const rows = transcriptRows([
      assistantMsg(0, 'Quick check:'),
      ev({ type: 'tool/call', seq: 1, data: { callId: 'q1', name: 'quiz', arguments: JSON.stringify(QUIZ_ARGS) } }),
    ])
    expect(rows[1]).toEqual({
      seq: 1,
      role: 'quiz',
      callId: 'q1',
      question: QUIZ_ARGS.question,
      details: 'Answer by instinct.',
      multiSelect: false,
      options: [{ label: 'Sorted', value: 'sorted', description: 'Ascending order' }, { label: 'Odd length', value: 'Odd length' }],
    })
    expect(JSON.stringify(rows)).not.toContain('secret until answered')
  })

  it('folds a quiz asked from inside run_code (PTC) and its answer', () => {
    const rows = transcriptRows([
      ev({ type: 'tool/call', seq: 0, data: { callId: 'rc', name: 'run_code', arguments: '{}' } }),
      ev({ type: 'tool/ptc-dispatch-start', seq: 1, data: { subCallId: 'rc:ptc:1', name: 'quiz', arguments: QUIZ_ARGS } }),
      ev({
        type: 'tool/ptc-dispatch',
        seq: 2,
        data: {
          subCallId: 'rc:ptc:1',
          name: 'quiz',
          isError: false,
          content: [{ type: 'text', text: 'Learner answered incorrectly (picked: Odd length; correct: sorted). Halving needs order.' }],
        },
      }),
      ev({ type: 'tool/result', seq: 3, data: { message: { toolCallId: 'rc', content: [{ type: 'text', text: '{}' }] } } }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      role: 'quiz',
      callId: 'rc:ptc:1',
      outcome: { kind: 'answered', correct: false, selected: ['Odd length'], correctValues: ['sorted'] },
      explanation: 'Halving needs order.',
    })
  })

  it('keeps a posted PTC quiz pending until the learner answers', () => {
    const rows = transcriptRows([
      ev({ type: 'tool/ptc-dispatch-start', seq: 1, data: { subCallId: 'run:quiz:1', name: 'quiz', arguments: QUIZ_ARGS } }),
      ev({
        type: 'tool/ptc-dispatch',
        seq: 2,
        data: { subCallId: 'run:quiz:1', name: 'quiz', isError: false, content: [{ type: 'text', text: QUIZ_POSTED_TEXT }] },
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'quiz', callId: 'run:quiz:1' })
    expect(rows[0]).not.toHaveProperty('outcome')
  })

  it('marks a quiz that was cancelled or timed out as failed', () => {
    const rows = transcriptRows([
      ev({ type: 'tool/call', seq: 0, data: { callId: 'q1', name: 'quiz', arguments: JSON.stringify(QUIZ_ARGS) } }),
      ev({ type: 'tool/result', seq: 1, data: { message: { toolCallId: 'q1', isError: true, content: [{ type: 'text', text: 'Error: quiz was cancelled' }] } } }),
    ])
    expect(rows[0]).toMatchObject({ role: 'quiz', outcome: { kind: 'failed', reason: 'quiz was cancelled' } })
  })
})

describe('quizOutcome', () => {
  it('parses a correct multi-select answer', () => {
    expect(quizOutcome('Learner answered correctly (picked: a, b; correct: a, b). Both hold.', false)).toEqual({
      outcome: { kind: 'answered', correct: true, selected: ['a', 'b'], correctValues: ['a', 'b'] },
      explanation: 'Both hold.',
    })
  })

  it('parses an "I don\'t know" answer, with or without the correct values', () => {
    expect(quizOutcome('Learner answered "I don\'t know" (correct: b). Here is why.', false)).toEqual({
      outcome: { kind: 'dont-know', correctValues: ['b'] },
      explanation: 'Here is why.',
    })
    expect(quizOutcome('Learner answered "I don\'t know". Older log.', false).outcome)
      .toEqual({ kind: 'dont-know', correctValues: [] })
  })

  it('settles a posted quiz from the learner answer message, without a bubble', () => {
    const rows = transcriptRows([
      ev({ type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'quiz', arguments: JSON.stringify(QUIZ_ARGS) } }),
      ev({ type: 'tool/result', seq: 2, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: QUIZ_POSTED_TEXT }] } } }),
      userMsg(3, quizAnswerMessage('c1', { correct: true, dontKnow: false, selected: ['sorted'], correctValues: ['sorted'], explanation: 'because' })),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'quiz', callId: 'c1', explanation: 'because', outcome: { kind: 'answered', correct: true } })
  })
})

describe('deriveLearnState & recoverPendingQuiz', () => {
  it('derives active state and topic from logged /learn commands', () => {
    const events = [
      ev({ type: 'command/run', seq: 1, data: { commandId: 'cmd1', name: 'learn', args: ' closures ', source: { kind: 'user' } } }),
    ]
    expect(deriveLearnState(events)).toEqual({ active: true, topic: 'closures' })
    const afterOff = [
      ...events,
      ev({ type: 'command/run', seq: 2, data: { commandId: 'cmd2', name: 'learn', args: 'off', source: { kind: 'user' } } }),
    ]
    expect(deriveLearnState(afterOff)).toEqual({ active: false })
  })

  it('recovers an unanswered quiz from the log and clears it once answered', () => {
    const unanswered = [
      ev({ type: 'tool/call', seq: 1, data: { callId: 'q1', name: 'quiz', arguments: JSON.stringify(QUIZ_ARGS) } }),
      ev({ type: 'tool/result', seq: 2, data: { message: { toolCallId: 'q1', content: [{ type: 'text', text: QUIZ_POSTED_TEXT }] } } }),
    ]
    expect(recoverPendingQuiz(unanswered)).toEqual({
      callId: 'q1',
      options: [
        { label: 'Sorted', value: 'sorted', description: 'Ascending order' },
        { label: 'Odd length', value: 'Odd length', description: undefined },
      ],
      correctValues: ['sorted'],
      explanation: 'secret until answered',
    })
    const answered = [
      ...unanswered,
      userMsg(3, quizAnswerMessage('q1', { correct: true, dontKnow: false, selected: ['sorted'], correctValues: ['sorted'], explanation: 'secret until answered' })),
    ]
    expect(recoverPendingQuiz(answered)).toBeUndefined()
  })
})
