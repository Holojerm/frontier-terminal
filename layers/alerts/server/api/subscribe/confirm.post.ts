// POST /api/subscribe/confirm — the confirmation page posts the token from the
// emailed link. A POST, so a mail scanner that only fetches links cannot
// subscribe anyone.

export default defineEventHandler(async (event) => {
  requireSubscribe(event)
  await rateLimit(event, { name: 'subscribe-confirm', limit: 20, windowSeconds: 600 })
  const parsed = tokenBody.safeParse(await readBody(event))
  const outcome = parsed.success
    ? await confirmSubscription(db, parsed.data.token, new Date())
    : 'invalid'
  if (outcome === 'invalid') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      data: { code: 'invalid_token' },
    })
  }
  return { ok: true }
})
