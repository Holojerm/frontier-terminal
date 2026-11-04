// Cron task: mail the owner a press brief for each new registration-filing
// alert (layers/terminal/server/pipeline/press.ts). Runs on the */5 tick, so a
// brief lands within minutes of the prospectus-floor alert. With no press list
// or no mail binding it returns before touching the database.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { getOpsMailer } from '#server/utils/ops-mail'
import { recordOpsEvent } from '#server/utils/ops'
import { parsePressList, pendingPressAlerts, pressBrief } from '../../pipeline/press'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const briefedKey = (id: string) => `press:briefed:${id}`

export default defineTask({
  meta: {
    name: 'press:briefs',
    description: 'Mail the owner ready-to-send press notes for each new registration filing',
  },
  async run({ context }) {
    const runtime = useRuntimeConfig()
    const contacts = parsePressList(runtime.pressList)
    const env = (context as CloudflareTaskContext | undefined)?.cloudflare?.env
    const mailer = getOpsMailer(env)
    if (!contacts.length || !mailer) return { result: { skipped: 'unconfigured' } }

    const pending = await pendingPressAlerts(db, async (id) =>
      Boolean(await kv.getItem(briefedKey(id))),
    )
    let sent = 0
    for (const alert of pending) {
      try {
        await mailer(pressBrief(alert, contacts, runtime.public.appUrl))
        await kv.setItem(briefedKey(alert.id), new Date().toISOString())
        sent++
      } catch (error) {
        await recordOpsEvent(db, {
          kind: 'press_brief_failed',
          detail: `${alert.id}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    if (sent) console.warn(JSON.stringify({ kind: 'press_briefs_sent', sent }))
    return { result: { sent } }
  },
})
