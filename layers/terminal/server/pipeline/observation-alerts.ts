// The four recipe-observation alert rules, run on the survey tick after the recipes have
// stored their reads. A rule that throws is spooled as an ops event and never stops the others
// or the tick: the rules only read what the recipes stored.

import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { recordOpsEvent } from '#server/utils/ops'
import { writeAdoptionAlerts } from '#layers/adoption/server/pipeline/adoption-alerts'
import { writeDatacenterAlerts } from '#layers/compute/server/pipeline/datacenter-alerts'
import { writeLimitsAlerts } from '#layers/pricing/server/pipeline/limits-alerts'
import { writePayAlerts } from '#layers/talent/server/pipeline/pay-alerts'

const RULES = {
  adoption: writeAdoptionAlerts,
  datacenters: writeDatacenterAlerts,
  limits: writeLimitsAlerts,
  pay: writePayAlerts,
} as const

export async function runObservationAlerts(db: PipelineDb, now = new Date()) {
  const report: Record<string, { written: number; findings: number } | null> = {}
  for (const [name, write] of Object.entries(RULES)) {
    report[name] = await write(db, now).catch(async (error: unknown) => {
      await recordOpsEvent(db, { kind: 'observation_alerts_failed', detail: `${name}: ${String(error)}` })
      return null
    })
  }
  return report
}
