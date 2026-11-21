import { setLane, type Lane } from '#layers/core/server/pipeline/lanes'
import { normalizeDisclosureTimelines, normalizeDisclosures } from './normalize'
import { parseOpenAiMisalignmentReport } from './parsers/disclosures/openai-misalignment-report'
import { parseOpenAiMisalignmentReports } from './parsers/disclosures/openai-misalignment-reports'

// The misalignment-disclosure lanes. Registered in server/registries/lanes.ts.
// The report pages are derived from the index's slugs by the shell's
// derived.ts; their lane is matched by prefix.

// A derived misalignment report page: the dates the index omits, one row.
// The page IS the report's current state.
const MISALIGNMENT_REPORT_PAGE_LANE: Lane = {
  sides: [],
  removals: 'set',
  parse: (text, { prov, snapshotId, derivedKey }) => ({
    entities: normalizeDisclosureTimelines(
      parseOpenAiMisalignmentReport(text, derivedKey, prov).rows,
      snapshotId,
    ),
  }),
}

/** Lanes for derived sources, matched by source-id prefix (server/registries/lanes.ts › laneFor). */
export const MODEL_DERIVED_LANES: readonly { prefix: string; lane: Lane }[] = [
  { prefix: 'openai-misalignment-report-', lane: MISALIGNMENT_REPORT_PAGE_LANE },
]

export const MODEL_LANES: Readonly<Record<string, Lane>> = {
  // The disclosure index IS the current set: a report taken down is a
  // 'removed' change the judge should see, not a window scrolling on. Its
  // printed date is in each row but never wakes the judge on its own
  // (layers/core/server/pipeline/judge/pending.ts › isTimestampOnlyChange).
  'openai-misalignment-reports': setLane((html, { prov, snapshotId }) => {
    const { rows, skipped } = parseOpenAiMisalignmentReports(html, prov)
    return {
      entities: normalizeDisclosures(rows, snapshotId),
      note: skipped.length
        ? `${skipped.length} skipped: ${skipped.map((s) => `${s.entry} (${s.reason})`).join('; ')}`
        : undefined,
    }
  }),
}
