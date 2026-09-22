import type { FetchSource } from './sources'

// Fetch stage (boundary table: DETERMINISTIC). An HTTP GET against an
// audited URL with retries and the right User-Agent — no judgment, no
// parsing. URLs only ever arrive as FetchSource rows, which
// includeSources() joins from sources.yaml and fixtures/manifest.json; this
// module never composes one.
//
// The body is data. Nothing in it is read here beyond its length.
//
// Two bounds, because the other side of every one of these URLs is somebody
// else's server: each attempt aborts at FETCH_TIMEOUT_MS, and a body over
// MAX_BODY_BYTES is abandoned mid-stream rather than held. Neither is
// configurable — a source that needs either relaxed is a source worth
// looking at.

export type FetchOutcome =
  | { ok: true; status: number; text: string; bytes: number }
  | { ok: false; status: number | null; detail: string }
  // Nothing was attempted: the host wants a credential this deploy does not
  // have. The refresh records it as a 'skipped' run, not a failure.
  | { ok: false; status: null; detail: string; skipped: true }

export type SourceFetcher = (source: FetchSource) => Promise<FetchOutcome>

/** Hosts under SEC's fair-access policy: a request must identify a contact. */
export const SEC_HOSTS: readonly string[] = ['efts.sec.gov', 'data.sec.gov', 'www.sec.gov']

export const SEC_CONTACT_UNSET = 'NUXT_SEC_CONTACT_EMAIL unset'

export const OPENROUTER_KEY_UNSET = 'NUXT_OPENROUTER_API_KEY not set'

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
  /** NUXT_SEC_CONTACT_EMAIL — required by sec.gov, unused elsewhere. */
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
  /** NUXT_OPENROUTER_API_KEY — sent only to openrouter.ai/api/v1/datasets/*. Never logged. */
  openrouterApiKey?: string
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  attempts?: number
}

export const FETCH_ATTEMPTS = 3
/** Waits before attempts 2 and 3. */
export const FETCH_BACKOFF_MS: readonly number[] = [500, 2000]

/**
 * Per attempt, not per fetch. A source that has not answered in this long is
 * not going to, and an unbounded wait ties up the poll tick until the
 * platform kills it — which looks like a hung cron, not a slow vendor.
 */
export const FETCH_TIMEOUT_MS = 30_000

/**
 * Largest body the pipeline will hold. The biggest real source is OpenAI's
 * Ashby job board at ~13.5 MB, so this is roughly a 2x headroom; a Worker
 * isolate has 128 MB and a body also becomes a JS string, so "no cap at all"
 * is one upstream accident away from an OOM the logs cannot explain.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

export const BODY_TOO_LARGE = `body exceeds ${MAX_BODY_BYTES} bytes`

/** A credentialed request will not chase a redirect — see createFetcher. */
export const REDIRECT_REFUSED = 'refused a redirect on a credentialed request'

/**
 * The body, or null when it is over `maxBytes`.
 *
 * Streamed rather than `response.text()`ed so an oversized payload is
 * abandoned mid-flight instead of being materialised first and measured
 * after. `content-length` short-circuits the common case; the stream cap is
 * what covers a chunked response that declares nothing.
 *
 * `bytes` is now what came off the wire rather than the re-encoded length of
 * the decoded text. Those agree for well-formed UTF-8, and where they differ
 * the wire count is the honest one.
 */
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

  const joined = new Uint8Array(bytes)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return { text: new TextDecoder().decode(joined), bytes }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A 429 or any 5xx is worth another try; every other non-2xx is the source's answer. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Build the fetcher the refresh runs with. SEC sources are refused up front
 * when no contact email is configured — never fetched anonymously — and the
 * refusal is a normal 'failed' outcome so it lands in source_runs and the
 * ops digest like any other failure. A keyed OpenRouter dataset without its
 * key is a 'skipped' outcome instead: not configured is a state, not an
 * outage, and the refresh throttles its ops event to one a day.
 */
export function createFetcher(options: FetcherOptions): SourceFetcher {
  const doFetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const attempts = options.attempts ?? FETCH_ATTEMPTS

  return async (source) => {
    const userAgent = userAgentFor(source.url, options)
    if (userAgent === null) return { ok: false, status: null, detail: SEC_CONTACT_UNSET }

    const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: '*/*' }
    // A request that carries a credential does not chase redirects. The header
    // is chosen from the URL we were given, so following a 302 would hand the
    // key to whatever host answered it — the fetch spec strips Authorization
    // across origins, but that is the platform's promise to keep, not ours to
    // depend on for a secret.
    const credentialed = needsOpenRouterKey(source.url)
    if (credentialed) {
      const key = options.openrouterApiKey?.trim() ?? ''
      if (!key) return { ok: false, status: null, detail: OPENROUTER_KEY_UNSET, skipped: true }
      headers.Authorization = `Bearer ${key}`
    }

    let last: FetchOutcome = { ok: false, status: null, detail: 'no attempt made' }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(FETCH_BACKOFF_MS[attempt - 2] ?? FETCH_BACKOFF_MS.at(-1) ?? 0)
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
        last = { ok: false, status: response.status, detail: `HTTP ${response.status}` }
        if (!retryable(response.status)) return last
      } catch (err) {
        last = { ok: false, status: null, detail: `fetch threw: ${String(err)}` }
      }
    }
    return { ...last, detail: `${last.detail} after ${attempts} attempts` }
  }
}
