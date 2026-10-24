import { describe, expect, it } from 'vitest'
import { learnState, runLearnCommand } from './index.ts'

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

describe('runLearnCommand', () => {
  /** A fake session target that records every switch and steer, in order. */
  function recorder(active = false) {
    const calls: string[] = []
    return {
      calls,
      active,
      set: (on: boolean, topic?: string) => { calls.push(topic === undefined ? `set ${on}` : `set ${on} ${topic}`) },
      steer: (text: string) => { calls.push(`steer ${text}`) },
    }
  }

  it('turns learn mode on, then sends the topic to the model so the lesson starts', () => {
    const target = recorder()
    runLearnCommand(' closures ', target)
    expect(target.calls).toEqual(['set true closures', 'steer closures'])
  })

  it('bare /learn and /learn off only flip the switch', () => {
    const on = recorder()
    runLearnCommand('', on)
    expect(on.calls).toEqual(['set true'])
    const off = recorder(true)
    expect(runLearnCommand('off', off).text).toBe('Learn mode off.')
    expect(off.calls).toEqual(['set false'])
  })
})
