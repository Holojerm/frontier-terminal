// The pure half of a licensee's S3 access to the licensed bulk bucket
// (terminal-bulk.ts › LICENSED_BUCKET): what scripts/bulk-grant.ts asks the
// Cloudflare API for, and how the answer becomes S3 credentials.
//
// A grant is one account-owned API token with a single policy: R2 object read
// on that one bucket. It can list and get the licensed files and do nothing
// else: no write, no other bucket (so never the raw payloads), no Cloudflare
// API. Its expiry is the key's, so access ends when the key does even if
// nobody runs the revoke. R2 derives S3 credentials from it: the access key id
// is the token's id, the secret is the SHA-256 of the token's value
// (developers.cloudflare.com/r2/api/tokens › Get S3 API credentials).

import { keyRefusal } from './api-key-token'

/**
 * "Workers R2 Storage Bucket Item Read", by id: the API keys policies on ids,
 * and calls the name cosmetic (developers.cloudflare.com/r2/api/tokens).
 */
export const R2_BUCKET_ITEM_READ = {
  id: '6a018a9f2fc74eb6b293b0c548f38b39',
  name: 'Workers R2 Storage Bucket Item Read',
} as const

export const GRANT_ID_SHAPE = /^grant_[0-9a-f]{10}$/

/** The S3 endpoint of the account's R2, for a licensee's client. */
export const r2Endpoint = (accountId: string) => `https://${accountId}.r2.cloudflarestorage.com`

/** The token's access policy: object read on `bucket` and nothing else. */
export function grantPolicies(accountId: string, bucket: string) {
  if (!/^[0-9a-f]{32}$/.test(accountId))
    throw new Error(`not a Cloudflare account id: ${accountId}`)
  return [
    {
      effect: 'allow',
      resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: '*' },
      permission_groups: [{ id: R2_BUCKET_ITEM_READ.id }],
    },
  ]
}

/** The token's name in the dashboard: which key it serves, never who the client is. */
export const grantTokenName = (keyId: string, grantId: string) =>
  `frontier-terminal bulk read ${keyId} ${grantId}`

/** An ISO instant as the API's expires_on wants it: RFC 3339, whole seconds, Z. */
export function expiresOn(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`not an instant: ${iso}`)
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The S3 secret access key R2 derives from a token's value. */
export async function s3SecretOf(tokenValue: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenValue))),
  )
}

export function generateGrantId(): string {
  return `grant_${hex(crypto.getRandomValues(new Uint8Array(5)))}`
}

export interface GrantWithKey {
  id: string
  token_id: string
  revoked_at: string | null
  key_revoked: boolean
  key_expires_at: string
}

/** Live grants whose key no longer opens anything, with why: what a sweep revokes. */
export function staleGrants(
  rows: readonly GrantWithKey[],
  now: Date,
): { grant: GrantWithKey; reason: 'key-revoked' | 'key-expired' }[] {
  const out: { grant: GrantWithKey; reason: 'key-revoked' | 'key-expired' }[] = []
  for (const grant of rows) {
    if (grant.revoked_at !== null) continue
    const refusal = keyRefusal(
      { revoked: grant.key_revoked, expires_at: grant.key_expires_at },
      now,
    )
    if (refusal) out.push({ grant, reason: refusal === 'revoked' ? 'key-revoked' : 'key-expired' })
  }
  return out
}
