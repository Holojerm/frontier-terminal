// What Frontier Terminal says in public, and when. The social layer
// (layers/social) owns sending; this file only decides what to enqueue.
//
// Three things post, all composed from stored rows only — no model writes the
// text, so a post can say nothing the alert page doesn't:
//   - every critical alert: its headline and its permalink, which carries
//     the source URL and fetch time. A judged alert waits an hour first, so
//     a bad call can be suppressed before it is public.
//   - a launch of a model the vendor recommends (enqueueLaunchAlerts): the
//     model-floor alert, the same headline-and-permalink shape.
//   - a weekly thread: what moved, by axis, and the week's critical alerts.
//
// On X the link goes in a self-reply, never the lead post: X ranks posts
// carrying an external link lower. Bluesky does not, so it keeps one post.

import { and, count, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  enqueueSocialPost,
  type SocialBody,
  type SocialChannels,
} from '#layers/social/server/utils/social'
import {
  fitSocialText,
  SOCIAL_SERVICES,
  type SocialService,
} from '#layers/social/server/utils/social-text'
import { absoluteUrl } from '#shared/utils/site'
import { AXIS_OF } from '../utils/terminal-alerts'
import { effectiveClassMap } from '#layers/pricing/server/pipeline/class-map'
import { MODEL_FLOOR_RULE } from '#layers/core/server/utils/terminal-asof'
import type { PipelineDb } from '#layers/core/server/pipeline/store'

/** Alerts before posting went live are history, not news. */
export const SOCIAL_EPOCH = '2026-11-02T00:00:00.000Z'

/** How long a judged critical waits before it can be sent. */
export const JUDGED_HOLD_MS = 60 * 60_000

/**
 * When a judged alert's hold ends: an hour after the alert was written, not
 * after created_at. created_at is the cited evidence's fetch time, which the
 * hourly judge reads up to an hour or more later, so a hold counted from it
 * was mostly spent before anyone could see the alert to suppress it. A row
 * without a write time (before the column) holds from created_at.
 */
export function heldUntil(alert: {
  rule: string
  created_at: string
  recorded_at: string | null
}): number {
  const created = Date.parse(alert.created_at)
  if (alert.rule !== 'agent-judge') return created
  const recorded = alert.recorded_at === null ? NaN : Date.parse(alert.recorded_at)
  return Math.max(created, Number.isNaN(recorded) ? created : recorded) + JUDGED_HOLD_MS
}

/** Newest critical alerts re-offered each tick; enqueueing is idempotent. */
const ALERT_LOOKBACK = 20

/** Critical alerts named in the weekly thread, newest first. */
const DIGEST_ALERTS = 3

/** A weekly thread is skipped when another went out within this many days. */
const DIGEST_MIN_GAP_DAYS = 6

const DAY_MS = 86_400_000

const alertUrl = (origin: string, id: string) => absoluteUrl(origin, `/alerts/${id}`)

/** Services whose lead post must not carry a link — see the header. */
const LINK_IN_REPLY: Record<SocialService, boolean> = { x: true, bluesky: false }

/** `text` with its link, either inline or as the reply under it. */
export function withLink(service: SocialService, text: string, url: string): string[] {
  return LINK_IN_REPLY[service]
    ? [fitSocialText(service, text), `Source and details: ${url}`]
    : [fitSocialText(service, text, url)]
}

/** How long after it was written a launch can still be queued: news on the day, not a week on. */
export const LAUNCH_POST_WINDOW_MS = 48 * 60 * 60_000

/**
 * Queue each recent launch of a model its vendor recommends: a model-floor
 * alert (always notable, never critical) whose slug fills a like-for-like
 * cell in the class map in effect. Most new slugs are image, speech and
 * embedding SKUs, and none of them were ever posted; but the new flagship of a
 * tracked lab is the news this account exists for, and qwen4-max (2026-11-16)
 * went unposted like every launch before it. A launch the class map takes up
 * later (the seed, or the judge within its own 48-hour review) is posted then,
 * if still inside the window. Returns how many rows were new.
 */
export async function enqueueLaunchAlerts(
  db: PipelineDb,
  channels: SocialChannels,
  origin: string,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - LAUNCH_POST_WINDOW_MS).toISOString()
  const rows = await db
    .select({
      id: tables.alerts.id,
      headline: tables.alerts.headline,
      change_ids: tables.alerts.change_ids,
      created_at: tables.alerts.created_at,
    })
    .from(tables.alerts)
    .where(
      and(
        eq(tables.alerts.rule, MODEL_FLOOR_RULE),
        sql`datetime(${tables.alerts.created_at}) >= datetime(${since})`,
        sql`datetime(${tables.alerts.created_at}) >= datetime(${SOCIAL_EPOCH})`,
      ),
    )
    .orderBy(desc(tables.alerts.created_at))
  if (rows.length === 0) return 0

  const mapped = new Set((await effectiveClassMap(db)).map((e) => `${e.provider}:${e.model_slug}`))
  const launched = await launchedModels(
    db,
    rows.flatMap((r) => JSON.parse(r.change_ids) as string[]),
  )
  let queued = 0
  for (const alert of rows) {
    const keys = (JSON.parse(alert.change_ids) as string[]).map((id) => launched.get(id))
    if (!keys.some((k) => k !== undefined && mapped.has(k))) continue
    queued += await enqueueSocialPost(db, channels, {
      kind: 'alert',
      ref: alert.id,
      compose: (service) => ({
        posts: withLink(service, alert.headline, alertUrl(origin, alert.id)),
      }),
    })
  }
  return queued
}

/** change id → "provider:slug" of the model row each added change wrote. */
async function launchedModels(db: PipelineDb, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const changes = await db
    .select({ id: tables.changes.id, entity_key: tables.changes.entity_key })
    .from(tables.changes)
    .where(inArray(tables.changes.id, ids))
  const out = new Map<string, string>()
  for (const c of changes) {
    // entity_key is "model:<provider>:<slug>[:<tier>]" (contracts/keys.ts).
    const [type, provider, slug] = c.entity_key.split(':')
    if (type === 'model' && provider && slug) out.set(c.id, `${provider}:${slug}`)
  }
  return out
}

/** Queue every recent critical alert. Returns how many rows were new. */
export async function enqueueCriticalAlerts(
  db: PipelineDb,
  channels: SocialChannels,
  origin: string,
): Promise<number> {
  const rows = await db
    .select({
      id: tables.alerts.id,
      headline: tables.alerts.headline,
      rule: tables.alerts.rule,
      created_at: tables.alerts.created_at,
      recorded_at: tables.alerts.recorded_at,
    })
    .from(tables.alerts)
    .where(
      and(
        eq(tables.alerts.severity, 'critical'),
        sql`datetime(${tables.alerts.created_at}) >= datetime(${SOCIAL_EPOCH})`,
      ),
    )
    .orderBy(desc(tables.alerts.created_at))
    .limit(ALERT_LOOKBACK)

  let queued = 0
  for (const alert of rows) {
    queued += await enqueueSocialPost(db, channels, {
      kind: 'alert',
      ref: alert.id,
      notBefore: new Date(heldUntil(alert)),
      compose: (service) => ({
        posts: withLink(service, alert.headline, alertUrl(origin, alert.id)),
      }),
    })
  }
  return queued
}

export interface WeeklyDigest {
  /** Last day of the week reported, as the post names it. */
  weekTo: Date
  counts: { pricing: number; hiring: number; sec: number; incidents: number; disclosures: number }
  total: number
  /** Newest first, already capped. */
  criticals: { id: string; headline: string }[]
  /** Notable alerts this week — counted, never named. */
  notable: number
}

const AXIS_LABELS: [keyof WeeklyDigest['counts'], string][] = [
  ['pricing', 'Pricing'],
  ['hiring', 'Hiring'],
  ['sec', 'SEC'],
  ['incidents', 'Incidents'],
  ['disclosures', 'Disclosures'],
]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The weekly thread for one service; null when the week was empty. */
export function composeWeeklyDigest(
  service: SocialService,
  digest: WeeklyDigest,
  origin: string,
): SocialBody | null {
  if (!digest.total && !digest.criticals.length && !digest.notable) return null
  const day = digest.weekTo.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const axes = AXIS_LABELS.filter(([key]) => digest.counts[key] > 0)
    .map(([key, label]) => `${label} ${digest.counts[key]}`)
    .join(' · ')
  const alerts = [
    digest.criticals.length ? plural(digest.criticals.length, 'critical alert') : '',
    digest.notable ? `${digest.notable} notable` : '',
  ]
    .filter(Boolean)
    .join(', ')

  const lead = [
    `The frontier labs, week to ${day}: ${plural(digest.total, 'tracked change')}.`,
    axes,
    alerts ? `Alerts: ${alerts}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const posts = withLink(service, lead, absoluteUrl(origin, '/alerts'))
  // Replies already sit under the lead, so each critical keeps its link inline.
  for (const alert of digest.criticals) {
    posts.push(fitSocialText(service, alert.headline, alertUrl(origin, alert.id)))
  }
  return { posts }
}

/** The seven days to `now`, read from the change log and the alerts. */
export async function readWeeklyDigest(db: PipelineDb, now: Date): Promise<WeeklyDigest> {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString()
  const inWeek = (column: typeof tables.changes.detected_at | typeof tables.alerts.created_at) =>
    sql`datetime(${column}) >= datetime(${since})`

  const [byType, criticals, [notable]] = await Promise.all([
    db
      .select({ entity_type: tables.changes.entity_type, n: count() })
      .from(tables.changes)
      // Rankings are a daily series, not events — same exclusion as queryMovement.
      .where(and(ne(tables.changes.entity_type, 'ranking'), inWeek(tables.changes.detected_at)))
      .groupBy(tables.changes.entity_type),
    db
      .select({ id: tables.alerts.id, headline: tables.alerts.headline })
      .from(tables.alerts)
      .where(and(eq(tables.alerts.severity, 'critical'), inWeek(tables.alerts.created_at)))
      .orderBy(desc(tables.alerts.created_at))
      .limit(DIGEST_ALERTS),
    db
      .select({ n: count() })
      .from(tables.alerts)
      .where(and(eq(tables.alerts.severity, 'notable'), inWeek(tables.alerts.created_at))),
  ])

  const counts = { pricing: 0, hiring: 0, sec: 0, incidents: 0, disclosures: 0 }
  let total = 0
  for (const row of byType) {
    const axis = AXIS_OF[row.entity_type]
    if (axis) counts[axis] += row.n
    total += row.n
  }
  return { weekTo: now, counts, total, criticals, notable: notable?.n ?? 0 }
}

/** Queue this week's thread, once per week. Returns how many rows were new. */
export async function enqueueWeeklyDigest(
  db: PipelineDb,
  channels: SocialChannels,
  origin: string,
  now = new Date(),
): Promise<number> {
  // The ref is a date, so it only stops a repeat on the same day. A cron that
  // moves to another weekday would otherwise post two threads a day apart.
  const cutoff = new Date(now.getTime() - DIGEST_MIN_GAP_DAYS * DAY_MS).toISOString().slice(0, 10)
  const [recent] = await db
    .select({ ref: tables.socialPosts.ref })
    .from(tables.socialPosts)
    .where(and(eq(tables.socialPosts.kind, 'digest'), gte(tables.socialPosts.ref, cutoff)))
    .limit(1)
  if (recent) return 0

  const digest = await readWeeklyDigest(db, now)
  const bodies = new Map<SocialService, SocialBody | null>()
  for (const service of SOCIAL_SERVICES) {
    bodies.set(service, composeWeeklyDigest(service, digest, origin))
  }
  if (![...bodies.values()].some(Boolean)) return 0
  return enqueueSocialPost(db, channels, {
    kind: 'digest',
    ref: now.toISOString().slice(0, 10),
    compose: (service) => bodies.get(service) ?? { posts: [] },
  })
}
