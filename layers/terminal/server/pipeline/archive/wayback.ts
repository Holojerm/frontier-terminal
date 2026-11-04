// The Internet Archive's Wayback Machine, read politely: one request at a
// time, a pause between requests, a User-Agent naming this site, and a
// back-off on 429/5xx. The CDX API lists the captures of a URL; the `id_`
// replay flag returns a capture's archived bytes without the Wayback toolbar
// or rewritten links. Terms and rate verdict: sources.yaml › archive_recipes ›
// wayback-pricing, docs/source-audit.md › Internet Archive.

import { readCappedBody } from '../fetch'

export const WAYBACK_USER_AGENT =
  'FrontierTerminal/1.0 (+https://frontierterm.com; one-off price-history backfill from the Wayback Machine)'

/** The pause between any two requests to archive.org. ~15 a minute at most. */
export const WAYBACK_PACE_MS = 4_000

/** Waits after a 429 or 5xx before the next attempt; the last failure is recorded, not retried forever. */
export const WAYBACK_BACKOFF_MS: readonly number[] = [30_000, 120_000, 300_000]

/**
 * Largest capture the backfill will hold. The biggest archived pricing page
 * (docs.anthropic.com, 2025) is ~2.1 MB; anything far past that is not a
 * pricing page and is skipped with its reason.
 */
export const WAYBACK_MAX_BYTES = 6 * 1024 * 1024

export interface CdxCapture {
  /** 14 digits, yyyyMMddhhmmss, UTC. */
  timestamp: string
  original: string
  digest: string
}

/**
 * The CDX query for one URL's 200 captures in [from, until): one row per
 * content digest change (collapse=digest drops adjacent repeats).
 */
export function cdxUrl(url: string, from: string, until: string): string {
  const q = new URLSearchParams({
    url,
    output: 'json',
    fl: 'timestamp,original,digest',
    filter: 'statuscode:200',
    collapse: 'digest',
    from: waybackStamp(from),
    to: waybackStamp(new Date(Date.parse(until) - 1000).toISOString()),
  })
  return `https://web.archive.org/cdx/search/cdx?${q}`
}

/** CDX JSON (a header row, then rows) as captures. Throws on any other shape. */
export function parseCdx(body: string): CdxCapture[] {
  const trimmed = body.trim()
  if (trimmed === '') return []
  const rows = JSON.parse(trimmed) as unknown
  if (!Array.isArray(rows)) throw new Error('CDX: not a JSON array')
  const [header, ...rest] = rows as string[][]
  if (!header) return []
  const at = (name: string) => {
    const i = header.indexOf(name)
    if (i === -1) throw new Error(`CDX: no ${name} column`)
    return i
  }
  const [t, o, d] = [at('timestamp'), at('original'), at('digest')]
  return rest.map((r) => {
    if (!/^\d{14}$/.test(r[t] ?? '')) throw new Error(`CDX: bad timestamp ${r[t]}`)
    return { timestamp: r[t]!, original: r[o]!, digest: r[d]! }
  })
}

/** 20240531225017 -> 2024-05-31T22:50:17.000Z */
export function captureInstant(timestamp: string): string {
  const m = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) throw new Error(`not a Wayback timestamp: ${timestamp}`)
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString()
}

/** An ISO instant as a 14-digit Wayback timestamp. */
export function waybackStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** The raw archived bytes of one capture: `id_` asks for them unrewritten. */
export function captureUrl(timestamp: string, original: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${original}`
}

/**
 * One capture per `cadenceDays`: the first capture of each window, walking
 * forward from the earliest. The CDX list is one row per digest change, but
 * a page that re-renders a nonce or a build id changes digest daily, so the
 * plan samples rather than fetching every row. A price change therefore
 * lands at the first sampled capture that shows it, at most `cadenceDays`
 * after it happened; the read side says so.
 */
export function sampleCaptures(captures: readonly CdxCapture[], cadenceDays: number): CdxCapture[] {
  const sorted = [...captures].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
  const out: CdxCapture[] = []
  let next = -Infinity
  for (const c of sorted) {
    const t = Date.parse(captureInstant(c.timestamp))
    if (t < next) continue
    out.push(c)
    next = t + cadenceDays * 86_400_000
  }
  return out
}

export type WaybackResult =
  | { ok: true; status: number; text: string; bytes: number; finalUrl: string }
  | { ok: false; detail: string }

export interface WaybackClient {
  /** One paced GET to archive.org, following redirects only within web.archive.org. */
  get(url: string): Promise<WaybackResult>
}

export interface WaybackClientOptions {
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  paceMs?: number
  backoffMs?: readonly number[]
  maxBytes?: number
  log?: (line: string) => void
}

const MAX_REDIRECTS = 5

/**
 * A client that never has two requests in flight and waits `paceMs` between
 * any two. Redirects are followed by hand, because a capture's redirect can
 * point at another host's capture (or at plain http), and following one
 * blindly would read a page we didn't ask for. The caller checks finalUrl.
 */
export function waybackClient(options: WaybackClientOptions = {}): WaybackClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const pace = options.paceMs ?? WAYBACK_PACE_MS
  const backoff = options.backoffMs ?? WAYBACK_BACKOFF_MS
  const maxBytes = options.maxBytes ?? WAYBACK_MAX_BYTES
  let last = 0

  const once = async (url: string): Promise<Response> => {
    const wait = last + pace - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await fetchImpl(url, {
        headers: { 'User-Agent': WAYBACK_USER_AGENT, Accept: '*/*' },
        redirect: 'manual',
      })
    } finally {
      last = Date.now()
    }
  }

  return {
    async get(url) {
      let current = url
      for (let attempt = 0; ; attempt++) {
        let response: Response
        try {
          response = await once(current)
        } catch (error) {
          if (attempt < backoff.length) {
            options.log?.(`network error on ${current}; waiting ${backoff[attempt]! / 1000}s`)
            await sleep(backoff[attempt]!)
            continue
          }
          return { ok: false, detail: `network error: ${String(error)}` }
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location) return { ok: false, detail: `HTTP ${response.status} without Location` }
          const next = new URL(location, current)
          if (next.hostname !== 'web.archive.org') {
            return { ok: false, detail: `redirected off the Archive to ${next.href}` }
          }
          next.protocol = 'https:'
          if (attempt >= MAX_REDIRECTS) return { ok: false, detail: 'too many redirects' }
          current = next.href
          continue
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel()
          if (attempt < backoff.length) {
            options.log?.(
              `HTTP ${response.status} on ${current}; waiting ${backoff[attempt]! / 1000}s`,
            )
            await sleep(backoff[attempt]!)
            continue
          }
          return { ok: false, detail: `HTTP ${response.status} after ${backoff.length} retries` }
        }
        const body = await readCappedBody(response, maxBytes)
        if (body === null) return { ok: false, detail: `body exceeds ${maxBytes} bytes` }
        return { ok: true, status: response.status, ...body, finalUrl: current }
      }
    },
  }
}

/**
 * Whether a replayed capture is the page we asked for: the final Wayback URL
 * must still name the same original URL (scheme, `www.`, and a trailing slash
 * aside). The Archive answers a timestamp with the nearest capture, which can
 * be a redirect to another page entirely.
 */
export function sameOriginal(finalUrl: string, original: string): boolean {
  const m = finalUrl.match(/^https:\/\/web\.archive\.org\/web\/\d{14}id_\/(.+)$/)
  if (!m) return false
  const norm = (u: string) =>
    u
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/:80\//, '/')
      .replace(/\/$/, '')
      .toLowerCase()
  return norm(m[1]!) === norm(original)
}

/** The 14-digit timestamp a final Wayback URL names. */
export function finalTimestamp(finalUrl: string): string | null {
  return finalUrl.match(/^https:\/\/web\.archive\.org\/web\/(\d{14})id_\//)?.[1] ?? null
}
