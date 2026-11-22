// Sources that refuse Workers' egress but answer the owner's Mac mini
// (status.mistral.ai 429s, www.ercot.com's Imperva 403s, www.customs.go.kr never
// answers the connection: a 522; all 200 to the mini).
// The mini's relay job (scripts/relay-fetch.ts) fetches each URL the pipeline
// asks for and posts the bytes to /api/relay/*, and the pipeline reads that
// copy. A copy older than RELAY_MAX_AGE_MS is a failure, so a stopped mini shows
// on fleet. A URL read once (a release, a report) is taken off the job's list by
// its reader (`done`), or the job would fetch it every run for RELAY_WANT_TTL_S.
// A host on RELAY_ON_REFUSAL_HOSTS is fetched directly, and only a 403 asks the
// job for a copy (pipeline-fetch.ts); the next direct 200 takes the URL off its list.
// Outside the Worker no store is registered and fetches go out as usual.

import { z } from 'zod'

import { contentHashOfText } from '../utils/contracts/keys'
import type { FetchOutcome } from '../utils/pipeline-fetch'

const RELAYED_HOSTS: readonly string[] = ['status.mistral.ai', 'www.ercot.com', 'www.customs.go.kr']

/**
 * Hosts that answer the Worker but turn it away for hours at a time. OpenAI's
 * docs host 403'd every per-model page on the 00:00 and 06:00 UTC surveys of
 * 2026-11-22 after ten clean days, while its catalog and pricing pages kept
 * answering, and let the Worker back by 12:00 (#698).
 */
const RELAY_ON_REFUSAL_HOSTS: readonly string[] = ['developers.openai.com']

export const RELAY_MAX_AGE_MS = 6 * 3_600_000

/** How long a URL stays on the job's list after its entry was last written. */
const RELAY_WANT_TTL_S = 3 * 86_400
/**
 * An entry is written again only once it is this old. KV allows one write a
 * second to a key, and a reader that is done with a URL deletes its entry
 * moments after asking for it.
 */
const RELAY_WANT_REFRESH_MS = 86_400_000

export const RELAY_MAX_BYTES = 20 * 1024 * 1024

export const RELAY_PENDING = 'relay: no copy from the Mac mini job yet'

function hostIn(hosts: readonly string[], url: string): boolean {
  try {
    return hosts.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Always read from the job's copy. */
export function isRelayed(url: string): boolean {
  return hostIn(RELAYED_HOSTS, url)
}

/** Fetched directly; the job's copy stands in when the host answers 403. */
export function relaysOnRefusal(url: string): boolean {
  return hostIn(RELAY_ON_REFUSAL_HOSTS, url)
}

/** Whether the job may be sent, and post back, this URL. */
export function isRelayHost(url: string): boolean {
  return isRelayed(url) || relaysOnRefusal(url)
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
  /** Whether the URL is on the job's list. */
  wanted(url: string): Promise<boolean>
  /**
   * Takes URLs that have been read for good off the job's list and drops their
   * copies, so asking again later waits for a new copy instead of failing on the old one.
   */
  done(urls: readonly string[]): Promise<void>
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
// the job's list is KV keys that expire RELAY_WANT_TTL_S after their last write.

interface RelayBlob {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>
  put(key: string, body: string | Uint8Array, options?: { contentType?: string }): Promise<unknown>
  del(keys: string[]): Promise<unknown>
}

interface RelayKv {
  get(key: string): Promise<unknown>
  set(key: string, value: WantEntry, options?: { ttl?: number }): Promise<void>
  del(key: string): Promise<unknown>
  keys(base?: string): Promise<string[]>
}

const Want = z.object({ url: z.string(), asked_at: z.string() })
type WantEntry = z.infer<typeof Want>

const WANT_PREFIX = 'relay:want:'
const wantKey = (url: string) => `${WANT_PREFIX}${contentHashOfText(url)}`
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
      const held = Want.safeParse(await kv.get(wantKey(url)))
      const age = held.success ? Date.now() - Date.parse(held.data.asked_at) : Infinity
      if (age < RELAY_WANT_REFRESH_MS) return
      const entry = { url, asked_at: new Date().toISOString() }
      await kv.set(wantKey(url), entry, { ttl: RELAY_WANT_TTL_S })
    },
    async wanted(url) {
      return (await kv.get(wantKey(url))) != null
    },
    async done(urls) {
      if (urls.length === 0) return
      for (const url of urls) await kv.del(wantKey(url))
      // The metadata goes first: a copy without it reads as no copy.
      await blob.del(urls.map((url) => `${copyKey(url)}.json`))
      await blob.del(urls.map((url) => `${copyKey(url)}.bin`))
    },
  }
}

/** The URLs on the job's list. An entry written before 2026-11-22 is the bare URL. */
export async function wantedUrls(kv: RelayKv): Promise<string[]> {
  const urls: string[] = []
  for (const key of await kv.keys(WANT_PREFIX)) {
    const held = await kv.get(key)
    const url = typeof held === 'string' ? held : Want.safeParse(held).data?.url
    if (url && isRelayHost(url)) urls.push(url)
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

/**
 * A direct fetch of a RELAY_ON_REFUSAL_HOSTS URL, settled against the job's
 * copy. A 403 asks for a copy and serves a usable one; without one the 403
 * stands, with why there is no copy, so the refresh still treats the run as
 * refused. A direct 2xx takes the URL off the job's list.
 */
export async function onRefusal(
  store: RelayStore,
  url: string,
  direct: FetchOutcome,
): Promise<FetchOutcome> {
  if (direct.ok) {
    if (await store.wanted(url)) await store.done([url])
    return direct
  }
  if (direct.status !== 403) return direct
  const got = await relayedBytes(store, url)
  if (!got.ok) return { ...direct, detail: `${direct.detail}; ${got.detail}` }
  return bytesOutcome(got.status, got.body)
}

function bytesOutcome(status: number, body: Uint8Array): FetchOutcome {
  return { ok: true, status, text: new TextDecoder().decode(body), bytes: body.byteLength }
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
  return bytesOutcome(got.status, got.body)
}
