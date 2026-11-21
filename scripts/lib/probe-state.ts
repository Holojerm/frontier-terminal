// The external probe's alerting rule (scripts/probe.ts), free of Node imports
// so the workerd test suite can drive it.
//
// One run fetches each target twice. Observed hangs hit about one page request
// in eight, so one sample per minute would miss them most of the time; six
// requests a run catch that rate in about half the runs. Down needs 2 failing
// runs of the last 3, so one slow request on a healthy site never pages; up
// needs 3 clean runs in a row, so a flapping site sends one "down" and one "up".

export const WINDOW = 3
const DOWN_AFTER = 2
const UP_AFTER = 3

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
