// The reliability:record cron: the rollup and the filing detections behind
// /data#reliability. The deploy smoke results are read by their own task
// (reliability:deploys, deploys.ts), which parks on GitHub's rate limit. Each
// part runs on its own, and a failure is reported in the result, never thrown.

import { recordDetections, type DetectionReport, type RawReader } from './acceptance'
import { rollSourceRuns, type RollupReport } from './rollup'
import type { PipelineDb } from '../store'

export interface ReliabilityDeps {
  raw: RawReader
  now: Date
}

type Part<T> = T | { error: string }

export interface ReliabilityReport {
  rollup: Part<RollupReport>
  detections: Part<DetectionReport>
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
  }
}
