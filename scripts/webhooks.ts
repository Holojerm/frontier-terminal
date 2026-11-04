#!/usr/bin/env bun
// Licensee alert webhooks, configured by the owner. Never self-serve, like
// the keys they belong to (scripts/keys.ts).
//
//   bun run webhooks:add -- --key key_0a1b2c3d4e --url https://… --severity notable [--remote]
//   bun run webhooks:list [-- --remote]
//   bun run webhooks:remove -- --id whk_0a1b2c3d4e [--remote]
//   bun run webhooks:test -- --id whk_0a1b2c3d4e [--remote]
//
// --severity is the lowest severity sent: info (everything), notable, or
// critical. Without --remote these use the local dev database; with it,
// production D1 through `wrangler d1 execute` (scripts/lib/d1-cli.ts).
//
// add and test need NUXT_WEBHOOK_SIGNING_KEY, the same value the Worker has:
// each webhook's secret is derived from it (webhook-sign.ts). Locally bun
// reads it from .env. For production, pass it from 1Password:
//   NUXT_WEBHOOK_SIGNING_KEY="$(op read 'op://Private/Frontier Terminal webhook signing key/password')" \
//     bun run webhooks:add -- … --remote
//
// The secret is printed once, on stdout. Everything else goes to stderr.

import { lookup } from 'node:dns/promises'

import { keyRefusal } from '../layers/terminal/server/utils/api-key-token'
import { SCHEMA_VERSION } from '../layers/terminal/server/utils/data-schema'
import {
  deriveWebhookSecret,
  fetchWebhookSender,
  generateWebhookId,
  hashWebhookSecret,
  signedWebhookRequest,
  signingKeyId,
  signingKeyRefusal,
  WEBHOOK_ID_SHAPE,
} from '../layers/terminal/server/utils/webhook-sign'
import { addressRefusal, webhookUrlRefusal } from '../layers/terminal/server/utils/webhook-url'
import {
  exampleWebhookPayload,
  isWebhookSeverity,
  WEBHOOK_SEVERITIES,
} from '../layers/terminal/shared/utils/webhooks'
import { fail, lit, parseArgs, runSql, type Row } from './lib/d1-cli'

const where = (remote: boolean) => (remote ? 'production' : 'the local database')
const remoteFlag = (remote: boolean) => (remote ? ' --remote' : '')

function signingKey(): string {
  const key = process.env.NUXT_WEBHOOK_SIGNING_KEY
  const refusal = signingKeyRefusal(key)
  if (refusal) {
    fail(
      `${refusal}. Use the value the Worker has (see the header of scripts/webhooks.ts). Generate one with \`openssl rand -base64 32\`.`,
    )
  }
  return key!
}

/** Refuses a URL the Worker would refuse, and one whose name resolves to a private address. */
async function checkUrl(url: string): Promise<void> {
  const refusal = webhookUrlRefusal(url)
  if (refusal) fail(`Refused ${url}: ${refusal}`)
  let addresses: string[] = []
  try {
    addresses = (await lookup(new URL(url).hostname, { all: true, verbatim: true })).map(
      (a) => a.address,
    )
  } catch {
    // An unresolvable name is reported by addressRefusal([]).
  }
  const bad = addressRefusal(addresses)
  if (bad) fail(`Refused ${url}: ${bad}`)
}

function webhookRow(remote: boolean, id: string): Row {
  if (!WEBHOOK_ID_SHAPE.test(id)) fail('--id whk_<10 hex> is required.')
  const [row] = runSql(
    remote,
    `SELECT w.id, w.url, w.status, w.signing_key_id, w.min_severity, k.client, k.revoked, k.expires_at
       FROM webhooks w JOIN api_keys k ON k.id = w.api_key_id WHERE w.id = ${lit(id)}`,
  )
  if (!row) fail(`No webhook ${id} in ${where(remote)}.`)
  return row
}

async function add(flags: Map<string, string | true>, remote: boolean) {
  const keyIdFlag = flags.get('key')
  const url = flags.get('url')
  const severity = flags.get('severity') ?? 'notable'
  if (typeof keyIdFlag !== 'string' || !/^key_[0-9a-f]{10}$/.test(keyIdFlag)) {
    fail('--key key_<10 hex> is required: the API key id from keys:list.')
  }
  if (typeof url !== 'string') fail('--url https://… is required.')
  if (!isWebhookSeverity(severity)) {
    fail(`--severity must be one of: ${WEBHOOK_SEVERITIES.join(', ')}.`)
  }
  const key = signingKey()
  await checkUrl(url)

  const [apiKey] = runSql(
    remote,
    `SELECT id, client, revoked, expires_at FROM api_keys WHERE id = ${lit(keyIdFlag)}`,
  )
  if (!apiKey) fail(`No API key ${keyIdFlag} in ${where(remote)}.`)
  const refusal = keyRefusal(
    { revoked: Boolean(apiKey.revoked), expires_at: String(apiKey.expires_at) },
    new Date(),
  )
  if (refusal) fail(`API key ${keyIdFlag} is ${refusal}. Issue a new one first.`)

  const keyId = await signingKeyId(key)
  const others = runSql(
    remote,
    `SELECT DISTINCT signing_key_id FROM webhooks WHERE status != 'removed' AND signing_key_id != ${lit(keyId)}`,
  )
  if (others.length) {
    fail(
      `Live webhooks in ${where(remote)} were added with a different NUXT_WEBHOOK_SIGNING_KEY (id ${String(others[0]!.signing_key_id)}; yours is ${keyId}). Use the Worker's value.`,
    )
  }

  const id = generateWebhookId()
  const secret = await deriveWebhookSecret(key, id)
  runSql(
    remote,
    `INSERT INTO webhooks (id, api_key_id, url, min_severity, secret_hash, signing_key_id, status, created_at)
     VALUES (${[
       lit(id),
       lit(keyIdFlag),
       lit(url),
       lit(severity),
       lit(await hashWebhookSecret(secret)),
       lit(keyId),
       lit('active'),
       lit(new Date().toISOString()),
     ].join(', ')}) RETURNING id`,
  )

  console.error(
    `Added ${id} for ${String(apiKey.client)} (${keyIdFlag}) in ${where(remote)}: ${severity} and above to ${url}.\n`,
  )
  console.log(secret)
  console.error(
    '\nThis is the only time the signing secret is shown. Deliver it the way you deliver keys (a 1Password share link).\n' +
      'The client checks X-Frontier-Signature against it (/data#webhooks).\n' +
      `Send a test delivery with: bun run webhooks:test -- --id ${id}${remoteFlag(remote)}`,
  )
}

function list(remote: boolean) {
  const rows = runSql(
    remote,
    `SELECT w.id, w.api_key_id, k.client, k.revoked, k.expires_at, w.url, w.min_severity, w.status,
            w.created_at, w.last_error, substr(w.secret_hash, 1, 8) AS fingerprint,
            (SELECT max(d.delivered_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last_delivered,
            (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'queued') AS queued,
            (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed
       FROM webhooks w LEFT JOIN api_keys k ON k.id = w.api_key_id
      ORDER BY w.created_at`,
  )
  if (rows.length === 0) {
    console.error(`No webhooks in ${where(remote)}.`)
    return
  }
  const now = new Date()
  console.table(
    rows.map((r) => {
      const keyState =
        r.client === null
          ? 'key missing'
          : keyRefusal({ revoked: Boolean(r.revoked), expires_at: String(r.expires_at) }, now)
      return {
        id: String(r.id),
        client: String(r.client ?? '?'),
        key: String(r.api_key_id),
        url: String(r.url),
        severity: String(r.min_severity),
        status: r.status === 'removed' || !keyState ? String(r.status) : `key ${keyState}`,
        added: String(r.created_at).slice(0, 10),
        delivered: r.last_delivered ? String(r.last_delivered).slice(0, 16) : '-',
        queued: Number(r.queued),
        failed: Number(r.failed),
        secret: String(r.fingerprint),
      }
    }),
  )
  for (const r of rows) {
    if (r.status === 'failing' && r.last_error)
      console.error(`${String(r.id)}: ${String(r.last_error)}`)
  }
}

function remove(flags: Map<string, string | true>, remote: boolean) {
  const id = String(flags.get('id') ?? '')
  const row = webhookRow(remote, id)
  if (row.status === 'removed') fail(`${id} was already removed.`)
  runSql(
    remote,
    `UPDATE webhooks SET status = 'removed', removed_at = ${lit(new Date().toISOString())} WHERE id = ${lit(id)}`,
  )
  const cancelled = runSql(
    remote,
    `UPDATE webhook_deliveries SET status = 'cancelled', last_error = 'webhook removed'
      WHERE webhook_id = ${lit(id)} AND status = 'queued' RETURNING id`,
  )
  console.error(
    `Removed ${id} (${String(row.client)}). ${cancelled.length} queued deliveries cancelled.`,
  )
}

async function test(flags: Map<string, string | true>, remote: boolean) {
  const id = String(flags.get('id') ?? '')
  const row = webhookRow(remote, id)
  if (row.status === 'removed') fail(`${id} was removed. Add a new webhook instead.`)
  const key = signingKey()
  if ((await signingKeyId(key)) !== row.signing_key_id) {
    fail(
      `${id} was added with a different NUXT_WEBHOOK_SIGNING_KEY. Use the Worker's value, or remove and re-add the webhook.`,
    )
  }
  const url = String(row.url)
  await checkUrl(url)

  const payload = exampleWebhookPayload({
    schemaVersion: SCHEMA_VERSION,
    origin: process.env.NUXT_PUBLIC_APP_URL || 'https://frontierterm.com',
    event: 'test',
    deliveryId: `whd_test_${crypto.randomUUID()}`,
    sentAt: new Date(),
  })
  const request = await signedWebhookRequest(url, await deriveWebhookSecret(key, id), payload)
  const outcome = await fetchWebhookSender()(request)
  if (!outcome.ok) fail(`Test delivery to ${url} failed: ${outcome.error}.`)

  console.error(`Test delivery to ${url} answered HTTP ${outcome.status}.`)
  if (row.status === 'failing') {
    runSql(
      remote,
      `UPDATE webhooks SET status = 'active', failing_since = NULL, last_error = NULL WHERE id = ${lit(id)}`,
    )
    console.error(
      `${id} was failing and is active again. Its queued deliveries from the last 24 hours go out on the next run.`,
    )
  }
}

const { command, flags } = parseArgs(process.argv.slice(2))
const remote = flags.get('remote') === true
if (command === 'add') await add(flags, remote)
else if (command === 'list') list(remote)
else if (command === 'remove') remove(flags, remote)
else if (command === 'test') await test(flags, remote)
else fail('Usage: bun run scripts/webhooks.ts <add|list|remove|test> [--remote] …')
