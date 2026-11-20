// The probes:latency cron: settle each lab's model (resolve.ts), probe each
// target once, one after another, store a row and the stream's trace for
// each, then re-roll the day's reading.
//
// One at a time on purpose. A Worker holds six connections open at once and
// queues the rest, and a queued probe's wait would be read as the lab's.

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { effectiveClassMap } from '../class-map'
import { OPENROUTER_KEY_UNSET } from '../fetch'
import type { RawReader } from '../judge/class-map'
import type { RawStore } from '../refresh'
import type { PipelineDb } from '../store'
import { rollProbeDays } from './daily'
import { loadProbeCatalog, resolveProbeTargets, type ProbeSkip } from './resolve'
import { runProbe, type ProbeDeps, type ProbeFetch, type ProbeOutcome } from './stream'
import {
  PROBE_ENDPOINT,
  PROBE_ROUTE,
  PROBE_TARGETS,
  probeRequestBody,
  type ProbeTarget,
} from './targets'

export interface ProbeRunDeps extends Omit<ProbeDeps, 'apiKey'> {
  /** NUXT_OPENROUTER_API_KEY. Empty = nothing is probed and nothing is stored. */
  apiKey: string | undefined
  raw: RawStore
  /** Reads the stored OpenRouter catalog snapshot the flagship models are chosen from. */
  readRaw: RawReader
  /** `cloudflare:<colo>` on the Worker (probeOrigin), `local` elsewhere. */
  ranFrom: string
  /** Settled targets to probe instead of resolving PROBE_TARGETS: tests only. */
  targets?: readonly ProbeTarget[]
}

export interface ProbeRunReport {
  /** Why nothing ran, when nothing did. */
  skipped?: string
  probes: { lab: string; model: string; outcome: ProbeOutcome; detail: string | null }[]
  /** Labs not probed this run, and why; each is spooled as an ops event. */
  unprobed: ProbeSkip[]
  days_rolled: number
}

/** Where one probe's trace lives in R2. */
export const probeRawKey = (lab: string, startedAt: string) =>
  `probes/${startedAt.slice(0, 10)}/${lab}/${startedAt}.json`

export async function runProbes(db: PipelineDb, deps: ProbeRunDeps): Promise<ProbeRunReport> {
  const apiKey = deps.apiKey?.trim() ?? ''
  if (!apiKey) return { skipped: OPENROUTER_KEY_UNSET, probes: [], unprobed: [], days_rolled: 0 }

  const { targets, skipped } = deps.targets
    ? { targets: deps.targets, skipped: [] }
    : resolveProbeTargets(
        PROBE_TARGETS,
        await effectiveClassMap(db),
        await loadProbeCatalog(db, deps.readRaw),
      )
  for (const skip of skipped) await recordOpsEvent(db, { kind: skip.kind, detail: skip.detail })

  const report: ProbeRunReport = { probes: [], unprobed: skipped, days_rolled: 0 }
  const days = new Set<string>()
  for (const target of targets) {
    const result = await runProbe(target, { ...deps, apiKey })
    const { trace, ...row } = result
    let raw_key: string | null = probeRawKey(target.lab, result.started_at)
    try {
      await deps.raw.put(
        raw_key,
        JSON.stringify({
          lab: target.lab,
          endpoint: PROBE_ENDPOINT,
          request: probeRequestBody(target),
          // Where a derived target's model came from: the class map's family and the catalog read.
          chosen_from: target.chosen_from,
          started_at: result.started_at,
          ran_from: deps.ranFrom,
          http_status: result.http_status,
          // [ms after the request was sent, text read]
          reads: trace,
        }),
        'application/json',
      )
    } catch {
      // The row still stands on its own; it just has no bytes behind it.
      raw_key = null
    }
    await db.insert(tables.latencyProbes).values({
      id: crypto.randomUUID(),
      lab: target.lab,
      model: target.model,
      route: PROBE_ROUTE,
      provider: target.provider,
      ...row,
      ran_from: deps.ranFrom,
      raw_key,
      source_url: PROBE_ENDPOINT,
      fetched_at: result.started_at,
    })
    days.add(result.started_at.slice(0, 10))
    report.probes.push({
      lab: target.lab,
      model: target.model,
      outcome: result.outcome,
      detail: result.detail,
    })
  }
  report.days_rolled = await rollProbeDays(db, [...days], deps.now(), deps.targets ?? PROBE_TARGETS)
  return report
}

/**
 * The Cloudflare colo this invocation's requests leave from, as
 * `cloudflare:EWR`. A cron has no request to read `cf.colo` from, so this asks
 * Cloudflare's own trace endpoint. Cron runs move between colos, which is why
 * every row records it; `cloudflare:unknown` when the lookup fails.
 */
export async function probeOrigin(fetcher: ProbeFetch): Promise<string> {
  try {
    const response = await fetcher('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(3000),
    })
    const colo = /^colo=([A-Z0-9]{3,5})$/m.exec(await response.text())?.[1]
    return `cloudflare:${colo ?? 'unknown'}`
  } catch {
    return 'cloudflare:unknown'
  }
}
