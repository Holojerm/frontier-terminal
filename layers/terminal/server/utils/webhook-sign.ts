// Webhook secrets and signatures. No database, so
// scripts/webhooks.ts (plain bun) and the Worker sign the same way.
//
// HMAC needs the raw secret at signing time, so storing only a hash of it
// can't work. Instead of storing it encrypted, it is derived: the secret for
// webhook W is HMAC-SHA256(NUXT_WEBHOOK_SIGNING_KEY, "ftwh-secret:v1:" + W).
// D1 holds no secret material at all, only the secret's SHA-256 as a
// fingerprint. Whoever holds the Worker secret can recompute every webhook
// secret, exactly as with encryption under it; rotating it invalidates them
// all, which signing_key_id makes loud (see the webhooks table).

import {
  WEBHOOK_HEADERS,
  WEBHOOK_RETRY_HOURS,
  WEBHOOK_TIMEOUT_SECONDS,
  type WebhookPayload,
} from '../../shared/utils/webhooks'

export const WEBHOOK_SECRET_PREFIX = 'whsec_'

/** The Worker secret's floor, the same as the fleet and judge tokens. */
export const WEBHOOK_SIGNING_KEY_MIN_LENGTH = 32

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

/** Null when the Worker secret is usable, else why not. */
export function signingKeyRefusal(key: string | undefined | null): string | null {
  if (!key) return 'NUXT_WEBHOOK_SIGNING_KEY is not set'
  if (key.length < WEBHOOK_SIGNING_KEY_MIN_LENGTH) {
    return `NUXT_WEBHOOK_SIGNING_KEY must be at least ${WEBHOOK_SIGNING_KEY_MIN_LENGTH} characters`
  }
  return null
}

/** A non-secret name for the Worker secret, stored beside each webhook. */
export async function signingKeyId(key: string): Promise<string> {
  return (await sha256(`ftwh-key-id:${key}`)).slice(0, 12)
}

/** The secret a licensee verifies signatures with. Shown once, by webhooks:add. */
export async function deriveWebhookSecret(key: string, webhookId: string): Promise<string> {
  return WEBHOOK_SECRET_PREFIX + base64url(await hmac(key, `ftwh-secret:v1:${webhookId}`))
}

export async function hashWebhookSecret(secret: string): Promise<string> {
  return sha256(secret)
}

/** `sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>`. */
export async function signWebhookBody(secret: string, body: string): Promise<string> {
  return `sha256=${hex(await hmac(secret, body))}`
}

/** Constant-time check of a signature header, as a receiver would do it. */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  const expected = await signWebhookBody(secret, body)
  if (expected.length !== header.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i)
  return diff === 0
}

/** The id a webhook is listed, tested and removed under. Not secret. */
export function generateWebhookId(): string {
  return `whk_${hex(crypto.getRandomValues(new Uint8Array(5)))}`
}

export const WEBHOOK_ID_SHAPE = /^whk_[0-9a-f]{10}$/

// ── The request ────────────────────────────────────────────────────────────

export interface WebhookRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** The signed POST for one payload. The signature covers the exact bytes sent. */
export async function signedWebhookRequest(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<WebhookRequest> {
  const body = JSON.stringify(payload)
  return {
    url,
    body,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'FrontierTerminal-Webhooks/1 (+https://frontierterm.com/data#webhooks)',
      [WEBHOOK_HEADERS.signature]: await signWebhookBody(secret, body),
      [WEBHOOK_HEADERS.delivery]: payload.delivery_id,
      [WEBHOOK_HEADERS.timestamp]: String(Math.floor(Date.parse(payload.sent_at) / 1000)),
      [WEBHOOK_HEADERS.event]: payload.event,
    },
  }
}

export type WebhookOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string }

export type WebhookSender = (request: WebhookRequest) => Promise<WebhookOutcome>

/**
 * POST with a timeout, never following a redirect: a redirect is how an
 * allowed host would bounce the request somewhere the URL check refused.
 * Any 2xx is delivered; everything else, a timeout included, is a failure.
 */
export function fetchWebhookSender(fetcher: typeof fetch = fetch): WebhookSender {
  return async ({ url, headers, body }) => {
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_SECONDS * 1000),
      })
      await response.body?.cancel()
      if (response.status >= 200 && response.status < 300)
        return { ok: true, status: response.status }
      const error =
        response.status >= 300 && response.status < 400
          ? `HTTP ${response.status}: redirects are not followed`
          : `HTTP ${response.status}`
      return { ok: false, status: response.status, error }
    } catch (error) {
      return { ok: false, status: null, error: String(error).slice(0, 200) }
    }
  }
}

// ── Retry policy ───────────────────────────────────────────────────────────

export const WEBHOOK_RETRY_WINDOW_MS = WEBHOOK_RETRY_HOURS * 3_600_000
const FIRST_RETRY_MS = 5 * 60_000
const MAX_RETRY_MS = 6 * 3_600_000

/**
 * Wait after the `attempt`-th failure (1-based): 5 minutes, doubling, at most
 * 6 hours. Inside the 24-hour window that is about ten attempts.
 */
export function webhookRetryDelayMs(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_MS)
}

/**
 * When to try again after the `attempt`-th failure, or null when that would
 * fall outside the window that opened at `due`: the delivery has failed.
 */
export function nextWebhookAttemptAt(due: Date, attempt: number, now: Date): Date | null {
  const next = new Date(now.getTime() + webhookRetryDelayMs(attempt))
  return next.getTime() > due.getTime() + WEBHOOK_RETRY_WINDOW_MS ? null : next
}
