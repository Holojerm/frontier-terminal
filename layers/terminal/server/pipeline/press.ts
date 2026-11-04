// Press briefs: when a registration filing parses (a prospectus-floor alert),
// mail the owner one ready-to-send note per reporter, each a mailto: link with
// the subject and body filled in from the alert. Nothing is sent to a reporter
// by the Worker. The send_email binding can only reach the verified owner
// address, and a person should decide that a note goes out.
//
// The press list is a Worker secret (NUXT_PRESS_LIST, JSON), not in the repo:
// it is a list of people, and this repository is public.

import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import type { OpsDigest } from '#server/utils/ops'
import { absoluteUrl } from '#shared/utils/site'
import { PROSPECTUS_FLOOR_RULE } from './prospectus-floor'
import type { PipelineDb } from './store'

/** Alerts before briefs went live are history, not news. */
export const PRESS_EPOCH = '2026-11-05T00:00:00.000Z'

const LOOKBACK = 10

const Contact = z.object({
  name: z.string().min(1),
  outlet: z.string().min(1),
  email: z.string().email().nullable().optional(),
  tips_email: z.string().email().nullable().optional(),
  priority: z.number().int().min(1).max(3).default(2),
})
export type PressContact = z.infer<typeof Contact>

/** The secret's contacts that have an address; an unparseable list is no list. */
export function parsePressList(raw: string | undefined): PressContact[] {
  if (!raw) return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = z.array(Contact).safeParse(json)
  if (!parsed.success) return []
  return parsed.data
    .filter((c) => c.email || c.tips_email)
    .sort((a, b) => a.priority - b.priority || a.outlet.localeCompare(b.outlet))
}

export interface PressAlert {
  id: string
  headline: string
  explanation: string
}

const firstName = (c: PressContact) => (c.email ? c.name.split(/\s+/)[0]! : null)

export function pressNote(alert: PressAlert, contact: PressContact, origin: string) {
  const to = contact.email ?? contact.tips_email!
  const greeting = firstName(contact) ? `Hi ${firstName(contact)},` : 'Hello,'
  const subject = alert.headline
  const body = [
    greeting,
    '',
    `${alert.headline}.`,
    '',
    `Every period each lab has reported, each figure linked to its EDGAR filing: ${absoluteUrl(origin, '/revenue')}`,
    `The alert, with its sources and fetch times: ${absoluteUrl(origin, `/alerts/${alert.id}`)}`,
    '',
    'Free to cite under CC BY 4.0 (credit: Frontier Terminal). Happy to walk through any of it.',
    '',
    'Jeremy Ettlinger',
    'Frontier Terminal · frontierterm.com',
  ].join('\n')
  const href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return { to, href, desk: !contact.email }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The owner's mail: the alert, then one click-to-draft link per contact. */
export function pressBrief(
  alert: PressAlert,
  contacts: readonly PressContact[],
  origin: string,
): OpsDigest {
  const notes = contacts.map((c) => ({ c, ...pressNote(alert, c, origin) }))
  const permalink = absoluteUrl(origin, `/alerts/${alert.id}`)
  const subject = `Press brief ready: ${alert.headline}`
  const text = [
    alert.headline,
    permalink,
    '',
    alert.explanation,
    '',
    `${notes.length} drafts. Open one, read it, send it:`,
    ...notes.map((n) => `- ${n.c.name}, ${n.c.outlet}${n.desk ? ' (tips desk)' : ''}: ${n.href}`),
  ].join('\n')
  const html = [
    `<p><strong><a href="${esc(permalink)}">${esc(alert.headline)}</a></strong></p>`,
    `<p>${esc(alert.explanation)}</p>`,
    `<p>${notes.length} drafts. Open one, read it, send it:</p>`,
    '<ul>',
    ...notes.map(
      (n) =>
        `<li><a href="${esc(n.href)}">${esc(n.c.name)}, ${esc(n.c.outlet)}</a>${n.desk ? ' (tips desk)' : ''} · priority ${n.c.priority}</li>`,
    ),
    '</ul>',
  ].join('\n')
  return { subject, html, text, ids: [alert.id] }
}

/** Registration-filing alerts since the epoch that have no brief yet. */
export async function pendingPressAlerts(
  db: PipelineDb,
  briefed: (id: string) => Promise<boolean>,
): Promise<PressAlert[]> {
  const rows = await db
    .select({
      id: tables.alerts.id,
      headline: tables.alerts.headline,
      explanation: tables.alerts.explanation,
    })
    .from(tables.alerts)
    .where(
      and(
        eq(tables.alerts.rule, PROSPECTUS_FLOOR_RULE),
        sql`datetime(${tables.alerts.created_at}) >= datetime(${PRESS_EPOCH})`,
      ),
    )
    .orderBy(desc(tables.alerts.created_at))
    .limit(LOOKBACK)
  const out: PressAlert[] = []
  for (const r of rows) if (!(await briefed(r.id))) out.push(r)
  return out
}
