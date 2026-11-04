// Alert webhooks as a licensee sees them: the payload, the headers, the retry
// policy. One definition for the delivery cron, the CLI's test send, and the
// docs on /data, so the example a client codes against is the shape it gets.
// scripts/webhooks.ts imports it too; bun resolves #shared through .nuxt/tsconfig.json.

import { licenseSplit, PAID_LICENSE, type LicenseSplit } from '#shared/utils/license'
import { absoluteUrl } from '#shared/utils/site'
import { alertPath, type AlertSeverity } from './terminal-tiers'

export const WEBHOOK_SEVERITIES = [
  'info',
  'notable',
  'critical',
] as const satisfies readonly AlertSeverity[]

export function isWebhookSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (WEBHOOK_SEVERITIES as readonly string[]).includes(value)
}

/** Whether an alert of `severity` reaches a webhook set to `min`: at or above it. */
export function severityReaches(severity: string, min: string): boolean {
  const at = (WEBHOOK_SEVERITIES as readonly string[]).indexOf(severity)
  const floor = (WEBHOOK_SEVERITIES as readonly string[]).indexOf(min)
  return at !== -1 && floor !== -1 && at >= floor
}

export const WEBHOOK_HEADERS = {
  signature: 'X-Frontier-Signature',
  delivery: 'X-Frontier-Delivery',
  timestamp: 'X-Frontier-Timestamp',
  event: 'X-Frontier-Event',
} as const

/** How far a receiver should let X-Frontier-Timestamp drift from its clock. */
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300

/** How long a delivery is retried after it first fell due. */
export const WEBHOOK_RETRY_HOURS = 24

/** A receiver that takes longer than this to answer counts as a failure. */
export const WEBHOOK_TIMEOUT_SECONDS = 10

/** Cited change rows carried in the body; the permalink has every one. */
export const WEBHOOK_MAX_CHANGES = 100

export type WebhookEvent = 'alert.created' | 'test'

/** A cited change, with the columns of the `changes` export table. */
export interface WebhookChangeRow {
  id: string
  entity_key: string
  entity_type: string
  provider: string
  change_type: string
  before_hash: string | null
  after_hash: string | null
  before_json: string | null
  after_json: string | null
  detected_at: string
  source_url: string
  fetched_at: string
}

export interface WebhookAlertRow {
  id: string
  severity: string
  headline: string
  explanation: string
  rule: string
  created_at: string
  source_url: string
  fetched_at: string
}

export interface WebhookPayload {
  schema_version: string
  event: WebhookEvent
  delivery_id: string
  /** The same instant as X-Frontier-Timestamp, inside the signed body. */
  sent_at: string
  alert: WebhookAlertRow & {
    permalink: string
    /** The alert's own source_url, then each cited change's, without repeats. */
    source_urls: string[]
    change_count: number
    changes: WebhookChangeRow[]
  }
  license: LicenseSplit
}

export interface WebhookPayloadInput {
  schemaVersion: string
  event: WebhookEvent
  deliveryId: string
  sentAt: Date
  origin: string
  alert: WebhookAlertRow
  changes: readonly WebhookChangeRow[]
}

/** The body of one delivery. Keyed tier only, so the license is the paid one. */
export function buildWebhookPayload(input: WebhookPayloadInput): WebhookPayload {
  const { alert, changes } = input
  const source_urls = [...new Set([alert.source_url, ...changes.map((c) => c.source_url)])]
  return {
    schema_version: input.schemaVersion,
    event: input.event,
    delivery_id: input.deliveryId,
    sent_at: input.sentAt.toISOString(),
    alert: {
      id: alert.id,
      severity: alert.severity,
      headline: alert.headline,
      explanation: alert.explanation,
      rule: alert.rule,
      created_at: alert.created_at,
      source_url: alert.source_url,
      fetched_at: alert.fetched_at,
      permalink: absoluteUrl(input.origin, alertPath(alert.id)),
      source_urls,
      change_count: changes.length,
      changes: changes.slice(0, WEBHOOK_MAX_CHANGES).map((c) => ({ ...c })),
    },
    license: licenseSplit(input.sentAt, PAID_LICENSE),
  }
}

const EXAMPLE_ALERT_ID = 'a3f1c2e4b5d697881234567890abcdef1234567890abcdef1234567890abcd'
const EXAMPLE_CHANGE_ID = '5e8d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d'
const EXAMPLE_SOURCE = 'https://example.com/pricing'

/**
 * A made-up alert in the real shape: the /data example, and what
 * `bun run webhooks:test` sends (as event `test`).
 */
export function exampleWebhookPayload(input: {
  schemaVersion: string
  origin: string
  event?: WebhookEvent
  deliveryId?: string
  sentAt?: Date
}): WebhookPayload {
  const fetched_at = '2026-11-04T12:00:00.000Z'
  return buildWebhookPayload({
    schemaVersion: input.schemaVersion,
    event: input.event ?? 'alert.created',
    deliveryId: input.deliveryId ?? 'whd_0f6c2b9e-1d4a-4c8e-9b7a-3e5f2a1c0d9b',
    sentAt: input.sentAt ?? new Date('2026-11-04T12:35:00.000Z'),
    origin: input.origin,
    alert: {
      id: EXAMPLE_ALERT_ID,
      severity: 'critical',
      headline: 'Example Lab cut Model X output price 50%',
      explanation: 'output_per_mtok went from 10 to 5 USD on the Example Lab price list.',
      rule: 'agent-judge',
      created_at: fetched_at,
      source_url: EXAMPLE_SOURCE,
      fetched_at,
    },
    changes: [
      {
        id: EXAMPLE_CHANGE_ID,
        entity_key: 'price:example-lab:model-x:standard',
        entity_type: 'price',
        provider: 'example-lab',
        change_type: 'modified',
        before_hash: 'b1',
        after_hash: 'b2',
        before_json: '{"output_per_mtok":10}',
        after_json: '{"output_per_mtok":5}',
        detected_at: fetched_at,
        source_url: EXAMPLE_SOURCE,
        fetched_at,
      },
    ],
  })
}
