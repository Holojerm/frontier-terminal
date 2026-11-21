// Sources whose CDN refuses Cloudflare Workers' egress but answers the owner's
// Mac mini: the mini's relay job (scripts/relay-fetch.ts) fetches each URL the
// pipeline asked for and posts the bytes back (/api/relay/*), and the
// pipeline reads that copy instead of the network. Measured 2026-11-21:
// status.mistral.ai answered every Worker poll with 429 for 37 hours and
// www.ercot.com (Imperva) answered 403, while both answered 200 to the mini
// with the same User-Agent.
//
// A copy older than RELAY_MAX_AGE_MS is a failure, not a stale success, so a
// stopped mini shows on fleet as the source failing. Outside the Worker
// (scripts, fixture captures) no store is registered and the fetch goes out
// as usual.

import { z } from 'zod'

import { contentHashOfText } from '../utils/contracts/keys'
import type { FetchOutcome } from '../utils/pipeline-fetch'

const RELAYED_HOSTS: readonly string[] = ['status.mistral.ai', 'www.ercot.com']

/** Both relayed sources are read six-hourly; the job runs every 30 minutes. */
export const RELAY_MAX_AGE_MS = 6 * 3_600_000

/** How long a URL stays on the job's list after the pipeline last asked for it. */
const RELAY_WANT_TTL_S = 3 * 86_400

export const RELAY_MAX_BYTES = 20 * 1024 * 1024

export const RELAY_PENDING = 'relay: no copy from the Mac mini job yet'

export function isRelayed(url: string): boolean {
  try {
    return RELAYED_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

export interface RelayCopy {
  /** The HTTP status the mini got. */
  status: number
  fetched_at: string
  body: Uint8Array
}

export interface RelayStore {
  read(url: string): Promise<RelayCopy | null>
  /** Puts the URL on the job's list (or keeps it there). */
  want(url: string): Promise<void>
}

let registered: RelayStore | null = null

/** Called once per isolate by the Nitro plugin that owns the bindings. */
export function registerRelay(store: RelayStore | null): void {
  registered = store
}

export function activeRelay(): RelayStore | null {
  return registered
}

/** The relayed copy of a URL as bytes, or why there is none to use. */
export async function relayedBytes(
  store: RelayStore,
  url: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; status: number; body: Uint8Array }
  | { ok: false; status: number | null; detail: string; pending?: true }
> {
  await store.want(url)
  const copy = await store.read(url)
  // A URL asked for the first time has no copy until the job's next run.
  if (!copy) return { ok: false, status: null, detail: RELAY_PENDING, pending: true }
  const age = now.getTime() - Date.parse(copy.fetched_at)
  if (!(age <= RELAY_MAX_AGE_MS)) {
    return {
      ok: false,
      status: null,
      detail: `relay: the Mac mini job's copy is from ${copy.fetched_at}, older than ${RELAY_MAX_AGE_MS / 3_600_000}h`,
    }
  }
  if (copy.status < 200 || copy.status >= 300) {
    return {
      ok: false,
      status: copy.status,
      detail: `HTTP ${copy.status} (via the Mac mini relay)`,
    }
  }
  return { ok: true, status: copy.status, body: copy.body }
}

// The store: each copy is two R2 objects, the bytes and what the mini saw, and
// the job's list is KV keys that expire RELAY_WANT_TTL_S after the last ask.

interface RelayBlob {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>
  put(key: string, body: string | Uint8Array, options?: { contentType?: string }): Promise<unknown>
}

interface RelayKv {
  get(key: string): Promise<unknown>
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>
  keys(base?: string): Promise<string[]>
}

const WANT_PREFIX = 'relay:want:'
const copyKey = (url: string) => `relay/${contentHashOfText(url)}`

const CopyMeta = z.object({
  url: z.string(),
  status: z.number().int(),
  fetched_at: z.string(),
})

export function relayStore(blob: RelayBlob, kv: RelayKv): RelayStore {
  return {
    async read(url) {
      const meta = await blob.get(`${copyKey(url)}.json`)
      if (!meta) return null
      const parsed = CopyMeta.safeParse(JSON.parse(await meta.text()))
      if (!parsed.success || parsed.data.url !== url) return null
      const body = await blob.get(`${copyKey(url)}.bin`)
      if (!body) return null
      return { ...parsed.data, body: new Uint8Array(await body.arrayBuffer()) }
    },
    async want(url) {
      await kv.set(`${WANT_PREFIX}${contentHashOfText(url)}`, url, { ttl: RELAY_WANT_TTL_S })
    },
  }
}

/** The URLs the pipeline asked for in the last RELAY_WANT_TTL_S, for the job. */
export async function wantedUrls(kv: RelayKv): Promise<string[]> {
  const urls: string[] = []
  for (const key of await kv.keys(WANT_PREFIX)) {
    const url = await kv.get(key)
    if (typeof url === 'string' && isRelayed(url)) urls.push(url)
  }
  return [...new Set(urls)].sort()
}

/** Keeps the job's copy of one URL. The bytes land first, so a reader never sees new metadata on old bytes. */
export async function putRelayCopy(
  blob: RelayBlob,
  copy: RelayCopy & { url: string; contentType: string },
): Promise<void> {
  await blob.put(`${copyKey(copy.url)}.bin`, copy.body, { contentType: copy.contentType })
  const meta = { url: copy.url, status: copy.status, fetched_at: copy.fetched_at }
  await blob.put(`${copyKey(copy.url)}.json`, JSON.stringify(meta), {
    contentType: 'application/json',
  })
}

/** The relayed copy as the fetcher's outcome. */
export async function relayedOutcome(store: RelayStore, url: string): Promise<FetchOutcome> {
  const got = await relayedBytes(store, url)
  if (!got.ok) {
    // Pending is a wait, not an outage: the refresh records it as skipped.
    return got.pending
      ? { ok: false, status: null, detail: got.detail, skipped: true }
      : { ok: false, status: got.status, detail: got.detail }
  }
  return {
    ok: true,
    status: got.status,
    text: new TextDecoder().decode(got.body),
    bytes: got.body.byteLength,
  }
}
