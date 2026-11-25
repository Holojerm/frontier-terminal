import type { AlertSeverity, AlertTierFilter } from '../../../core/shared/utils/terminal-tiers'
import type { FieldDiff, Prov, ProviderId, Stamp } from '../../../core/shared/types/common'

export interface ChangeView extends Prov {
  id: string
  entity_key: string
  entity_type:
    | 'job'
    | 'model'
    | 'filing'
    | 'incident'
    | 'ranking'
    | 'revenue'
    | 'recommendation'
    | 'filer'
    | 'disclosure'
    | 'disclosure_timeline'
    | 'document'
    | 'offering'
    | 'statement'
    | 'commitment'
    | 'concentration'
    | 'shares'
    | 'risk_factors'
    | 'filed_fact'
    | 'guidance'
    | 'guidance_check'
    | 'gpu_price'
    | 'adoption_series'
    | 'data_center'
    | 'rate_limit'
    | 'pay_band'
    | 'deal_score'
    | 'supplier_passage'
  provider: ProviderId
  change_type: 'added' | 'removed' | 'modified'
  detected_at: string
  /** One line naming the entity, built only from fields in the row. */
  summary: string
  /** Scalar fields that differ between before_json and after_json. */
  diff: FieldDiff[]
}

export interface AlertView extends Prov {
  id: string
  severity: AlertSeverity
  headline: string
  explanation: string
  rule:
    | 'agent-judge'
    | 's1-floor'
    | 'periodic-floor'
    | 'cik-resolved'
    | 'model-floor'
    | 'prospectus-floor'
    | 'hiring-rollup'
    | 'filed-fact-floor'
    | 'guidance-floor'
    | 'gpu-median-floor'
    | 'adoption-floor'
    | 'datacenter-floor'
    | 'limits-floor'
    | 'pay-floor'
    | 'deal-score-floor'
    | 'supplier-passage-floor'
  created_at: string
  change_ids: string[]
  /** The cited rows, resolved; ids that resolve to nothing are listed in `missing`. */
  changes: ChangeView[]
  missing_change_ids: string[]
}

export interface AlertsData extends Stamp {
  /** Which tier(s) `rows` and `total` cover. */
  tier: AlertTierFilter
  rows: AlertView[]
  /** Every alert matching the tier and filters, not just this page. */
  total: number
  /** Pass as `cursor` for the next, older page; null when this page reaches the oldest match. */
  next_cursor: string | null
}

/** A cited change on its permalink: every scalar field, before and after. */
export interface ChangeDetailView extends ChangeView {
  /** Every field of before_json ∪ after_json, sorted; unchanged ones included. */
  fields: FieldDiff[]
}

export interface AlertDetail extends Omit<AlertView, 'changes'> {
  changes: ChangeDetailView[]
}

export interface AlertDetailData extends Stamp {
  alert: AlertDetail
}
