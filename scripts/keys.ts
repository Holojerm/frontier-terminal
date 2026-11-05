#!/usr/bin/env bun
// Licensee API keys, issued by the owner. Never self-serve: a key is sold by
// email, issued here, and delivered by hand.
//
//   bun run keys:issue -- --client "Acme Capital" --tier research --months 12 [--remote]
//   bun run keys:revoke -- --id key_0a1b2c3d4e [--remote]
//   bun run keys:list [-- --remote]
//
// Without --remote these work on the local dev database, .data/db/sqlite.db
// (the one `bun dev` serves; see .claude/docs/gotchas.md). With --remote they
// run against production D1 through `wrangler d1 execute`.
//
// The key is printed once, on stdout, and nowhere else: not to a file, not to
// a log, and not into the wrangler command, which carries only its SHA-256.
// Everything else goes to stderr, so `bun run keys:issue -- … | pbcopy` copies
// the key alone.

import {
  API_KEY_TIERS,
  expiryAfter,
  generateApiKey,
  generateApiKeyId,
  hashApiKey,
  isApiKeyTier,
  keyRefusal,
} from '../layers/terminal/server/utils/api-key-token'
import { USAGE_PREFIX } from '../layers/terminal/server/utils/api-key-usage'
import { liveGrantCount, revokeGrants } from './bulk-grant'
import { ROOT, fail, lit, parseArgs, runSql } from './lib/d1-cli'

const run = runSql

async function issue(flags: Map<string, string | true>, remote: boolean) {
  const client = flags.get('client')
  const tier = flags.get('tier')
  const months = Number(flags.get('months') ?? 12)
  if (typeof client !== 'string' || !client.trim()) fail('--client "<name>" is required.')
  if (!isApiKeyTier(tier)) fail(`--tier must be one of: ${API_KEY_TIERS.join(', ')}.`)
  if (!Number.isInteger(months) || months < 1 || months > 36) {
    fail('--months must be a whole number from 1 to 36.')
  }

  const token = generateApiKey()
  const id = generateApiKeyId()
  const issued = new Date()
  const expires = expiryAfter(issued, months)
  run(
    remote,
    `INSERT INTO api_keys (id, key_hash, client, tier, issued_at, expires_at, revoked, revoked_at) VALUES (${[
      lit(id),
      lit(await hashApiKey(token)),
      lit(client.trim()),
      lit(tier),
      lit(issued.toISOString()),
      lit(expires),
      0,
      'NULL',
    ].join(', ')}) RETURNING id`,
  )

  console.error(
    `Issued ${id} for ${client.trim()} (${tier}) in ${remote ? 'production' : 'the local database'}, expiring ${expires.slice(0, 10)}.\n`,
  )
  console.log(token)
  console.error(
    '\nThis is the only time the key is shown. We store only its SHA-256, so a lost key is revoked and reissued.\n' +
      'Deliver it securely (a 1Password share link or similar). Never paste it into plain email or chat.\n' +
      `The client sends it as: Authorization: Bearer <key>. Revoke with: bun run keys:revoke -- --id ${id}${remote ? ' --remote' : ''}`,
  )
}

function revoke(flags: Map<string, string | true>, remote: boolean) {
  const id = flags.get('id')
  if (typeof id !== 'string' || !/^key_[0-9a-f]{10}$/.test(id))
    fail('--id key_<10 hex> is required.')
  const rows = run(
    remote,
    `UPDATE api_keys SET revoked = 1, revoked_at = ${lit(new Date().toISOString())} WHERE id = ${lit(id)} AND revoked = 0 RETURNING id, client`,
  )
  if (rows.length === 0) fail(`No live key ${id} (it doesn't exist, or it was already revoked).`)
  console.error(
    `Revoked ${id} (${String(rows[0]!.client)}). Requests with it get a 401 within a minute.`,
  )
  // The key's S3 grants (scripts/bulk-grant.ts) go with it.
  if (liveGrantCount(remote, id) === 0) return
  if (!process.env.BULK_GRANT_API_TOKEN) {
    console.error(
      `${id} still has live S3 grants. Revoke them with BULK_GRANT_API_TOKEN set: bun run bulk:grant -- --key ${id} --revoke${remote ? ' --remote' : ''}`,
    )
    process.exitCode = 1
    return
  }
  const grants = revokeGrants(remote, `api_key_id = ${lit(id)}`, 'key-revoked')
  console.error(`Revoked its S3 grants too: ${grants.join(', ')}.`)
}

/** Requests per key id per day, from the usage shards' KV metadata (api-key-usage.ts). */
function usageByKey(remote: boolean): Map<string, Map<string, number>> | null {
  const result = Bun.spawnSync(
    [
      'bunx',
      'wrangler',
      'kv',
      'key',
      'list',
      '--binding',
      'KV',
      remote ? '--remote' : '--local',
      '--prefix',
      `${USAGE_PREFIX}:`,
    ],
    { cwd: ROOT, stderr: 'pipe' },
  )
  if (result.exitCode !== 0) return null
  try {
    const keys = JSON.parse(result.stdout.toString()) as {
      name: string
      metadata?: { n?: number }
    }[]
    const out = new Map<string, Map<string, number>>()
    for (const { name, metadata } of keys) {
      const [, day, keyId] = name.split(':')
      if (!day || !keyId || typeof metadata?.n !== 'number') continue
      const days = out.get(keyId) ?? new Map<string, number>()
      days.set(day, (days.get(day) ?? 0) + metadata.n)
      out.set(keyId, days)
    }
    return out
  } catch {
    return null
  }
}

function list(remote: boolean) {
  const rows = run(
    remote,
    'SELECT id, client, tier, issued_at, expires_at, revoked, revoked_at FROM api_keys ORDER BY issued_at',
  )
  if (rows.length === 0) {
    console.error(`No keys in ${remote ? 'production' : 'the local database'}.`)
    return
  }
  const usage = usageByKey(remote)
  const now = new Date()
  const day = (offset: number) =>
    new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10)
  const sum = (keyId: string, days: number) => {
    const byDay = usage?.get(keyId)
    if (!byDay) return usage ? 0 : null
    let n = 0
    for (let i = 0; i < days; i++) n += byDay.get(day(i)) ?? 0
    return n
  }

  const table = rows.map((r) => {
    const refusal = keyRefusal(
      { revoked: Boolean(r.revoked), expires_at: String(r.expires_at) },
      now,
    )
    const id = String(r.id)
    const cell = (n: number | null) => (n === null ? '?' : String(n))
    return {
      id,
      client: String(r.client),
      tier: String(r.tier),
      issued: String(r.issued_at).slice(0, 10),
      expires: String(r.expires_at).slice(0, 10),
      status: refusal ?? 'live',
      today: cell(sum(id, 1)),
      '7d': cell(sum(id, 7)),
      '30d': cell(sum(id, 30)),
    }
  })
  console.table(table)
  if (!usage) {
    console.error(
      'Usage (requests per UTC day, from KV) could not be read, so it shows as "?". Check `bunx wrangler whoami`.',
    )
  }
}

const { command, flags } = parseArgs(process.argv.slice(2))
const remote = flags.get('remote') === true
if (command === 'issue') await issue(flags, remote)
else if (command === 'revoke') revoke(flags, remote)
else if (command === 'list') list(remote)
else fail('Usage: bun run scripts/keys.ts <issue|revoke|list> [--remote] …')
