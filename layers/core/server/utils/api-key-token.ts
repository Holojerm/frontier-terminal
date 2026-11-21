// The API key itself: how one is minted, hashed, and checked for shape and
// expiry. No database and no Nuxt aliases, so scripts/keys.ts (plain bun) and
// the Worker share one definition of what a key is.
//
// A key is an opaque random token. Only its SHA-256 is stored (api_keys.key_hash),
// so the table grants nothing if it leaks, and a lookup is one indexed read by
// hash. The prefix makes a pasted key recognisable to a secret scanner and lets
// a malformed bearer be refused without a read.

export const API_KEY_TIERS = ['research', 'systematic'] as const
export type ApiKeyTier = (typeof API_KEY_TIERS)[number]

export const API_KEY_PREFIX = 'ftk_'

/** 32 random bytes, base64url: 43 characters after the prefix. */
const KEY_BYTES = 32
const KEY_SHAPE = /^ftk_[A-Za-z0-9_-]{43}$/

export function isApiKeyTier(value: unknown): value is ApiKeyTier {
  return typeof value === 'string' && (API_KEY_TIERS as readonly string[]).includes(value)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateApiKey(): string {
  return API_KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))
}

/** The id a key is listed, revoked and counted under. Not secret. */
export function generateApiKeyId(): string {
  return `key_${hex(crypto.getRandomValues(new Uint8Array(5)))}`
}

export function isApiKeyShape(token: string): boolean {
  return KEY_SHAPE.test(token)
}

export async function hashApiKey(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
}

/** `issued` plus `months` calendar months, as an ISO instant. */
export function expiryAfter(issued: Date, months: number): string {
  const end = new Date(issued)
  end.setUTCMonth(end.getUTCMonth() + months)
  return end.toISOString()
}

/** Why a stored key no longer opens anything, or null while it does. */
export function keyRefusal(
  row: { revoked: boolean; expires_at: string },
  now: Date,
): 'revoked' | 'expired' | null {
  if (row.revoked) return 'revoked'
  if (Date.parse(row.expires_at) <= now.getTime()) return 'expired'
  return null
}
