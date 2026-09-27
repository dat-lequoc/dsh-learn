/**
 * Session-log vocabulary and projection state for dsh-learn, shared with
 * type-only consumers (the Client half imports only these types).
 *
 * @module dsh-learn/types
 */

/** Whether guided learning mode is in force from this point on: log-only, non-surface, whole-value replace. */
export interface LearnUnitState {
  readonly active: boolean
  /** Optional topic label the user gave `/learn <topic>`; carried for the prompt section and the Learn tab header. */
  readonly topic?: string
}

/** Client-visible view of {@link LearnUnitState} (identical shape; kept distinct so the wire contract can diverge later). */
export interface LearnProjection {
  readonly active: boolean
  readonly topic?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    learn: LearnUnitState
  }
  interface SessionProjectionMap {
    learn: LearnProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whether learn mode is active for this session from this point on, and its optional topic. */
    'learn/mode': { active: boolean; topic?: string }
  }
}
