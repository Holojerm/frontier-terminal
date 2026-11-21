// Capacity strain as the labs post it and as we measure it: status-page incidents and latency probes.

import { z } from 'zod'
import {
  INCIDENT_HISTORY_DAYS,
  INCIDENT_WINDOW_DAYS,
  incidentArchiveStamp,
  queryIncidents,
} from '../utils/terminal-incidents'
import { probesStamp, queryProbes } from '../utils/terminal-probes'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerReliabilityTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_incidents',
    {
      title: 'Status-page incidents',
      description:
        'Capacity strain as the vendor chose to post it: one status feed per lab that has one (OpenAI and Mistral Statuspage, ' +
        'Anthropic’s Atom history, xAI’s and DeepSeek’s RSS histories, Google Cloud ' +
        `filtered to Gemini / Vertex AI products). Per provider, incidents started in the newest ${INCIDENT_WINDOW_DAYS} days ` +
        '(last_window) against the same span before (prior_window), what is open now, and coverage_from — where held history ' +
        'begins; a Statuspage feed is a rolling window, so prior_window is partial until the pipeline has polled through it. ' +
        `incidents lists every one started inside ${INCIDENT_HISTORY_DAYS} days, newest first, with impact in the vendor’s own ` +
        'vocabulary (never mapped across vendors; null for Anthropic and DeepSeek, whose feeds publish none) and a link. Each lab’s window anchors on its own window_to, the last successful read of its status feed, not the ' +
        'clock, so a feed that stopped answering shows an earlier window_to rather than a quiet stretch. Not an SLA and not comparable across vendors: OpenAI’s feed mixes ChatGPT with API incidents and has no component ' +
        'field; xAI’s RSS history covers Cursor’s products alongside Grok and the API (read components). DeepSeek’s titles are Chinese with the English in parentheses. Meta, ' +
        'Alibaba and Moonshot AI have NO incident history we can read and are reported as no_public_feed with the reason, never as zero incidents. ' +
        'archived (null before the backfill) is the history from before each live feed: incidents per lab per month from the Internet Archive’s copies of the same feeds ' +
        '(basis archived, source_id wayback:<era>), with covered, the share of each month some copy reaches (a month under 1 can hold incidents no copy listed; ' +
        'null counts mean no copy reaches it), holes, gaps with the reason, and not_covered (Mistral). No uptime is computed from copies. ' +
        '/export/archived_incidents.csv has every archived incident with the copy as source_url. Optional provider filter narrows providers, incidents and archived labs. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const incidents = await deps.serve(
        'incidents',
        (ctx) => queryIncidents(deps.db, ctx),
        await incidentArchiveStamp(deps.db),
      )
      if (!provider) return json(incidents)
      const { archived } = incidents
      return json({
        ...incidents,
        providers: incidents.providers.filter((p) => p.provider === provider),
        incidents: incidents.incidents.filter((i) => i.provider === provider),
        archived: archived && {
          ...archived,
          labs: archived.labs.filter((l) => l.provider === provider),
          gaps: archived.gaps.filter((g) => g.provider === provider),
          not_covered: archived.not_covered.filter((n) => n.provider === provider),
        },
      })
    },
  )

  server.registerTool(
    'get_probes',
    {
      title: 'Latency probes: measured strain per lab',
      description:
        'Our own measurement, not a vendor’s page. Once an hour we send each lab’s flagship model one fixed streaming request (probe.prompt, capped at probe.max_tokens) ' +
        'through OpenRouter, pinned to the lab’s own endpoint with no fallback, and time the reply. labs has one entry per tracked lab. status probed carries latest (the newest probe: outcome, http_status, ' +
        'ttft_ms, total_ms, output_tokens, tokens_per_second, ran_from as cloudflare:<colo>, placement, served_by_pinned, rate_limit_headers), window (the trailing window_days of complete days) and days (one reading per UTC day, newest first, history_days back). ' +
        'days and window are the pinned series only: probes sent from one place, placement.hint (enam, eastern North America), since placement.since. other_series holds every other placement apart, among them unpinned, the probes before that, sent from whichever colo ran the job; never join it to days. ' +
        'A day gives probes, ok, rate_limited, failed, strained_share ((rate_limited + failed) ÷ probes), peak_tps and offpeak_tps (median tokens per second in the lab’s fixed UTC peak and off-peak hours, named in hours; ' +
        'null under three good probes) and peak_to_offpeak (under 1 means slower in working hours). complete is false for the current UTC day. Probes refused because of our key, credit or the router are left out of probes. ' +
        'status not_probed is a lab with no first-party endpoint to probe, with the reason in gap, never a zero. status waiting is a target with no probe stored yet. since is the first day probed: history starts there and cannot be backfilled. ' +
        'This is a strain reading, not utilization, and it is unproven as a predictor. Hourly sampling misses short rate-limit bursts. Compare a lab with its own history, not across labs: six of the models reason before they answer, ' +
        'so ttft_ms (the time to the first answer text) includes that reasoning, and tokens_per_second counts answer tokens only. Read method and caveat before quoting a number. Optional provider filter narrows labs. No as_of: read the day you want from days. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const probes = await deps.serve(
        'probes',
        (ctx) => queryProbes(deps.db, ctx),
        await probesStamp(deps.db),
      )
      if (!provider) return json(probes)
      return json({ ...probes, labs: probes.labs.filter((l) => l.lab === provider) })
    },
  )
}
