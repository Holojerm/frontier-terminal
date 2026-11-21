// Submit the backfill's call replays to AssemblyAI from the mini, under the
// one-time BACKFILL_SPEND_CAP_USD (layers/companies/server/calls/assemblyai.ts).
//
//   ASSEMBLYAI_API_KEY="$(op read 'op://Agents/assemblyai/credential')" bun scripts/calls-audio-backfill.ts [--dry-run] [--spend]
//
// Each curated `audio` document of a call held before BACKFILL_BEFORE with no
// job yet is costed from its size and MP3 header, newest call first, and none
// is sent once the next would pass the ceiling. Each job id, submission time
// and estimate is written to curated/earnings-calls.json at once, so a rerun
// resumes; the Worker collects the transcripts (calls/ingest.ts, step 4).
// --spend prints what the backfill jobs have been billed. The key is read
// from the environment and never printed.

import { join } from 'node:path'

import {
  ASSEMBLYAI_API,
  BACKFILL_SPEND_CAP_USD,
  costOf,
  replaySeconds,
  spendBasis,
  transcriptRequest,
} from '../layers/companies/server/calls/assemblyai'
import { CuratedCalls } from '../layers/companies/server/calls/curated'

const FILE = join(import.meta.dir, '../layers/companies/server/curated/earnings-calls.json')
const UA = 'Mozilla/5.0 (compatible; FrontierTerminal/1.0; +https://frontierterm.com)'
const dryRun = process.argv.includes('--dry-run')
const spendOnly = process.argv.includes('--spend')
const key = process.env.ASSEMBLYAI_API_KEY ?? ''
if (!key && !dryRun) throw new Error('ASSEMBLYAI_API_KEY is not set')

const load = async () => CuratedCalls.parse(JSON.parse(await Bun.file(FILE).text()))
// Written back as read, not as parsed, so the file keeps its own key order.
const raw = async () =>
  JSON.parse(await Bun.file(FILE).text()) as { documents: Record<string, unknown>[] }
const save = async (doc: unknown) => Bun.write(FILE, `${JSON.stringify(doc, null, 2)}\n`)

async function estimate(url: string): Promise<number | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) return null
  const total = Number(
    res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length'),
  )
  const head = new Uint8Array(await res.arrayBuffer())
  if (!Number.isFinite(total) || total <= 0) return null
  return replaySeconds(head, total)
}

const curated = await load()
const backfill = curated.documents.filter(
  (d) => d.kind === 'audio' && spendBasis(d.call_date) === 'backfill',
)

if (spendOnly) {
  let billed = 0
  let running = 0
  let hours = 0
  for (const d of backfill.filter((x) => x.job_id)) {
    const res = await fetch(`${ASSEMBLYAI_API}/v2/transcript/${d.job_id}`, {
      headers: { authorization: key },
    })
    const job = (await res.json()) as { status?: string; audio_duration?: number }
    if (job.status === 'completed' && job.audio_duration) {
      billed += costOf(job.audio_duration)
      hours += job.audio_duration / 3600
    } else running += d.estimate_usd ?? costOf(3600)
  }
  console.info(
    `backfill: $${billed.toFixed(2)} billed for ${hours.toFixed(1)} h, $${running.toFixed(2)} estimated for jobs not finished, of $${BACKFILL_SPEND_CAP_USD}`,
  )
  process.exit(0)
}

let spent = backfill.reduce((s, d) => s + (d.job_id ? (d.estimate_usd ?? costOf(3600)) : 0), 0)
const todo = backfill
  .filter((d) => !d.job_id)
  .sort((a, b) => b.call_date.localeCompare(a.call_date))
console.info(
  `${todo.length} replays to send; $${spent.toFixed(2)} committed of $${BACKFILL_SPEND_CAP_USD}`,
)
const companies = new Map(curated.companies.map((c) => [c.ticker, c]))
for (const d of todo) {
  const seconds = await estimate(d.url).catch(() => null)
  if (seconds === null) {
    console.warn(`${d.ticker} ${d.call_date}: replay not reachable, skipped`)
    continue
  }
  const cost = costOf(seconds)
  if (spent + cost > BACKFILL_SPEND_CAP_USD) {
    console.warn(`ceiling: $${spent.toFixed(2)} + $${cost.toFixed(2)} would pass it; stopping`)
    break
  }
  if (dryRun) {
    console.info(`${d.ticker} ${d.call_date} ${(seconds / 3600).toFixed(2)} h $${cost.toFixed(2)}`)
    spent += cost
    continue
  }
  const res = await fetch(`${ASSEMBLYAI_API}/v2/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify(transcriptRequest(d.url, companies.get(d.ticker)!)),
  })
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
  if (!res.ok || !body.id) {
    console.warn(`${d.ticker} ${d.call_date}: HTTP ${res.status} ${body.error ?? ''}; stopping`)
    break
  }
  // Written back at once: a rerun after a crash never sends this file again.
  const fresh = await raw()
  const row = fresh.documents.find((x) => x.url === d.url)!
  row.job_id = body.id
  row.submitted_at = new Date().toISOString()
  row.estimate_usd = Math.round(cost * 1e4) / 1e4
  await save(fresh)
  spent += cost
  console.info(
    `${d.ticker} ${d.call_date} sent, $${cost.toFixed(2)}; $${spent.toFixed(2)} committed`,
  )
}
