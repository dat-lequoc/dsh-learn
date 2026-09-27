import { describe, expect, it } from 'vitest'
import { learnProjectionDefinition } from './index.ts'
import type { LearnUnitState } from './types.ts'

/** Minimal session event shape the projection's `apply` switches on. */
function event(type: string, data: unknown): { type: string; data: unknown } {
  return { type, data }
}

describe('learnProjectionDefinition', () => {
  it('starts inactive with no topic', () => {
    const state = learnProjectionDefinition.init()
    expect(state).toEqual({ active: false, topic: undefined })
    // The `topic` key must be *absent*, not present-with-`undefined`: this state is
    // forwarded as a Cordis event argument to Remote clients, whose lossless-JSON
    // check (`isJsonValue`) rejects a present `undefined`-valued key even though
    // `toEqual`/`JSON.stringify` treat it the same as an absent one.
    expect(Object.keys(state)).not.toContain('topic')
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
    expect(Object.keys(state)).not.toContain('topic')
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
