// The reliability:record cron: the three things /data#reliability reads that
// no other job writes. Each part runs on its own, so a GitHub outage never
// stops the rollup, and a failure is reported in the result, never thrown.

import { recordDetections, type DetectionReport, type RawReader } from './acceptance'
import { recordDeployChecks, type DeployReport, type ReliabilityKv } from './deploys'
import { rollSourceRuns, type RollupReport } from './rollup'
import type { PipelineDb } from '../store'

export interface ReliabilityDeps {
  raw: RawReader
  kv: ReliabilityKv
  fetch: typeof fetch
  repoUrl: string
  now: Date
}

type Part<T> = T | { error: string }

export interface ReliabilityReport {
  rollup: Part<RollupReport>
  detections: Part<DetectionReport>
  deploys: Part<DeployReport>
}

const settle = async <T>(run: () => Promise<T>): Promise<Part<T>> => {
  try {
    return await run()
  } catch (error) {
    return { error: String(error) }
  }
}

export async function runReliabilityRecord(
  db: PipelineDb,
  deps: ReliabilityDeps,
): Promise<ReliabilityReport> {
  return {
    rollup: await settle(() => rollSourceRuns(db, deps.now)),
    detections: await settle(() => recordDetections(db, { raw: deps.raw, now: deps.now })),
    deploys: await settle(() => recordDeployChecks(db, deps)),
  }
}
