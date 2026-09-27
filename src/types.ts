/**
 * Shared learn-mode state shape, used by both the Host controller's
 * in-memory store and the Client's `/learn/api/state` view model.
 *
 * @module dsh-learn/types
 */

/** Whether guided learning mode is in force for a session, and its optional topic. In-memory only; see `LearnController.unit`. */
export interface LearnUnitState {
  readonly active: boolean
  /** Optional topic label the user gave `/learn <topic>`; carried for the prompt section and the Learn tab header. */
  readonly topic?: string
}
