import type { JudgeAlertScreen } from '#layers/core/server/pipeline/judge/review'
import type { DepartmentCluster } from '#layers/talent/server/utils/terminal-clusters'
import { parseDepartmentClusters } from '#layers/talent/server/utils/terminal-clusters'
import { clampHiringAlerts } from '#layers/talent/server/pipeline/hiring-floor'
import { effectiveClassMap } from '#layers/pricing/server/pipeline/class-map'
import {
  applyClassMappings,
  type JudgeClassMapping,
} from '#layers/pricing/server/pipeline/judge/class-map'
import { clampRoutineAlerts } from './severity-gates'
import {
  rejectFalseDelistings,
  stillListedRemovals,
} from '../../../../core/server/pipeline/judge/still-listed'

// What the judge runner (layers/core/server/pipeline/judge/submit.ts) runs on
// the grounded alerts before it stores them: no still-listed model called
// delisted, the hiring materiality floor (layers/talent/server/pipeline/hiring-floor.ts),
// the class-map re-mappings (layers/pricing/server/pipeline/judge/class-map.ts), then the
// severity gates (severity-gates.ts). In the shell because one gate reads the
// pricing, talent and companies layers at once; server/registries/judge.ts
// registers it.

export interface ScreenOptions {
  /** The buildout clusters the floor reads; parsed from sourcesYaml when omitted. */
  clusters?: readonly DepartmentCluster[]
}

export const screenJudgeAlerts: JudgeAlertScreen<ScreenOptions> = async ({
  db,
  readRaw,
  now,
  sourcesYaml,
  options,
  body,
  alerts,
  cited,
}) => {
  // Read at submit time: a page that drops the model between the pending
  // read and now makes the removal a real delisting.
  const stillListed = await stillListedRemovals(db, cited)
  const listed = rejectFalseDelistings(alerts, cited, stillListed)

  // The floor runs after grounding and only lowers severity: whatever the
  // routine sent, a hiring move below it is stored as a ticker line, and a
  // critical net cut that empties no department is stored as notable.
  const clusters = options.clusters ?? (sourcesYaml ? parseDepartmentClusters(sourcesYaml) : [])
  const floored = await clampHiringAlerts(db, listed.accepted, cited, clusters)
  // The matrix as it stood before this run's re-mappings: a model the run
  // maps away from was still tracked when its changes were detected.
  const matrix = await effectiveClassMap(db)
  // Re-mappings are gated against the stored page, never against the body.
  // Applied before the alerts are stored, so an alert on a sentence the run
  // only re-quoted is stored as the rewording it is.
  const classMap = await applyClassMappings(
    db,
    readRaw,
    (body.class_map ?? []) as JudgeClassMapping[],
    now,
  )
  const gated = clampRoutineAlerts(
    floored.alerts,
    cited,
    new Set(matrix.map((e) => `${e.provider}:${e.model_slug}`)),
    new Set(stillListed.map((r) => r.change_id)),
    new Set(classMap.requoted),
  )
  return {
    accepted: listed.accepted,
    alerts: gated.alerts,
    rejected: listed.rejected,
    clamped: [...floored.clamped, ...gated.clamped],
    reports: {
      class_map: {
        accepted: classMap.accepted,
        rejected: classMap.rejected.map((r) => ({
          reason: r.reason,
          detail: r.detail,
          cell: `${r.mapping.provider}:${r.mapping.class}`,
          model_slug: r.mapping.model_slug,
        })),
      },
    },
  }
}
