// The four recipe-observation alert rules and the deal-score and revenue-score rules, run on the
// survey tick after the recipes have stored their reads (the press rules read the stored press
// figures and filings). A rule that throws is spooled as an ops event and never stops the others
// or the tick: the rules only read what the recipes stored.

import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { recordOpsEvent } from '#server/utils/ops'
import { writeAdoptionAlerts } from '#layers/adoption/server/pipeline/adoption-alerts'
import { writeDatacenterAlerts } from '#layers/compute/server/pipeline/datacenter-alerts'
import { writeLimitsAlerts } from '#layers/pricing/server/pipeline/limits-alerts'
import { writePayAlerts } from '#layers/talent/server/pipeline/pay-alerts'
import { writeDealAlerts } from '#layers/press/server/pipeline/deal-alerts'
import { writeRevenueScoreAlerts } from '#layers/press/server/pipeline/revenue-alerts'

type Rule = (db: PipelineDb, now: Date) => Promise<{ written: number; findings: number }>

export async function runObservationAlerts(db: PipelineDb, sourcesYaml: string, now = new Date()) {
  const rules: Record<string, Rule> = {
    adoption: writeAdoptionAlerts,
    datacenters: writeDatacenterAlerts,
    limits: writeLimitsAlerts,
    pay: writePayAlerts,
    deals: writeDealAlerts,
    // Which labs file their own revenue is a sources.yaml block (revenue_filers).
    revenue: (db, now) => writeRevenueScoreAlerts(db, sourcesYaml, now),
  }
  const report: Record<string, { written: number; findings: number } | null> = {}
  for (const [name, write] of Object.entries(rules)) {
    report[name] = await write(db, now).catch(async (error: unknown) => {
      await recordOpsEvent(db, {
        kind: 'observation_alerts_failed',
        detail: `${name}: ${String(error)}`,
      })
      return null
    })
  }
  return report
}
