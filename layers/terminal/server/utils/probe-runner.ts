// The two halves of an hourly probe run. The cron (tasks/probes/latency.ts)
// runs nowhere in particular, so it only asks each placement's Durable Object
// to probe (dispatchPinnedProbes); the object runs them where it lives
// (runProbesHere, from server/routes/_probes/run.post.ts). The cron never
// probes from its own colo: without the binding it spools why and stops.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import { recordOpsEvent } from '#server/utils/ops'
import { blobRawReader } from '../pipeline/judge/class-map'
import { blobRawStore } from '../pipeline/poll'
import {
  PROBE_PLACEMENT_FAILED_KIND,
  PROBE_PLACEMENTS,
  PROBE_UNPINNED_KIND,
  dispatchProbes,
  type PlacementRun,
  type ProbeLocationHint,
  type ProbeNamespace,
  type ProbePlacement,
} from '../pipeline/probes/placement'
import { runProbes, type ProbeRunReport } from '../pipeline/probes/run'
import type { PipelineDb } from '../pipeline/store'

/** Spooled once per run in which a probe was refused for a reason of ours. */
export const PROBE_SETUP_FAILED_KIND = 'probe_setup_failed'

/** The wrangler.toml binding of the probes' Durable Object namespace. */
export const PROBE_BINDING = 'PROBES'

/** Run every probe from this isolate, and spool any refused for a reason of ours. */
export async function runProbesHere(
  placement: ProbePlacement,
  ranFrom: string,
): Promise<ProbeRunReport> {
  const report = await runProbes(db, {
    fetch: (input, init) => fetch(input, init),
    clock: () => Date.now(),
    now: () => new Date(),
    apiKey: useRuntimeConfig().openrouterApiKey,
    raw: blobRawStore(blob),
    readRaw: blobRawReader(blob),
    ranFrom,
    placement,
  })
  const setup = report.probes.filter((p) => p.outcome === 'setup')
  if (setup.length > 0) {
    await recordOpsEvent(db, {
      kind: PROBE_SETUP_FAILED_KIND,
      detail: `${placement}: ${setup.map((p) => p.lab).join(', ')}: ${setup[0]!.detail ?? 'refused'}`,
    })
  }
  return report
}

export interface PinnedProbeResult {
  /** Why nothing was probed, when nothing was. */
  skipped?: string
  runs: PlacementRun<ProbeRunReport>[]
}

/** The cron's half: ask each placement's object to probe, and spool any that could not. */
export async function dispatchPinnedProbes(
  target: PipelineDb,
  env: Record<string, unknown> | undefined,
  placements: readonly ProbeLocationHint[] = PROBE_PLACEMENTS,
): Promise<PinnedProbeResult> {
  const namespace = env?.[PROBE_BINDING] as ProbeNamespace | undefined
  if (!namespace || typeof namespace.get !== 'function') {
    const skipped = `No ${PROBE_BINDING} Durable Object binding, so no probe has a fixed place to run from. Nothing was probed.`
    await recordOpsEvent(target, { kind: PROBE_UNPINNED_KIND, detail: skipped })
    return { skipped, runs: [] }
  }
  const runs = await dispatchProbes<ProbeRunReport>(namespace, placements)
  for (const run of runs) {
    if (run.error) {
      await recordOpsEvent(target, {
        kind: PROBE_PLACEMENT_FAILED_KIND,
        detail: `${run.placement}: ${run.error}`,
      })
    }
  }
  return { runs }
}
