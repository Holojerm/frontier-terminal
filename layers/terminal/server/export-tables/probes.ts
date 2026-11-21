// The hourly latency probes we send each lab, and the daily strain reading rolled from them. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import * as tables from '#server/db/schema'
import {
  byColumn,
  plainTable,
  renamedColumns,
  type ColumnDoc,
  type ExportTable,
} from '#layers/core/server/utils/terminal-export-views'

const LAB: ColumnDoc = {
  type: 'text',
  meaning:
    'The lab whose flagship model was probed: openai, anthropic, google, xai, meta, mistral, alibaba, or moonshot.',
}

const ROUTE: ColumnDoc = {
  type: 'text',
  meaning: 'The router the request went through: openrouter, the only one so far.',
}

export const PROBE_TABLES = {
  latency_probes: renamedColumns(
    plainTable(
      'latency_probes',
      'Every latency probe we have sent: once an hour, one fixed streaming request to each lab’s flagship model through OpenRouter, pinned to the lab’s own endpoint with no fallback. Each row has the outcome and the timings we measured from the stream. Rows are never edited. Our own measurements, from one account and one router, so a row is a reading of strain and not of utilization. Timings for xAI before 2026-11-20 counted its reasoning, so they aren’t comparable with later ones.',
      tables.latencyProbes,
      {
        id: { type: 'text', key: true, meaning: 'The probe, a random UUID.' },
        lab: LAB,
        model: { type: 'text', meaning: 'The model id the request named, as OpenRouter lists it.' },
        route: ROUTE,
        provider: {
          type: 'text',
          meaning:
            'OpenRouter’s slug for the lab’s own endpoint, the only one the request allowed (google-ai-studio, mistral/zdr, …). Not a lab id.',
        },
        served_by: {
          type: 'text',
          nullable: true,
          meaning:
            'The provider the stream says served the request. Null when the stream named none, as when it failed first.',
        },
        served_by_pinned: {
          type: 'boolean',
          nullable: true,
          meaning:
            'Whether served_by is the provider the request was pinned to (pinned_provider). Null when the stream named none.',
        },
        started_at: {
          type: 'timestamp',
          meaning: 'When we sent the request, in UTC.',
        },
        outcome: {
          type: 'text',
          meaning:
            'ok, rate_limited, failed, timeout, setup (our key or account failed), or router (OpenRouter itself failed). setup and router probes say nothing about the lab and are left out of every reading.',
        },
        http_status: {
          type: 'integer',
          nullable: true,
          meaning: 'The HTTP status of the response. Null when no response came back.',
        },
        detail: {
          type: 'text',
          nullable: true,
          meaning: 'The error, in the words of the response, for a probe that wasn’t ok.',
        },
        provider_code: {
          type: 'text',
          nullable: true,
          meaning:
            'The error code the lab’s endpoint gave, where OpenRouter passes one on. Null otherwise.',
        },
        ttft_ms: {
          type: 'integer',
          unit: 'milliseconds',
          nullable: true,
          meaning:
            'Time to first token: from sending the request to the first text of the answer, so it includes any reasoning first. Null when no answer text arrived.',
        },
        total_ms: {
          type: 'integer',
          unit: 'milliseconds',
          meaning: 'From sending the request to the end of the stream or the failure.',
        },
        output_tokens: {
          type: 'integer',
          unit: 'tokens',
          nullable: true,
          meaning: 'Tokens in the reply as the usage report counts them. Null without a report.',
        },
        reasoning_tokens: {
          type: 'integer',
          unit: 'tokens',
          nullable: true,
          meaning:
            'The reasoning tokens among them, where the usage report splits them out. Null otherwise.',
        },
        tokens_per_second: {
          type: 'number',
          unit: 'tokens per second',
          nullable: true,
          meaning:
            'Answer tokens over the time between the answer’s first and last token, with reasoning tokens left out. Null when there weren’t enough to time.',
        },
        finish_reason: {
          type: 'text',
          nullable: true,
          meaning: 'Why the model stopped, as the stream says (stop, length, …).',
        },
        ran_from: {
          type: 'text',
          meaning:
            'Where the request left from: cloudflare:<colo>, the Cloudflare data center that ran the probe, or local off the Worker.',
        },
        placement: {
          type: 'text',
          meaning:
            'Where the probe was meant to leave from: a Cloudflare location hint (enam, eastern North America) for a probe run from a fixed place, or unpinned for every probe before that, which left from whichever data center ran the hourly job. Compare a series within one placement only.',
        },
        rate_limit_headers: {
          type: 'json',
          nullable: true,
          meaning:
            'The rate-limit headers the response carried (x-ratelimit-*, ratelimit-*, retry-after) as a JSON object of name to value. Null when it sent none.',
        },
        raw_key: {
          type: 'text',
          nullable: true,
          meaning:
            'Key of the stored stream in this site’s object store (R2): every read of the response with its arrival time, the bytes the timings come from.',
        },
        source_url: {
          type: 'text',
          provenance: true,
          meaning: 'The endpoint the request was sent to.',
        },
        fetched_at: {
          type: 'timestamp',
          provenance: true,
          meaning: 'When the request was sent, in UTC. Equal to started_at.',
        },
      },
      [tables.latencyProbes.started_at, tables.latencyProbes.id],
      byColumn(tables.latencyProbes.started_at),
      undefined,
      { lab: tables.latencyProbes.lab },
    ),
    { provider: 'pinned_provider' },
  ),
  probe_days: plainTable(
    'probe_days',
    'The daily strain reading behind /api/probes and the Incidents page: per lab, UTC day and placement, how many probes were rate limited or failed, and median throughput and time to first token in the lab’s working hours against its night. A day that changed model is read from the newest model’s probes only. The strained share is (rate_limited + failed) / probes, and peak against off-peak is peak_tps / offpeak_tps.',
    tables.probeDays,
    {
      lab: { ...LAB, key: true },
      day: { type: 'date', key: true, meaning: 'The UTC day.' },
      placement: {
        type: 'text',
        key: true,
        meaning:
          'Where the day’s probes left from, as in latency_probes.placement. A day is never read across placements, so the day placement began has a row for each.',
      },
      model: {
        type: 'text',
        meaning: 'The day’s newest model, the only one the reading counts.',
      },
      route: ROUTE,
      probes: {
        type: 'integer',
        unit: 'probes',
        meaning: 'Probes that say something about the lab: every outcome but setup and router.',
      },
      ok: { type: 'integer', unit: 'probes', meaning: 'Probes that streamed an answer.' },
      rate_limited: {
        type: 'integer',
        unit: 'probes',
        meaning: 'Probes the endpoint refused with a rate limit.',
      },
      failed: {
        type: 'integer',
        unit: 'probes',
        meaning: 'Probes that errored or timed out.',
      },
      excluded: {
        type: 'integer',
        unit: 'probes',
        meaning: 'Probes left out because our key or the router failed.',
      },
      peak_n: {
        type: 'integer',
        unit: 'probes',
        meaning: 'Ok probes with a throughput reading in the lab’s working hours.',
      },
      offpeak_n: {
        type: 'integer',
        unit: 'probes',
        meaning: 'Ok probes with a throughput reading in the lab’s night hours.',
      },
      peak_tps: {
        type: 'number',
        unit: 'tokens per second',
        nullable: true,
        meaning:
          'Median throughput of the working-hours probes. Null under three probes, never a guess from one or two.',
      },
      offpeak_tps: {
        type: 'number',
        unit: 'tokens per second',
        nullable: true,
        meaning: 'Median throughput of the night probes. Null under three probes.',
      },
      peak_ttft_ms: {
        type: 'number',
        unit: 'milliseconds',
        nullable: true,
        meaning: 'Median time to first token of the working-hours probes. Null under three.',
      },
      offpeak_ttft_ms: {
        type: 'number',
        unit: 'milliseconds',
        nullable: true,
        meaning: 'Median time to first token of the night probes. Null under three.',
      },
      tps: {
        type: 'number',
        unit: 'tokens per second',
        nullable: true,
        meaning: 'Median throughput of the day’s ok probes. Null with none.',
      },
      ttft_ms: {
        type: 'number',
        unit: 'milliseconds',
        nullable: true,
        meaning: 'Median time to first token of the day’s ok probes. Null with none.',
      },
      rolled_at: {
        type: 'timestamp',
        meaning:
          'When the row was last rolled from latency_probes, in UTC. The current day is rolled again after every hourly run.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The endpoint the day’s newest probe was sent to.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the day’s newest probe was sent, in UTC.',
      },
    },
    [tables.probeDays.lab, tables.probeDays.day],
    'its rows are rolled again in place as the day’s probes land. latency_probes answers as_of, and a day can be rolled from its rows.',
    undefined,
    { lab: tables.probeDays.lab },
  ),
} satisfies Record<string, ExportTable>
