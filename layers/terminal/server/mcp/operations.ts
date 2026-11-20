// Capacity strain and safety: incidents, latency probes, published rate limits, misalignment disclosures.

import { z } from 'zod'
import { recipeRunsStamp } from '../utils/terminal-db'
import { queryLimits, VIEW_RECIPES } from '../utils/terminal-recipe-views'
import {
  INCIDENT_HISTORY_DAYS,
  INCIDENT_WINDOW_DAYS,
  queryIncidents,
} from '../utils/terminal-incidents'
import { queryDisclosures } from '../utils/terminal-disclosures'
import { probesStamp, queryProbes } from '../utils/terminal-probes'
import { ProviderSchema, json, READ_ONLY, PROVENANCE, type McpKit } from './kit'

export function registerOperationsTools({ server, deps }: McpKit): void {
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
        'Alibaba and Moonshot AI have NO incident history we can read and are reported as no_public_feed with the reason, never as zero incidents. Optional provider filter narrows providers and incidents. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const incidents = await deps.serve('incidents', (ctx) => queryIncidents(deps.db, ctx))
      if (!provider) return json(incidents)
      return json({
        ...incidents,
        providers: incidents.providers.filter((p) => p.provider === provider),
        incidents: incidents.incidents.filter((i) => i.provider === provider),
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
        'ttft_ms, total_ms, output_tokens, tokens_per_second, ran_from as cloudflare:<colo>), window (the trailing window_days of complete days) and days (one reading per UTC day, newest first, history_days back). ' +
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

  server.registerTool(
    'get_rate_limits',
    {
      title: 'Published API rate limits',
      description:
        'The API rate limits OpenAI, Anthropic, xAI and Meta publish in their docs. pages is one per lab’s limits page: covers says what it covers, metrics names the columns ' +
        '(requests or tokens per minute, per day, …), and rows is one per model and tier with values per metric (null is none published) and text where the page gives a limit in words ' +
        '(“256 concurrent streams”). snapshot is the newest reading and previous the one before it once a change has been seen; changed counts the limits that differ between them. ' +
        'A new reading is stored only when a limit changes. Limits reflect tier design and abuse control as much as capacity, and they change in announced steps, so a raised limit is not a measure of spare capacity. ' +
        'Google and Mistral publish no per-model limits. Optional provider keeps one lab’s page. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const data = await deps.serve(
        'limits',
        () => queryLimits(deps.db),
        await recipeRunsStamp(deps.db, VIEW_RECIPES.limits),
      )
      if (!provider) return json(data)
      return json({ ...data, pages: data.pages.filter((p) => p.lab === provider) })
    },
  )

  server.registerTool(
    'get_disclosures',
    {
      title: 'Misalignment disclosures',
      description:
        'Each lab’s own index of misalignment reports and notices — agents leaving their sandbox, messaging each other through ' +
        'public services, deceiving in their own summaries. Only OpenAI publishes one (alignment.openai.com/misalignment-reports); ' +
        'every other lab is reported as no_public_feed with the audit’s reason, never as zero. A count measures ' +
        'disclosure practice, not how often misalignment happens: never rank labs on it. entries carries every report and notice ' +
        'with title, summary, model and observed_during VERBATIM, and for a report its page’s dates: discovered_on, disclosed_on ' +
        '(disclosed_basis says whether the page printed it or it is the earliest date the index has shown), and ' +
        'days_to_disclosure between them. timeline_status says why a report has no dates (not_fetched, title_mismatch). Per ' +
        'provider, report and notice counts and the median days_to_disclosure over timed_reports. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const disclosures = await deps.serve('disclosures', (ctx) => queryDisclosures(deps.db, ctx))
      if (!provider) return json(disclosures)
      return json({
        ...disclosures,
        providers: disclosures.providers.filter((p) => p.provider === provider),
        entries: disclosures.entries.filter((e) => e.provider === provider),
      })
    },
  )
}
