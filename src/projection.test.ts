import { describe, expect, it } from 'vitest'
import { learnProjectionDefinition } from './index.ts'
import type { LearnUnitState } from './types.ts'

/** Minimal session event shape the projection's `apply` switches on. */
function event(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data }
}

describe('learnProjectionDefinition', () => {
  it('starts inactive with no topic', () => {
    expect(learnProjectionDefinition.init()).toEqual({ active: false, topic: undefined })
  })

  it('turns on and carries the topic', () => {
    const state = learnProjectionDefinition.apply(
      learnProjectionDefinition.init(),
      event('learn/mode', { active: true, topic: 'closures' }) as never,
    )
    expect(state).toEqual({ active: true, topic: 'closures' })
  })

  it('turning off clears the topic even if one was supplied', () => {
    const active: LearnUnitState = { active: true, topic: 'closures' }
    const state = learnProjectionDefinition.apply(active, event('learn/mode', { active: false }) as never)
    expect(state).toEqual({ active: false, topic: undefined })
  })

  it('ignores unrelated event types (same-reference passthrough)', () => {
    const active: LearnUnitState = { active: true, topic: 'closures' }
    const state = learnProjectionDefinition.apply(active, event('assistant/message', {}) as never)
    expect(state).toBe(active)
  })

  it('view mirrors state 1:1', () => {
    const state: LearnUnitState = { active: true, topic: 'closures' }
    expect(learnProjectionDefinition.wire.view(state)).toEqual({ active: true, topic: 'closures' })
  })
})
