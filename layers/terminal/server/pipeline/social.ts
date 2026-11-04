// What Frontier Terminal says in public, and when. The social layer
// (layers/social) owns sending; this file only decides what to enqueue.
//
// Two things post, both composed from stored rows only — no model writes the
// text, so a post can say nothing the alert page doesn't:
//   - every critical alert: its headline and its permalink, which carries
//     the source URL and fetch time. A judged alert waits an hour first, so
//     a bad call can be suppressed before it is public.
//   - a weekly thread: what moved, by axis, and the week's critical alerts.
//
// On X the link goes in a self-reply, never the lead post: X ranks posts
// carrying an external link lower. Bluesky does not, so it keeps one post.

import { and, count, desc, eq, ne, sql } from 'drizzle-orm'

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
import { AXIS_OF } from '../utils/terminal-db'
import type { PipelineDb } from './store'

/** Alerts before posting went live are history, not news. */
export const SOCIAL_EPOCH = '2026-11-02T00:00:00.000Z'

/** How long a judged critical waits before it can be sent. */
export const JUDGED_HOLD_MS = 60 * 60_000

/** Newest critical alerts re-offered each tick; enqueueing is idempotent. */
const ALERT_LOOKBACK = 20

/** Critical alerts named in the weekly thread, newest first. */
const DIGEST_ALERTS = 3

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
    const hold = alert.rule === 'agent-judge' ? JUDGED_HOLD_MS : 0
    queued += await enqueueSocialPost(db, channels, {
      kind: 'alert',
      ref: alert.id,
      notBefore: new Date(Date.parse(alert.created_at) + hold),
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
