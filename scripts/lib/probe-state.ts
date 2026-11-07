// The external probe's alerting rule (scripts/probe.ts), kept free of Node
// imports so the workerd test suite can drive it.
//
// One run fetches each target twice. The 2026-11-07 hangs hit about one page
// request in eight, so a single sample per minute would miss them most of the
// time; six requests a run catch a rate like that in about half the runs.
// Down needs 2 failing runs out of the last 3, so one slow request on a
// healthy site never pages anyone; up needs 3 clean runs in a row, so a
// flapping site produces one "down" and one "up", not a stream of both.

export const WINDOW = 3
export const DOWN_AFTER = 2
export const UP_AFTER = 3

export interface ProbeState {
  /** Newest last: true = every request in that run passed. */
  recent: boolean[]
  down: boolean
  /** ISO time the current outage was declared, for the recovery email. */
  since: string | null
}

export const INITIAL_STATE: ProbeState = { recent: [], down: false, since: null }

export type Transition = 'went-down' | 'came-up' | null

export function step(
  state: ProbeState,
  runOk: boolean,
  nowIso: string,
): { state: ProbeState; transition: Transition } {
  const recent = [...state.recent, runOk].slice(-Math.max(WINDOW, UP_AFTER))
  const window = recent.slice(-WINDOW)
  const failures = window.filter((ok) => !ok).length

  if (!state.down && failures >= DOWN_AFTER) {
    return { state: { recent, down: true, since: nowIso }, transition: 'went-down' }
  }
  const tail = recent.slice(-UP_AFTER)
  if (state.down && tail.length === UP_AFTER && tail.every(Boolean)) {
    return { state: { recent, down: false, since: null }, transition: 'came-up' }
  }
  return { state: { ...state, recent }, transition: null }
}
