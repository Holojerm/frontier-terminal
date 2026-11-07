#!/usr/bin/env bun
// S3 read access to the licensed bulk bucket, per licensee key, granted by
// the owner. Never self-serve, like the keys themselves (scripts/keys.ts).
//
//   bun run bulk:grant -- --key key_0a1b2c3d4e --remote
//   bun run bulk:grant -- --key key_0a1b2c3d4e --revoke --remote
//   bun run bulk:grant -- --sweep --remote     # revoke grants whose key was revoked or expired
//   bun run bulk:grants [-- --remote]          # list
//
// A grant mints one account-owned Cloudflare API token that can read the
// objects of LICENSED_BUCKET and nothing else, expiring with the key
// (layers/terminal/server/utils/bulk-grant.ts), and records it in D1
// (bulk_grants). keys:revoke revokes a key's grants too.
//
// Minting a token needs a token that may manage tokens, which the `cf` login
// is not. Pass one in BULK_GRANT_API_TOKEN for this command only, e.g.
//   BULK_GRANT_API_TOKEN="$(op read 'op://…')" bun run bulk:grant -- …
// It goes to the `cf` child process and nowhere else: not to wrangler (which
// would try it against D1), not to a log. The account id comes from
// CLOUDFLARE_ACCOUNT_ID or, failing that, the `cf` login's only account.
//
// The S3 secret is printed once, on stdout, and never stored: Cloudflare
// keeps the token, D1 keeps its id. Everything else goes to stderr, so
// `bun run bulk:grant -- … | pbcopy` copies the credentials alone.

import {
  GRANT_ID_SHAPE,
  expiresOn,
  generateGrantId,
  grantPolicies,
  grantTokenName,
  r2Endpoint,
  s3SecretOf,
  staleGrants,
} from '../layers/terminal/server/utils/bulk-grant'
import { LICENSED_BUCKET } from '../layers/terminal/shared/utils/institutional'
import { ROOT, fail, lit, parseArgs, runSql } from './lib/d1-cli'

const KEY_ID_SHAPE = /^key_[0-9a-f]{10}$/

function accountId(): string {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID
  if (fromEnv) return fromEnv
  const result = Bun.spawnSync(['cf', 'accounts', 'list'], { cwd: ROOT, stderr: 'pipe' })
  if (result.exitCode !== 0)
    fail('`cf accounts list` failed. Run `cf auth login`, or set CLOUDFLARE_ACCOUNT_ID.')
  const accounts = JSON.parse(result.stdout.toString()) as { id: string }[]
  if (accounts.length !== 1) fail('The cf login sees several accounts. Set CLOUDFLARE_ACCOUNT_ID.')
  return accounts[0]!.id
}

/** `cf <args>` as the token manager, and its JSON result. Stdout is never echoed: it holds the token. */
function cfAsTokenManager(account: string, args: string[]): Record<string, unknown> {
  const token = process.env.BULK_GRANT_API_TOKEN
  if (!token) {
    fail(
      'Set BULK_GRANT_API_TOKEN to a token with Account API Tokens: Edit for this command (see the header of scripts/bulk-grant.ts).',
    )
  }
  const result = Bun.spawnSync(['cf', ...args], {
    cwd: ROOT,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
    stderr: 'pipe',
  })
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error(`cf ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || 'no output'}`)
  }
  const out = result.stdout.toString().trim()
  try {
    return out ? (JSON.parse(out) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

interface KeyRow {
  id: string
  client: string
  revoked: number | boolean
  expires_at: string
}

async function grant(flags: Map<string, string | true>, remote: boolean) {
  const keyId = flags.get('key')
  if (typeof keyId !== 'string' || !KEY_ID_SHAPE.test(keyId))
    fail('--key key_<10 hex> is required.')
  if (!remote)
    fail('A grant mints a real Cloudflare token, so it is recorded in production: add --remote.')
  const [key] = runSql(
    remote,
    `SELECT id, client, revoked, expires_at FROM api_keys WHERE id = ${lit(keyId)}`,
  ) as unknown as KeyRow[]
  if (!key) fail(`No key ${keyId}.`)
  if (Boolean(key.revoked)) fail(`${keyId} is revoked.`)
  if (Date.parse(key.expires_at) <= Date.now())
    fail(`${keyId} expired on ${key.expires_at.slice(0, 10)}.`)

  const account = accountId()
  const id = generateGrantId()
  // The row goes in first, as pending, and the token's name carries the grant
  // id: a run that dies between the two leaves a pending row naming the token,
  // never a live token nothing records.
  runSql(
    remote,
    `INSERT INTO bulk_grants (id, api_key_id, token_id, bucket, created_at, expires_at, revoked_at, revoke_reason) VALUES (${[
      lit(id),
      lit(keyId),
      lit(`pending:${id}`),
      lit(LICENSED_BUCKET),
      lit(new Date().toISOString()),
      lit(key.expires_at),
      'NULL',
      'NULL',
    ].join(', ')}) RETURNING id`,
  )
  let created: Record<string, unknown>
  try {
    created = cfAsTokenManager(account, [
      'accounts',
      'tokens',
      'create',
      '--name',
      grantTokenName(keyId, id),
      '--expires-on',
      expiresOn(key.expires_at),
      '--policies',
      JSON.stringify(grantPolicies(account, LICENSED_BUCKET)),
    ])
  } catch (error) {
    runSql(remote, `DELETE FROM bulk_grants WHERE id = ${lit(id)} RETURNING id`)
    fail(String(error))
  }
  const tokenId = created.id
  const value = created.value
  if (typeof tokenId !== 'string' || typeof value !== 'string') {
    fail(
      `The Cloudflare API answered without a token id and value. Check the dashboard for a token named "${grantTokenName(keyId, id)}" and delete it, then the pending row ${id}.`,
    )
  }
  runSql(
    remote,
    `UPDATE bulk_grants SET token_id = ${lit(tokenId)} WHERE id = ${lit(id)} RETURNING id`,
  )

  console.error(
    `Granted ${id}: S3 read on ${LICENSED_BUCKET} for ${keyId} (${key.client}), expiring with the key on ${key.expires_at.slice(0, 10)}.\n`,
  )
  console.log(
    [
      `AWS_ACCESS_KEY_ID=${tokenId}`,
      `AWS_SECRET_ACCESS_KEY=${await s3SecretOf(value)}`,
      `AWS_ENDPOINT_URL=${r2Endpoint(account)}`,
      'AWS_REGION=auto',
      `BUCKET=${LICENSED_BUCKET}`,
    ].join('\n'),
  )
  console.error(
    '\nThis is the only time the secret is shown. Deliver it with the API key, securely (a 1Password share link). Never in plain email or chat.\n' +
      `Revoke with: bun run bulk:grant -- --key ${keyId} --revoke --remote (keys:revoke does it too).`,
  )
}

interface GrantRow {
  id: string
  token_id: string
}

/** Delete each live grant's token, then mark it revoked. A token Cloudflare no longer has counts as deleted. */
export function revokeGrants(
  remote: boolean,
  where: string,
  reason: 'owner' | 'key-revoked' | 'key-expired',
): string[] {
  const rows = runSql(
    remote,
    `SELECT id, token_id FROM bulk_grants WHERE revoked_at IS NULL AND (${where})`,
  ) as unknown as GrantRow[]
  if (rows.length === 0) return []
  const account = accountId()
  // A pending row never got a token (scripts/bulk-grant.ts › grant).
  const revoked: string[] = []
  for (const row of rows) {
    try {
      if (!row.token_id.startsWith('pending:')) {
        cfAsTokenManager(account, ['accounts', 'tokens', 'delete', row.token_id])
      }
    } catch (error) {
      if (!/not.?found|404/i.test(String(error))) throw error
    }
    runSql(
      remote,
      `UPDATE bulk_grants SET revoked_at = ${lit(new Date().toISOString())}, revoke_reason = ${lit(reason)} WHERE id = ${lit(row.id)} AND revoked_at IS NULL RETURNING id`,
    )
    revoked.push(row.id)
  }
  return revoked
}

/** How many live grants `keyId` has, for keys:revoke. */
export function liveGrantCount(remote: boolean, keyId: string): number {
  const [row] = runSql(
    remote,
    `SELECT count(*) AS n FROM bulk_grants WHERE revoked_at IS NULL AND api_key_id = ${lit(keyId)}`,
  )
  return Number(row?.n ?? 0)
}

function revoke(flags: Map<string, string | true>, remote: boolean) {
  const keyId = flags.get('key')
  const grantId = flags.get('grant')
  if (typeof grantId === 'string') {
    if (!GRANT_ID_SHAPE.test(grantId)) fail('--grant grant_<10 hex>.')
    const done = revokeGrants(remote, `id = ${lit(grantId)}`, 'owner')
    if (!done.length) fail(`No live grant ${grantId}.`)
    console.error(`Revoked ${grantId}. Its S3 credentials stop working within a minute.`)
    return
  }
  if (typeof keyId !== 'string' || !KEY_ID_SHAPE.test(keyId))
    fail('--key key_<10 hex> or --grant grant_<10 hex> is required.')
  const done = revokeGrants(remote, `api_key_id = ${lit(keyId)}`, 'owner')
  if (!done.length) fail(`${keyId} has no live grant.`)
  console.error(
    `Revoked ${done.join(', ')} for ${keyId}. The S3 credentials stop working within a minute.`,
  )
}

function sweep(remote: boolean) {
  const rows = runSql(
    remote,
    'SELECT g.id, g.token_id, g.revoked_at, k.revoked AS key_revoked, k.expires_at AS key_expires_at FROM bulk_grants g JOIN api_keys k ON k.id = g.api_key_id WHERE g.revoked_at IS NULL',
  ).map((r) => ({
    id: String(r.id),
    token_id: String(r.token_id),
    revoked_at: null,
    key_revoked: Boolean(r.key_revoked),
    key_expires_at: String(r.key_expires_at),
  }))
  const stale = staleGrants(rows, new Date())
  for (const { grant: g, reason } of stale) revokeGrants(remote, `id = ${lit(g.id)}`, reason)
  console.error(
    stale.length
      ? `Revoked ${stale.map((s) => `${s.grant.id} (${s.reason})`).join(', ')}.`
      : 'Every live grant belongs to a live key.',
  )
}

function list(remote: boolean) {
  const rows = runSql(
    remote,
    'SELECT g.id, g.api_key_id, k.client, g.token_id, g.created_at, g.expires_at, g.revoked_at, g.revoke_reason FROM bulk_grants g LEFT JOIN api_keys k ON k.id = g.api_key_id ORDER BY g.created_at',
  )
  if (rows.length === 0) {
    console.error(`No grants in ${remote ? 'production' : 'the local database'}.`)
    return
  }
  console.table(
    rows.map((r) => ({
      id: String(r.id),
      key: String(r.api_key_id),
      client: String(r.client ?? '?'),
      access_key_id: String(r.token_id),
      created: String(r.created_at).slice(0, 10),
      expires: String(r.expires_at).slice(0, 10),
      status: r.revoked_at
        ? `revoked ${String(r.revoked_at).slice(0, 10)} (${String(r.revoke_reason)})`
        : 'live',
    })),
  )
}

if (import.meta.main) {
  const { command, flags } = parseArgs(process.argv.slice(2))
  const remote = flags.get('remote') === true
  if (command === 'list') list(remote)
  else if (command !== 'grant')
    fail('Usage: bun run scripts/bulk-grant.ts <grant|list> [--remote] …')
  else if (flags.get('sweep') === true) sweep(remote)
  else if (flags.get('revoke') === true) revoke(flags, remote)
  else await grant(flags, remote)
}
