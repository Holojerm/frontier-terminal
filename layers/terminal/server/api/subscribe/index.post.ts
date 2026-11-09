// POST /api/subscribe — ask for the weekly digest. Double opt-in: this only
// records the address as pending and mails a confirmation link. The answer is
// the same whether the address is new, pending, confirmed or unsubscribed, so
// the form cannot be used to learn who subscribes. 404 until Resend is set up.

import { db } from '@nuxthub/db'

import { logEvent } from '#server/utils/log'
import { rateLimit } from '#server/utils/rate-limit'

import { subscribeBody } from '../../../shared/utils/subscribe'
import { sendMail } from '../../utils/resend'
import { requireSubscribe } from '../../utils/subscribe-config'
import { confirmationMail } from '../../utils/subscriber-mail'
import { requestSubscription } from '../../utils/subscribers'

export default defineEventHandler(async (event) => {
  const cfg = requireSubscribe(event)
  await rateLimit(event, { name: 'subscribe', limit: 5, windowSeconds: 600 })
  // A flood from many addresses is the other way to burn the mail quota.
  await rateLimit(event, {
    name: 'subscribe-all',
    limit: 300,
    windowSeconds: 3600,
    identifier: 'all',
  })

  const parsed = subscribeBody.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      data: { code: 'invalid_email', message: parsed.error.issues[0]?.message },
    })
  }
  const { email, from, website } = parsed.data
  // A bot filled the hidden field: look like success, store nothing.
  if (website) return { ok: true }

  const pending = await requestSubscription(db, { email, from }, new Date())
  if (pending) {
    try {
      await sendMail(cfg, [confirmationMail(cfg, pending.token, email)])
    } catch (error) {
      // The row exists; asking again after the cooldown mails a fresh link.
      logEvent('error', 'subscribe_mail_failed', { error: String(error) })
      throw createError({ statusCode: 502, statusMessage: 'Bad Gateway' })
    }
  }
  return { ok: true }
})
