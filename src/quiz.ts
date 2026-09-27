/**
 * Grading logic for the `quiz` tool: a graded sibling of ask_user_question.
 * Ported from pi-learn's `learn/extensions/quiz.ts` (options-only, single or
 * multi-select, correctness keyed by option `value` rather than position so
 * shuffling never desyncs grading). The always-present "I don't know" choice
 * is not a real option: it produces a distinct signal instead of a wrong grade.
 *
 * @module dsh-learn/quiz
 */

/** One author-declared answer option. */
export interface QuizOption {
  readonly label: string
  readonly value: string
  readonly description?: string
}

/** Sentinel value for the always-present "I don't know" choice; never a real option. */
export const DONT_KNOW_VALUE = '__dont_know__'

/** Author-facing option input before normalization. */
export interface QuizOptionInput {
  readonly label: string
  readonly value?: string
  readonly description?: string
}

/**
 * Normalize author-supplied options: trim, default `value` to the label, and
 * reject duplicate values (an ambiguous `correctAnswer` reference).
 * @param options - raw author input.
 * @returns normalized options in author order (shuffle separately).
 * @throws {Error} on a duplicate normalized `value`.
 */
export function normalizeOptions(options: readonly QuizOptionInput[]): QuizOption[] {
  const seen = new Set<string>()
  const out: QuizOption[] = []
  for (const option of options) {
    const label = option.label.trim()
    if (label === '') continue
    const value = (option.value ?? option.label).trim() || label
    if (seen.has(value)) throw new Error(`duplicate option value ${JSON.stringify(value)}`)
    seen.add(value)
    const description = option.description?.trim()
    out.push({ label, value, description: description === '' ? undefined : description })
  }
  return out
}

/**
 * Fisher-Yates shuffle over a copy. Safe to reorder for display because
 * correctness is resolved by `value`, never by position.
 * @param options - options to shuffle.
 * @returns a new shuffled array; the input is untouched.
 */
export function shuffleOptions(options: readonly QuizOption[]): QuizOption[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i]
    const b = out[j]
    if (a !== undefined && b !== undefined) { out[i] = b; out[j] = a }
  }
  return out
}

/**
 * Resolve one or more author-supplied `correctAnswer` value(s) against
 * displayed options.
 * @param correctAnswer - one value, or several for multi-select.
 * @param options - the options as displayed (post-shuffle), in display order.
 * @returns 1-based display indices of the correct option(s), de-duplicated and sorted.
 * @throws {Error} when a value does not match any displayed option.
 */
export function resolveCorrectIndices(
  correctAnswer: string | readonly string[],
  options: readonly QuizOption[],
): number[] {
  const values = Array.isArray(correctAnswer) ? correctAnswer : [correctAnswer]
  if (values.length === 0) throw new Error('correctAnswer is required')
  const byValue = new Map(options.map((option, index) => [option.value, index + 1]))
  const indices: number[] = []
  for (const raw of values) {
    const value = raw.trim()
    const index = byValue.get(value)
    if (index === undefined) {
      const known = options.map(option => JSON.stringify(option.value)).join(', ')
      throw new Error(`correctAnswer ${JSON.stringify(value)} does not match any option value (${known})`)
    }
    indices.push(index)
  }
  return [...new Set(indices)].sort((a, b) => a - b)
}

/**
 * Whether a set of selected 1-based indices exactly matches the correct set
 * (order-independent, size-sensitive: a superset or subset is wrong).
 * @param selected - 1-based indices the user picked.
 * @param correct - 1-based indices of the correct option(s).
 */
export function isCorrectSelection(selected: readonly number[], correct: readonly number[]): boolean {
  if (selected.length !== correct.length) return false
  const a = [...selected].sort((x, y) => x - y)
  const b = [...correct].sort((x, y) => x - y)
  return a.every((value, index) => value === b[index])
}
