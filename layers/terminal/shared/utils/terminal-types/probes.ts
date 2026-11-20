import type { LabId, Prov, Stamp } from './common'

/** One lab's reading for one UTC day, from that day's hourly probes. */
export interface ProbeDayView extends Prov {
  /** YYYY-MM-DD, UTC. */
  day: string
  /** False for the current UTC day, whose probes are still coming in. */
  complete: boolean
  model: string
  /** Probes that say something about the lab: all but the ones our key, our request or the router failed. */
  probes: number
  ok: number
  rate_limited: number
  /** Errors and timeouts at the lab. */
  failed: number
  /** (rate_limited + failed) ÷ probes; null with no probes to count. */
  strained_share: number | null
  /** Median tokens per second over the day's ok probes in the lab's peak hours; null under three. */
  peak_tps: number | null
  offpeak_tps: number | null
  /** peak_tps ÷ offpeak_tps: under 1 is slower in working hours. Null unless both exist. */
  peak_to_offpeak: number | null
  peak_ttft_ms: number | null
  offpeak_ttft_ms: number | null
}

/** A lab's newest probe, as stored. */
export interface ProbeLatestView extends Prov {
  started_at: string
  /** ok | rate_limited | failed | timeout | setup | router */
  outcome: string
  http_status: number | null
  detail: string | null
  ttft_ms: number | null
  total_ms: number
  output_tokens: number | null
  tokens_per_second: number | null
  /** `cloudflare:<colo>`: where the request left from. */
  ran_from: string
  /** Who the router says served it. */
  served_by: string | null
}

/** The trailing window, from its complete days. */
export interface ProbeWindowView {
  days: number
  probes: number
  rate_limited: number
  failed: number
  strained_share: number | null
  /** Median of the days' peak medians; null with none. */
  peak_tps: number | null
  offpeak_tps: number | null
  peak_to_offpeak: number | null
}

export interface ProbeLabView {
  lab: LabId
  display: string
  /** probed: readings below. waiting: a target with no probe stored yet. not_probed: no first-party endpoint to probe (see gap). */
  status: 'probed' | 'waiting' | 'not_probed'
  /**
   * The model id as the router names it, from the newest probe. A flagship
   * target is re-chosen on every run, so this moves when the lab's flagship
   * does. Before its first probe, the class map's flagship slug.
   */
  model: string
  /** Why this model, where the lab’s docs name no flagship; null when it is the price matrix’s flagship. */
  model_note: string | null
  /** The peak and off-peak hours this lab's readings use, in words. */
  hours: string | null
  gap: string | null
  latest: ProbeLatestView | null
  window: ProbeWindowView | null
  /** Newest first, history_days back. */
  days: ProbeDayView[]
}

export interface ProbesData extends Stamp {
  window_days: number
  history_days: number
  /** The first day any probe ran: nothing before it exists or can be rebuilt. */
  since: string | null
  labs: ProbeLabView[]
  /** What every probe sends. */
  probe: {
    endpoint: string
    route: string
    prompt: string
    max_tokens: number
    cadence: string
  }
  method: string
  caveat: string
}
