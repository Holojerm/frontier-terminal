// Press notes: when a registration filing parses (a prospectus-floor alert),
// one note per reporter, composed here from the alert. The EVENTS queue's
// alert fan-out (layers/terminal/server/utils/event-work.ts) sends each note
// to its reporter through Resend within a minute or so, then mails the owner
// a receipt of who got it. Without Resend configured it mails the owner a
// brief of mailto: links instead, and a person sends them.
//
// The press list is a Worker secret (NUXT_PRESS_LIST, JSON), not in the repo:
// it is a list of people, and this repository is public.

import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import type { OwnerMessage } from '../utils/owner-mail'
import type { MailMessage } from '../utils/resend'
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
    '',
    'If you would rather not get these, reply and I will take you off the list.',
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

/** The sender's name on a note: the person who signs it. */
export const PRESS_FROM_NAME = 'Jeremy Ettlinger'

/** One reporter's note as mail, sent as written in pressDraft. */
export function pressMessage(
  alert: PressAlert,
  contact: PressContact,
  origin: string,
  replyTo: string,
): MailMessage {
  const d = pressDraft(alert, contact, origin)
  const link = (line: string) =>
    esc(line).replace(/https:\/\/\S+/g, (url) => `<a href="${url}">${url}</a>`)
  const html = d.body
    .split('\n\n')
    .map((para) => `<p>${para.split('\n').map(link).join('<br>')}</p>`)
    .join('\n')
  return {
    to: d.to,
    subject: d.subject,
    text: d.body,
    html,
    fromName: PRESS_FROM_NAME,
    replyTo,
  }
}

export interface PressOutcome {
  contact: PressContact
  to: string
  /** The provider's refusal, or null when the note went out. */
  error: string | null
}

/** The owner's receipt: which reporters got the note, and which failed. */
export function pressReceipt(
  alert: PressAlert,
  outcomes: readonly PressOutcome[],
  origin: string,
): OwnerMessage {
  const permalink = absoluteUrl(origin, `/alerts/${alert.id}`)
  const sent = outcomes.filter((o) => !o.error)
  const failed = outcomes.filter((o) => o.error)
  const line = (o: PressOutcome) =>
    `${o.contact.name}, ${o.contact.outlet} <${o.to}>${o.error ? `: ${o.error}` : ''}`
  const subject = `Press notes sent (${sent.length}/${outcomes.length}): ${alert.headline}`
  const text = [
    alert.headline,
    permalink,
    '',
    `Sent to ${sent.length}:`,
    ...sent.map((o) => `- ${line(o)}`),
    ...(failed.length
      ? ['', `Failed for ${failed.length}:`, ...failed.map((o) => `- ${line(o)}`)]
      : []),
  ].join('\n')
  const list = (items: readonly PressOutcome[]) =>
    ['<ul>', ...items.map((o) => `<li>${esc(line(o))}</li>`), '</ul>'].join('\n')
  const html = [
    `<p><strong><a href="${esc(permalink)}">${esc(alert.headline)}</a></strong></p>`,
    `<p>Sent to ${sent.length}:</p>`,
    list(sent),
    ...(failed.length ? [`<p>Failed for ${failed.length}:</p>`, list(failed)] : []),
  ].join('\n')
  return { subject, html, text, ids: [alert.id] }
}

/** The owner's mail: the alert, then one click-to-draft link per contact. */
export function pressBrief(
  alert: PressAlert,
  contacts: readonly PressContact[],
  origin: string,
): OwnerMessage {
  const notes = contacts.map((c) => ({ c, ...pressNote(alert, c, origin) }))
  const permalink = absoluteUrl(origin, `/alerts/${alert.id}`)
  const subject = `Press brief ready: ${alert.headline}`
  const text = [
    alert.headline,
    permalink,
    '',
    alert.explanation,
    '',
    `${notes.length} notes. Open one, read it, send it:`,
    ...notes.map((n) => `- ${n.c.name}, ${n.c.outlet}${n.desk ? ' (tips desk)' : ''}: ${n.href}`),
  ].join('\n')
  const html = [
    `<p><strong><a href="${esc(permalink)}">${esc(alert.headline)}</a></strong></p>`,
    `<p>${esc(alert.explanation)}</p>`,
    `<p>${notes.length} notes. Open one, read it, send it:</p>`,
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
