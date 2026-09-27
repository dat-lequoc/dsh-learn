import { describe, expect, it } from 'vitest'
import { isCorrectSelection, normalizeOptions, resolveCorrectIndices, shuffleOptions } from './quiz.ts'

describe('normalizeOptions', () => {
  it('trims labels and defaults value to the label', () => {
    const out = normalizeOptions([{ label: '  A  ' }, { label: 'B', value: 'b-val' }])
    expect(out).toEqual([
      { label: 'A', value: 'A', description: undefined },
      { label: 'B', value: 'b-val', description: undefined },
    ])
  })

  it('drops blank-label entries', () => {
    expect(normalizeOptions([{ label: '   ' }, { label: 'Keep' }])).toEqual([
      { label: 'Keep', value: 'Keep', description: undefined },
    ])
  })

  it('throws on a duplicate normalized value', () => {
    expect(() => normalizeOptions([{ label: 'A', value: 'x' }, { label: 'B', value: 'x' }]))
      .toThrow(/duplicate option value/)
  })
})

describe('shuffleOptions', () => {
  it('returns a same-length permutation without mutating the input', () => {
    const input = normalizeOptions([{ label: 'A' }, { label: 'B' }, { label: 'C' }])
    const out = shuffleOptions(input)
    expect(out).not.toBe(input)
    expect(out.length).toBe(input.length)
    expect([...out].sort((a, b) => a.value.localeCompare(b.value)))
      .toEqual([...input].sort((a, b) => a.value.localeCompare(b.value)))
  })
})

describe('resolveCorrectIndices', () => {
  const options = normalizeOptions([{ label: 'A' }, { label: 'B' }, { label: 'C' }])

  it('resolves a single value to its 1-based index', () => {
    expect(resolveCorrectIndices('B', options)).toEqual([2])
  })

  it('resolves multiple values, de-duplicated and sorted', () => {
    expect(resolveCorrectIndices(['C', 'A', 'A'], options)).toEqual([1, 3])
  })

  it('throws on an unknown value, listing known values', () => {
    expect(() => resolveCorrectIndices('nope', options)).toThrow(/does not match any option value/)
  })

  it('throws on an empty correctAnswer array', () => {
    expect(() => resolveCorrectIndices([], options)).toThrow(/required/)
  })
})

describe('isCorrectSelection', () => {
  it('matches regardless of order', () => {
    expect(isCorrectSelection([2, 1], [1, 2])).toBe(true)
  })

  it('rejects a superset', () => {
    expect(isCorrectSelection([1, 2, 3], [1, 2])).toBe(false)
  })

  it('rejects a subset', () => {
    expect(isCorrectSelection([1], [1, 2])).toBe(false)
  })

  it('rejects a same-size wrong set', () => {
    expect(isCorrectSelection([1, 3], [1, 2])).toBe(false)
  })
})
