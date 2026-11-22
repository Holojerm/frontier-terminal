import {
  activeRelay,
  isRelayed,
  onRefusal,
  relayedOutcome,
  relaysOnRefusal,
  type RelayStore,
} from '../pipeline/relay'
import type { FetchSource } from './pipeline-sources'

// Fetch stage (boundary table: DETERMINISTIC): an HTTP GET with retries and the
// right User-Agent, no parsing. URLs arrive only as FetchSource rows from
// includeSources(); this module never composes one. The body is data. Each
// attempt aborts at FETCH_TIMEOUT_MS and a body over MAX_BODY_BYTES is abandoned
// mid-stream; neither is configurable, since a source needing more is worth a look.

export type FetchOutcome =
  | { ok: true; status: number; text: string; bytes: number }
  | {
      ok: false
      status: number | null
      detail: string
      /** On a 429 only: the server's Retry-After, when it sent a usable one. */
      retryAfterMs?: number
    }
  // Nothing was attempted: the host wants a credential this deploy does not
  // have. The refresh records it as a 'skipped' run, not a failure.
  | { ok: false; status: null; detail: string; skipped: true }

export type SourceFetcher = (source: FetchSource) => Promise<FetchOutcome>

/** Hosts under SEC's fair-access policy: a request must identify a contact. */
export const SEC_HOSTS: readonly string[] = ['efts.sec.gov', 'data.sec.gov', 'www.sec.gov']

export const SEC_CONTACT_UNSET = 'NUXT_SEC_CONTACT_EMAIL unset'

export const OPENROUTER_KEY_UNSET = 'NUXT_OPENROUTER_API_KEY not set'
export const GITHUB_TOKEN_UNSET = 'NUXT_GITHUB_TOKEN not set'

/** GitHub's search API: anonymous calls share a per-IP limit a Worker's egress cannot own. */
export function needsGithubToken(url: string): boolean {
  const u = new URL(url)
  return u.hostname === 'api.github.com' && u.pathname.startsWith('/search/')
}

/** OpenRouter's dataset endpoints (the usage rankings) take a bearer key;
 * its public model list does not and is fetched as audited, anonymously. */
export function needsOpenRouterKey(url: string): boolean {
  const u = new URL(url)
  return u.hostname === 'openrouter.ai' && u.pathname.startsWith('/api/v1/datasets/')
}

export function isSecHost(url: string): boolean {
  return SEC_HOSTS.includes(new URL(url).hostname)
}

export interface UserAgentOptions {
  /** NUXT_SEC_CONTACT_EMAIL: required by sec.gov, unused elsewhere. */
  secContactEmail: string
  /** The site's public origin, so a webmaster can see who is fetching. */
  appUrl: string
}

/**
 * The User-Agent for a URL, or null when the host requires one we cannot
 * honestly send. SEC asks for "Company Name contact@example.com"
 * (https://www.sec.gov/os/accessing-edgar-data); everyone else gets a
 * browser-style string naming the project and where it lives.
 */
export function userAgentFor(url: string, options: UserAgentOptions): string | null {
  if (isSecHost(url)) {
    const email = options.secContactEmail.trim()
    return email ? `FrontierTerminal ${email}` : null
  }
  return `Mozilla/5.0 (compatible; FrontierTerminal/1.0; +${options.appUrl})`
}

export interface FetcherOptions extends UserAgentOptions {
  /** NUXT_OPENROUTER_API_KEY: sent only to openrouter.ai/api/v1/datasets/*. Never logged. */
  openrouterApiKey?: string
  /** NUXT_GITHUB_TOKEN: sent only to api.github.com/search/*. Never logged. */
  githubToken?: string
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  /** Where relayed hosts are read from; defaults to the one the Worker registered (relay.ts). */
  relay?: RelayStore | null
}

export const FETCH_ATTEMPTS = 3
/** Waits before attempts 2 and 3. */
export const FETCH_BACKOFF_MS: readonly number[] = [500, 2000]

/**
 * Per attempt, not per fetch. A source that has not answered in this long is
 * not going to, and an unbounded wait ties up the poll tick until the
 * platform kills it, which looks like a hung cron, not a slow vendor.
 */
export const FETCH_TIMEOUT_MS = 30_000

/**
 * Largest body the pipeline will hold. The biggest real source is Google's
 * careers feed at ~20 MB, which runs on a tick of its own for that reason
 * (layers/talent/server/pipeline/scopes.ts › CAREERS_SOURCES); OpenAI's Ashby board is next at ~13.5 MB.
 * A Worker isolate has 128 MB and a body also becomes a JS string, so "no cap
 * at all" is one upstream accident away from an OOM the logs cannot explain.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

export const BODY_TOO_LARGE = `body exceeds ${MAX_BODY_BYTES} bytes`

/** A credentialed request will not chase a redirect (see createFetcher). */
export const REDIRECT_REFUSED = 'refused a redirect on a credentialed request'

/**
 * The body, or null when it is over `maxBytes`. Streamed so an oversized body
 * is abandoned mid-flight, not materialised first; `content-length`
 * short-circuits the common case and the stream cap covers chunked responses.
 * `bytes` is the wire count.
 */
const EMPTY = new Uint8Array(0)

export async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number } | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null

  if (!response.body) {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text).byteLength
    return bytes > maxBytes ? null : { text, bytes }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  // Each chunk is let go as it is copied, so a 20 MB body is not held twice
  // over while it is joined.
  const joined = new Uint8Array(bytes)
  let at = 0
  for (let i = 0; i < chunks.length; i++) {
    joined.set(chunks[i]!, at)
    at += chunks[i]!.byteLength
    chunks[i] = EMPTY
  }
  chunks.length = 0
  return { text: new TextDecoder().decode(joined), bytes }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every 5xx is worth another try; every other non-2xx is the source's answer. */
function retryable(status: number): boolean {
  return status >= 500
}

/**
 * A 429 is not retried in the tick: the 500 ms and 2 s backoffs are far
 * shorter than any limiter's window, so retrying only spends the quota that
 * is already gone. The refresh backs the source off for a cooldown instead
 * (refresh.ts). The one exception is a Retry-After short enough to sit out
 * inside the tick.
 */
export const RATE_LIMIT_MAX_INLINE_WAIT_MS = 5_000

/** The `HTTP 429` detail prefix the refresh keys its cooldown and alert policy on. */
export const RATE_LIMITED_DETAIL = 'HTTP 429'

/** Retry-After as milliseconds: delay-seconds or an HTTP date; null when absent or unusable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  const value = header?.trim()
  if (!value) return null
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) ? Math.max(0, ms) : null
}

/**
 * GitHub answers its primary and secondary rate limits with a 403 as often as
 * a 429, marked by Retry-After or an exhausted x-ratelimit-remaining
 * (docs.github.com, "Rate limits for the REST API"). Such a 403 is the
 * limiter, not a refusal, so it follows the 429 policy.
 */
export function isGithubRateLimit(url: string, response: Response): boolean {
  if (response.status !== 403 || new URL(url).hostname !== 'api.github.com') return false
  return (
    response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
  )
}

/**
 * Build the fetcher the refresh runs with. SEC sources without a contact email
 * are refused (never fetched anonymously) as a 'failed' outcome; a keyed
 * OpenRouter dataset without its key is 'skipped', a config state whose ops
 * event the refresh throttles to one a day.
 */
export function createFetcher(options: FetcherOptions): SourceFetcher {
  const doFetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const attempts = options.attempts ?? FETCH_ATTEMPTS

  const direct: SourceFetcher = async (source) => {
    const userAgent = userAgentFor(source.url, options)
    if (userAgent === null) return { ok: false, status: null, detail: SEC_CONTACT_UNSET }

    const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: '*/*' }
    // A request that carries a credential does not chase redirects. The header
    // is chosen from the URL we were given, so following a 302 would hand the
    // key to whatever host answered it. The fetch spec strips Authorization
    // across origins, but that is the platform's promise, not one to depend on
    // for a secret.
    const openrouter = needsOpenRouterKey(source.url)
    const github = needsGithubToken(source.url)
    const credentialed = openrouter || github
    if (openrouter) {
      const key = options.openrouterApiKey?.trim() ?? ''
      if (!key) return { ok: false, status: null, detail: OPENROUTER_KEY_UNSET, skipped: true }
      headers.Authorization = `Bearer ${key}`
    }
    if (github) {
      const token = options.githubToken?.trim() ?? ''
      if (!token) return { ok: false, status: null, detail: GITHUB_TOKEN_UNSET, skipped: true }
      headers.Authorization = `Bearer ${token}`
      headers.Accept = 'application/vnd.github+json'
    }

    let last: FetchOutcome = { ok: false, status: null, detail: 'no attempt made' }
    let waited = false
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1 && !waited) {
        await sleep(FETCH_BACKOFF_MS[attempt - 2] ?? FETCH_BACKOFF_MS.at(-1) ?? 0)
      }
      waited = false
      try {
        const response = await doFetch(source.url, {
          headers,
          redirect: credentialed ? 'manual' : 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (response.ok) {
          const body = await readCappedBody(response, MAX_BODY_BYTES)
          // Not retryable: a source that is too big now will be too big again,
          // and three attempts at it is three times the bandwidth for the same
          // answer. It lands in source_runs and the ops digest as a failure.
          if (!body) return { ok: false, status: response.status, detail: BODY_TOO_LARGE }
          return { ok: true, status: response.status, text: body.text, bytes: body.bytes }
        }
        if (credentialed && response.status >= 300 && response.status < 400) {
          return { ok: false, status: response.status, detail: REDIRECT_REFUSED }
        }
        const githubLimit = isGithubRateLimit(source.url, response)
        if (response.status === 429 || githubLimit) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
          const notes = [
            githubLimit ? `GitHub’s ${response.status} rate limit` : null,
            retryAfterMs === null ? null : `Retry-After ${Math.ceil(retryAfterMs / 1000)}s`,
          ].filter((note) => note !== null)
          last = {
            ok: false,
            status: 429,
            detail: notes.length
              ? `${RATE_LIMITED_DETAIL} (${notes.join(', ')})`
              : RATE_LIMITED_DETAIL,
            ...(retryAfterMs === null ? {} : { retryAfterMs }),
          }
          if (retryAfterMs === null || retryAfterMs > RATE_LIMIT_MAX_INLINE_WAIT_MS) return last
          // Short enough to honour here; it replaces the loop's own backoff,
          // but never undercuts it: npm answers "Retry-After: 0" and then
          // 429s again, so a zero wait is three requests in one instant.
          await sleep(Math.max(retryAfterMs, FETCH_BACKOFF_MS[attempt - 1] ?? 0))
          waited = true
          continue
        }
        last = { ok: false, status: response.status, detail: `HTTP ${response.status}` }
        if (!retryable(response.status)) return last
      } catch (err) {
        last = { ok: false, status: null, detail: `fetch threw: ${String(err)}` }
      }
    }
    return { ...last, detail: `${last.detail} after ${attempts} attempts` }
  }

  return async (source) => {
    const relay = options.relay ?? activeRelay()
    if (relay && isRelayed(source.url)) return relayedOutcome(relay, source.url)
    const outcome = await direct(source)
    return relay && relaysOnRefusal(source.url) ? onRefusal(relay, source.url, outcome) : outcome
  }
}
