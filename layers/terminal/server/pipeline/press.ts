// Press notes: when a registration filing parses (a prospectus-floor alert),
// one note per reporter, composed here from the alert. Two paths deliver them
// to the owner, never to a reporter: the press:briefs task mails a brief of
// mailto: links within minutes, and the press-drafts routine
// (.claude/routines/press-drafts.md) reads /api/press/pending and saves each
// note as a Gmail draft. A person decides that a note goes out.
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

/** KV key: every draft for this alert is saved in Gmail. */
export const draftedKey = (id: string) => `press:drafted:${id}`

const Contact = z.object({
  name: z.string().min(1),
  outlet: z.string().min(1),
  email: z.string().email().nullable().optional(),
  tips_email: z.string().email().nullable().optional(),
  priority: z.number().int().min(1).max(3).default(2),
})
export type PressContact = z.infer<typeof Contact>

/** The secret's contacts that have an address; an unparseable list is no list. */
export function parsePressList(raw: unknown): PressContact[] {
  // Nuxt parses a JSON-looking NUXT_* value into the runtime config itself,
  // so the secret usually arrives as an array, not the string that was set.
  let json: unknown = raw
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(json)) return []
  // One malformed entry drops that contact, not the whole list.
  return json
    .map((entry) => Contact.safeParse(entry))
    .flatMap((r) => (r.success ? [r.data] : []))
    .filter((c) => c.email || c.tips_email)
    .sort((a, b) => a.priority - b.priority || a.outlet.localeCompare(b.outlet))
}

export interface PressAlert {
  id: string
  headline: string
  explanation: string
}

/** One reporter's note, composed from the alert alone: no model writes it. */
export function pressDraft(alert: PressAlert, contact: PressContact, origin: string) {
  const first = contact.email ? contact.name.split(/\s+/)[0] : null
  const body = [
    first ? `Hi ${first},` : 'Hello,',
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
  return {
    name: contact.name,
    outlet: contact.outlet,
    to: contact.email ?? contact.tips_email!,
    desk: !contact.email,
    subject: alert.headline,
    body,
  }
}

export function pressNote(alert: PressAlert, contact: PressContact, origin: string) {
  const d = pressDraft(alert, contact, origin)
  const href = `mailto:${d.to}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`
  return { to: d.to, href, desk: d.desk }
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
    `${notes.length} notes. The press-drafts routine puts them in Gmail as drafts within the hour; or open one here, read it, send it:`,
    ...notes.map((n) => `- ${n.c.name}, ${n.c.outlet}${n.desk ? ' (tips desk)' : ''}: ${n.href}`),
  ].join('\n')
  const html = [
    `<p><strong><a href="${esc(permalink)}">${esc(alert.headline)}</a></strong></p>`,
    `<p>${esc(alert.explanation)}</p>`,
    `<p>${notes.length} notes. The press-drafts routine puts them in Gmail as drafts within the hour; or open one here, read it, send it:</p>`,
    '<ul>',
    ...notes.map(
      (n) =>
        `<li><a href="${esc(n.href)}">${esc(n.c.name)}, ${esc(n.c.outlet)}</a>${n.desk ? ' (tips desk)' : ''} · priority ${n.c.priority}</li>`,
    ),
    '</ul>',
  ].join('\n')
  return { subject, html, text, ids: [alert.id] }
}

/** Critical registration-filing alerts since the epoch that `done` has not seen yet. The
 * rule also raises notable alerts (a reworded risk factor), which are not news. */
export async function pendingPressAlerts(
  db: PipelineDb,
  done: (id: string) => Promise<boolean>,
): Promise<(PressAlert & { created_at: string })[]> {
  const rows = await db
    .select({
      id: tables.alerts.id,
      headline: tables.alerts.headline,
      explanation: tables.alerts.explanation,
      created_at: tables.alerts.created_at,
    })
    .from(tables.alerts)
    .where(
      and(
        eq(tables.alerts.rule, PROSPECTUS_FLOOR_RULE),
        eq(tables.alerts.severity, 'critical'),
        sql`datetime(${tables.alerts.created_at}) >= datetime(${PRESS_EPOCH})`,
      ),
    )
    .orderBy(desc(tables.alerts.created_at))
    .limit(LOOKBACK)
  const out: (PressAlert & { created_at: string })[] = []
  for (const r of rows) if (!(await done(r.id))) out.push(r)
  return out
}
