import { describe, expect, it } from 'vitest'
import { learnState } from './index.ts'

describe('learnState', () => {
  it('omits topic when undefined', () => {
    const state = learnState(false, undefined)
    expect(state).toEqual({ active: false })
    // The `topic` key must be *absent*, not present-with-`undefined`: this state is
    // forwarded as a Cordis event argument to Remote clients, whose lossless-JSON
    // check (`isJsonValue`) rejects a present `undefined`-valued key even though
    // `toEqual`/`JSON.stringify` treat it the same as an absent one.
    expect(Object.keys(state)).not.toContain('topic')
  })

  it('carries the topic when active and given one', () => {
    const state = learnState(true, 'closures')
    expect(state).toEqual({ active: true, topic: 'closures' })
  })
})
