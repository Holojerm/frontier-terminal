// POST /api/press/drafted { id } — the routine saved every draft for this
// alert; it is not offered again.

import { kv } from '@nuxthub/kv'
import { z } from 'zod'

import { requirePressToken } from '../../utils/press-auth'
import { draftedKey } from '../../pipeline/press'

const Body = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) })

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'press', limit: 30, windowSeconds: 60 })
  await requirePressToken(event)
  const { id } = await readValidatedBody(event, Body.parse)
  await kv.setItem(draftedKey(id), new Date().toISOString())
  return { ok: true }
})
