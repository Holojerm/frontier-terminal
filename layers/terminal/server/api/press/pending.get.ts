// GET /api/press/pending — the press notes the press-drafts routine has not
// saved as Gmail drafts yet. Bearer-gated: the body names reporters.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { draftedKey, parsePressList, pendingPressAlerts, pressDraft } from '../../pipeline/press'
import { requirePressToken } from '../../utils/press-auth'

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'press', limit: 30, windowSeconds: 60 })
  await requirePressToken(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const runtime = useRuntimeConfig(event)
  const contacts = parsePressList(runtime.pressList)
  if (!contacts.length) return { alerts: [], contacts: 0 }
  const pending = await pendingPressAlerts(db, async (id) =>
    Boolean(await kv.getItem(draftedKey(id))),
  )
  return {
    contacts: contacts.length,
    alerts: pending.map((a) => ({
      id: a.id,
      headline: a.headline,
      drafts: contacts.map((c) => pressDraft(a, c, runtime.public.appUrl)),
    })),
  }
})
