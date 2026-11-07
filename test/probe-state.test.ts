// The external probe pages once per outage and once per recovery, and never
// for a single slow request.

import { describe, expect, it } from 'vitest'

import { INITIAL_STATE, step, type ProbeState } from '../scripts/lib/probe-state'

function run(runs: boolean[], from: ProbeState = INITIAL_STATE) {
  let state = from
  const transitions: string[] = []
  runs.forEach((ok, i) => {
    const next = step(state, ok, `t${i}`)
    state = next.state
    if (next.transition) transitions.push(`${i}:${next.transition}`)
  })
  return { state, transitions }
}

describe('probe step', () => {
  it('ignores one failing run on a healthy site', () => {
    expect(run([true, false, true, true, false, true]).transitions).toEqual([])
  })

  it('goes down on 2 failing runs out of 3, once', () => {
    const { state, transitions } = run([true, false, true, false, false, false])
    expect(transitions).toEqual(['3:went-down'])
    expect(state).toMatchObject({ down: true, since: 't3' })
  })

  it('comes up only after 3 clean runs in a row', () => {
    const { transitions, state } = run([false, false, true, true, false, true, true, true])
    expect(transitions).toEqual(['1:went-down', '7:came-up'])
    expect(state.down).toBe(false)
  })

  it('a flapping site sends one down and nothing more until it is steady', () => {
    const flapping = [false, true, false, true, false, true, false, true]
    expect(run(flapping).transitions).toEqual(['2:went-down'])
  })
})
