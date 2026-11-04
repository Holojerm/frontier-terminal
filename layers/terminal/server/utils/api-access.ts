// The request side of licensee keys: read the key once per request, refuse a
// bad one with a 401, and spend the right budget.
//
// Keys only raise limits and change the license a history row is labeled
// with. They never unlock a different fact, a row the public site doesn't
// have yet, or a source the owner can't license (payloads are `rights: ours`
// only, server/routes/export/payloads). Every public route that takes a key
// calls rateLimitTerminal() first, in place of core's rateLimit(). The gated
// routes (/api/fleet, /api/judge, /api/press, /api/ops) read their own bearer
// and never come through here, and neither do /mcp and /alerts.xml.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'
import type { H3Event } from 'h3'

import { logEvent } from '#server/utils/log'
import { rateLimit } from '#server/utils/rate-limit'

import { REQUEST_BUDGETS } from '../../shared/utils/institutional'
import type { ApiKeyTier } from './api-key-token'
import { createUsageCounter } from './api-key-usage'
import { KEY_REFUSALS, verifyApiKey, type ApiKey } from './api-keys'

/** `event.context` key the resolved caller is kept under: ApiKey, or null for anonymous. */
const CONTEXT_KEY = 'terminalApiKey'

const usage = createUsageCounter()

/**
 * The key this request presents, or null when it presents none. A request
 * that presents a bad one is refused here, after spending the anonymous
 * export budget for its IP, so a spray of guesses is throttled like any other
 * loop.
 */
export async function requestApiKey(event: H3Event): Promise<ApiKey | null> {
  if (CONTEXT_KEY in event.context) return event.context[CONTEXT_KEY] as ApiKey | null

  const verdict = await verifyApiKey(db, getRequestHeader(event, 'authorization'))
  if (verdict.kind === 'invalid') {
    await rateLimit(event, {
      name: 'api-key-refused',
      limit: REQUEST_BUDGETS.anonymous.export,
      windowSeconds: 60,
    })
    logEvent('warn', 'api_key_refused', { reason: verdict.reason })
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer error="invalid_token"')
    throw createError({
      statusCode: 401,
      message: KEY_REFUSALS[verdict.reason],
      data: { code: 'invalid_api_key', reason: verdict.reason },
    })
  }

  const key = verdict.kind === 'key' ? verdict.key : null
  event.context[CONTEXT_KEY] = key
  if (key) {
    // The same URL answers differently with a key (its limit, its license label).
    setResponseHeader(event, 'Vary', 'Authorization')
    const now = new Date()
    usage.count(key.id, now)
    if (usage.due(now)) event.waitUntil(usage.flush(kv, now).catch(logUsageFailure))
  }
  return key
}

function logUsageFailure(error: unknown): void {
  logEvent('warn', 'api_key_usage_unwritten', { error: String(error) })
}

/** The key already resolved for this request, without reading the header again. */
export function resolvedApiKey(event: H3Event): ApiKey | null {
  return (event.context[CONTEXT_KEY] as ApiKey | null | undefined) ?? null
}

export type Budget = 'read' | 'export'

const keyedLimit = (tier: ApiKeyTier, budget: Budget): number => REQUEST_BUDGETS[tier][budget]

/**
 * Core's rateLimit(), keyed: anonymous callers spend `opts` per IP exactly as
 * before, and a key spends its tier's budget per key. `budget` says which of
 * the tier's budgets a route draws on.
 */
export async function rateLimitTerminal(
  event: H3Event,
  opts: { name: string; limit: number; windowSeconds: number; budget?: Budget },
): Promise<ApiKey | null> {
  const key = await requestApiKey(event)
  if (!key) {
    await rateLimit(event, {
      name: opts.name,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds,
    })
    return null
  }
  await rateLimit(event, {
    name: opts.name,
    limit: keyedLimit(key.tier, opts.budget ?? 'read'),
    windowSeconds: 60,
    identifier: `key:${key.id}`,
  })
  return key
}

/**
 * The Cache-Control a response may carry: `shared` for an anonymous one, and
 * `private` for a keyed one, so a shared cache never stores a licensee's
 * response and hands it to someone else.
 */
export function cacheControlFor(event: H3Event, shared: string): string {
  return resolvedApiKey(event) ? 'private, max-age=60' : shared
}

/** A 401 or 403 unless the request carries a live key of `tier`. */
export async function requireApiKeyTier(event: H3Event, tier: ApiKeyTier): Promise<ApiKey> {
  const key = await requestApiKey(event)
  if (!key) {
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
    throw createError({
      statusCode: 401,
      message: `This endpoint needs a ${tier} API key. See /data#institutions.`,
    })
  }
  if (key.tier !== tier) {
    throw createError({
      statusCode: 403,
      message: `This endpoint needs a ${tier} API key. Yours is ${key.tier}.`,
    })
  }
  return key
}
