import type { FetchSource } from './sources'

// Fetch stage (boundary table: DETERMINISTIC). An HTTP GET against an
// audited URL with retries and the right User-Agent — no judgment, no
// parsing. URLs only ever arrive as FetchSource rows, which
// includeSources() joins from sources.yaml and fixtures/manifest.json; this
// module never composes one.
//
// The body is data. Nothing in it is read here beyond its length.

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
    if (needsOpenRouterKey(source.url)) {
      const key = options.openrouterApiKey?.trim() ?? ''
      if (!key) return { ok: false, status: null, detail: OPENROUTER_KEY_UNSET, skipped: true }
      headers.Authorization = `Bearer ${key}`
    }

    let last: FetchOutcome = { ok: false, status: null, detail: 'no attempt made' }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(FETCH_BACKOFF_MS[attempt - 2] ?? FETCH_BACKOFF_MS.at(-1) ?? 0)
      try {
        const response = await doFetch(source.url, { headers, redirect: 'follow' })
        if (response.ok) {
          const text = await response.text()
          return {
            ok: true,
            status: response.status,
            text,
            bytes: new TextEncoder().encode(text).byteLength,
          }
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
