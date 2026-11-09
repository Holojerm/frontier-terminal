// Public digest subscriptions: the double opt-in, token misuse, the one-click
// unsubscribe token, which rows a digest goes to, the fan-out's batching, and
// the feature being inert without a provider key. The routes are thin wrappers
// over these functions, which take the db and the clock, so they run in workerd
// against a real D1.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../../server/db/schema'
import { BATCH_SIZE, sendMail, type MailMessage } from '../server/utils/resend'
import { subscribeBody, cleanFromPath } from '../shared/utils/subscribe'
import { subscribeConfig } from '../server/utils/subscribe-config'
import { confirmationMail, fanOutDigest } from '../server/utils/subscriber-mail'
import {
  CONFIRM_TTL_DAYS,
  PENDING_PURGE_DAYS,
  confirmSubscription,
  countConfirmed,
  markDigestSent,
  purgeStalePending,
  requestSubscription,
  selectDigestRecipients,
  unsubscribe,
  unsubscribeToken,
} from '../server/utils/subscribers'

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-09T13:00:00Z')
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
const SECRET = 'test-salt'

beforeEach(async () => {
  await db.delete(schema.subscribers)
})

const rowFor = (email: string) =>
  db.query.subscribers.findFirst({ where: eq(schema.subscribers.email, email) })

async function confirmed(email: string, at = NOW) {
  const pending = await requestSubscription(db, { email }, at)
  await confirmSubscription(db, pending!.token, at)
  return (await rowFor(email))!
}

const cfg = {
  apiKey: 'k',
  from: 'digest@example.test',
  appName: 'Frontier Terminal',
  appUrl: 'https://frontierterm.com',
}

describe('inert without a provider key', () => {
  const pub = { appName: 'x', appUrl: 'https://x.test' }
  it('is off unless both the key and the from address are set', () => {
    expect(subscribeConfig({ public: pub })).toBeNull()
    expect(subscribeConfig({ resendApiKey: 'k', public: pub })).toBeNull()
    expect(subscribeConfig({ subscribeEmailFrom: 'a@x.test', public: pub })).toBeNull()
    expect(
      subscribeConfig({ resendApiKey: '  ', subscribeEmailFrom: 'a@x.test', public: pub }),
    ).toBeNull()
  })
  it('is on with both, with the origin trimmed', () => {
    const on = subscribeConfig({
      resendApiKey: 'k',
      subscribeEmailFrom: 'a@x.test',
      public: { ...pub, appUrl: 'https://x.test/' },
    })
    expect(on?.appUrl).toBe('https://x.test')
  })
})

describe('the subscribe body', () => {
  it('lowercases and trims the address, and rejects junk', () => {
    expect(subscribeBody.parse({ email: '  Ann@Example.COM ' }).email).toBe('ann@example.com')
    for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', 'a@b.c', '<x>@y.com', 'a@b.com,c@d.com']) {
      expect(subscribeBody.safeParse({ email: bad }).success).toBe(false)
    }
  })
  it('keeps only a clean local path as the signup page', () => {
    expect(cleanFromPath('/theses/anthropic?x=1#y')).toBe('/theses/anthropic')
    expect(cleanFromPath('https://evil.test')).toBeNull()
    expect(cleanFromPath('//evil.test')).toBeNull()
    expect(cleanFromPath(undefined)).toBeNull()
  })
})

describe('double opt-in', () => {
  it('stores a pending row with a hashed token and mails nothing to a confirmed address', async () => {
    const first = await requestSubscription(
      db,
      { email: 'a@example.com', from: '/theses?x=1' },
      NOW,
    )
    expect(first?.token).toBeTruthy()
    const row = await rowFor('a@example.com')
    expect(row).toMatchObject({ status: 'pending', subscribed_from: '/theses' })
    expect(row?.confirm_token_hash).not.toBe(first!.token)
    expect(JSON.stringify(row)).not.toContain(first!.token)

    expect(await confirmSubscription(db, first!.token, later(5))).toBe('confirmed')
    expect((await rowFor('a@example.com'))?.status).toBe('confirmed')
    // Asking again, now confirmed: no mail, no change.
    expect(await requestSubscription(db, { email: 'a@example.com' }, later(60))).toBeNull()
    expect((await rowFor('a@example.com'))?.status).toBe('confirmed')
  })

  it('does not subscribe anyone from a made-up, malformed or empty token', async () => {
    await requestSubscription(db, { email: 'b@example.com' }, NOW)
    for (const token of ['', 'x', 'a'.repeat(32), 'not-the-token-at-all-0123456789']) {
      expect(await confirmSubscription(db, token, later(1))).toBe('invalid')
    }
    expect((await rowFor('b@example.com'))?.status).toBe('pending')
  })

  it('treats a repeated confirm click as success, and an expired link as invalid', async () => {
    const t = await requestSubscription(db, { email: 'c@example.com' }, NOW)
    expect(await confirmSubscription(db, t!.token, later(1))).toBe('confirmed')
    expect(await confirmSubscription(db, t!.token, later(2))).toBe('confirmed')

    const old = await requestSubscription(db, { email: 'd@example.com' }, NOW)
    const week = later((CONFIRM_TTL_DAYS * 24 + 1) * 60)
    expect(await confirmSubscription(db, old!.token, week)).toBe('invalid')
    expect((await rowFor('d@example.com'))?.status).toBe('pending')
  })

  it('answers a second request within the cooldown without a second mail, then mails a fresh link', async () => {
    const first = await requestSubscription(db, { email: 'e@example.com' }, NOW)
    expect(await requestSubscription(db, { email: 'e@example.com' }, later(2))).toBeNull()
    const second = await requestSubscription(db, { email: 'e@example.com' }, later(30))
    expect(second?.token).toBeTruthy()
    // The older link no longer works; the newer one does.
    expect(await confirmSubscription(db, first!.token, later(31))).toBe('invalid')
    expect(await confirmSubscription(db, second!.token, later(31))).toBe('confirmed')
  })

  it('does not let an old confirmation link resubscribe someone who unsubscribed', async () => {
    const t = await requestSubscription(db, { email: 'f@example.com' }, NOW)
    await confirmSubscription(db, t!.token, later(1))
    const row = (await rowFor('f@example.com'))!
    expect(await unsubscribe(db, SECRET, await unsubscribeToken(SECRET, row.id), later(2))).toBe(
      'unsubscribed',
    )
    expect(await confirmSubscription(db, t!.token, later(3))).toBe('invalid')
    // Asking afresh starts a new opt-in.
    const again = await requestSubscription(db, { email: 'f@example.com' }, later(60))
    expect((await rowFor('f@example.com'))?.status).toBe('pending')
    expect(await confirmSubscription(db, again!.token, later(61))).toBe('confirmed')
  })
})

describe('unsubscribe tokens', () => {
  it('unsubscribes with the row’s own token, repeatably', async () => {
    const row = await confirmed('g@example.com')
    const token = await unsubscribeToken(SECRET, row.id)
    expect(await unsubscribe(db, SECRET, token, later(1))).toBe('unsubscribed')
    expect(await unsubscribe(db, SECRET, token, later(2))).toBe('unsubscribed')
    expect(await rowFor('g@example.com')).toMatchObject({ status: 'unsubscribed' })
  })

  it('refuses a token for another row, a forged signature, a wrong secret and junk', async () => {
    const victim = await confirmed('h@example.com')
    const other = await confirmed('i@example.com')
    const otherToken = await unsubscribeToken(SECRET, other.id)
    const forged = `${victim.id}.${otherToken.split('.').pop()}`
    const wrongSecret = await unsubscribeToken('another-salt', victim.id)
    for (const token of [forged, wrongSecret, '', 'nodot', `${victim.id}.`, `.${otherToken}`]) {
      expect(await unsubscribe(db, SECRET, token, later(1))).toBe('invalid')
    }
    expect((await rowFor('h@example.com'))?.status).toBe('confirmed')
  })
})

describe('digest recipients', () => {
  it('selects confirmed rows only, skips any that already got this week’s, and honors the limit', async () => {
    await requestSubscription(db, { email: 'pending@example.com' }, NOW)
    const sent = await confirmed('sent@example.com')
    const fresh = await confirmed('fresh@example.com')
    const gone = await confirmed('gone@example.com')
    await unsubscribe(db, SECRET, await unsubscribeToken(SECRET, gone.id), NOW)
    await markDigestSent(db, [sent.id], later(24 * 60))

    const monday = later(8 * 24 * 60)
    const ids = (await selectDigestRecipients(db, monday, 100)).map((r) => r.email)
    // sent@ got its digest 7 days before `monday`, past the 6-day gap, so it is due again.
    expect(ids.sort()).toEqual(['fresh@example.com', 'sent@example.com'])
    const sameDay = (await selectDigestRecipients(db, later(25 * 60), 100)).map((r) => r.email)
    expect(sameDay).toEqual([fresh.email])
    expect(await selectDigestRecipients(db, monday, 1)).toHaveLength(1)
    expect(await countConfirmed(db)).toBe(2)
  })

  it('deletes only pending rows that sat unconfirmed past the purge window', async () => {
    await requestSubscription(db, { email: 'stale@example.com' }, NOW)
    await requestSubscription(
      db,
      { email: 'recent@example.com' },
      later(PENDING_PURGE_DAYS * 24 * 60 - 60),
    )
    await confirmed('kept@example.com')
    const purged = await purgeStalePending(db, later((PENDING_PURGE_DAYS + 1) * 24 * 60))
    expect(purged).toBe(1)
    expect(await rowFor('stale@example.com')).toBeUndefined()
    expect(await rowFor('recent@example.com')).toBeDefined()
    expect(await rowFor('kept@example.com')).toBeDefined()
  })
})

describe('the fan-out', () => {
  const digest = {
    subject: 's',
    html: '<a href="%%UNSUBSCRIBE_PAGE%%">u</a>',
    text: 'Unsubscribe: %%UNSUBSCRIBE_PAGE%%',
  }
  const recipients = Array.from({ length: BATCH_SIZE * 2 + 3 }, (_, i) => ({
    id: `id-${i}`,
    email: `r${i}@example.com`,
  }))

  it('sends in batches, each message with its own unsubscribe links and headers', async () => {
    const batches: MailMessage[][] = []
    const marked: string[] = []
    const result = await fanOutDigest({
      cfg,
      digest,
      recipients,
      tokenFor: async (id) => `tok-${id}`,
      send: async (m) => void batches.push(m),
      markSent: async (ids) => void marked.push(...ids),
    })
    expect(result).toEqual({
      recipients: recipients.length,
      sent: recipients.length,
      failedBatches: 0,
    })
    expect(batches.map((b) => b.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 3])
    expect(marked).toHaveLength(recipients.length)
    const m = batches[0]![0]!
    expect(m.to).toBe('r0@example.com')
    expect(m.html).toContain('https://frontierterm.com/subscribe/unsubscribe?u=tok-id-0')
    expect(m.text).toContain('https://frontierterm.com/subscribe/unsubscribe?u=tok-id-0')
    expect(m.html + m.text).not.toContain('%%')
    expect(m.headers).toEqual({
      'List-Unsubscribe': '<https://frontierterm.com/api/subscribe/unsubscribe?u=tok-id-0>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })

  it('marks only the batches the provider accepted, so a re-run sends the rest', async () => {
    let call = 0
    const marked: string[] = []
    const result = await fanOutDigest({
      cfg,
      digest,
      recipients,
      tokenFor: async (id) => id,
      send: async () => {
        if (++call === 2) throw new Error('resend 500')
      },
      markSent: async (ids) => void marked.push(...ids),
    })
    expect(result).toEqual({
      recipients: recipients.length,
      sent: BATCH_SIZE + 3,
      failedBatches: 1,
    })
    expect(marked).not.toContain(`id-${BATCH_SIZE}`)
    expect(marked).toContain('id-0')
  })
})

describe('mail', () => {
  it('builds a confirmation with the token in the link', () => {
    const m = confirmationMail(cfg, 'ab_c-d', 'x@example.com')
    expect(m.to).toBe('x@example.com')
    expect(m.text).toContain('https://frontierterm.com/subscribe/confirm?t=ab_c-d')
    expect(m.html).toContain('https://frontierterm.com/subscribe/confirm?t=ab_c-d')
  })

  it('posts one message to /emails and a group to /emails/batch, with the key only in the header', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200 })
    }
    const msg = (to: string): MailMessage => ({ to, subject: 's', html: 'h', text: 't' })
    await sendMail(cfg, [msg('a@example.com')], fetcher)
    await sendMail(cfg, [msg('a@example.com'), msg('b@example.com')], fetcher)
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.resend.com/emails',
      'https://api.resend.com/emails/batch',
    ])
    expect(JSON.parse(String(calls[0]!.init.body)).from).toBe(
      'Frontier Terminal <digest@example.test>',
    )
    expect(JSON.parse(String(calls[1]!.init.body))).toHaveLength(2)
    expect(String(calls[1]!.init.body)).not.toContain(cfg.apiKey)
    await expect(
      sendMail(cfg, [msg('a@example.com')], async () => new Response('no', { status: 422 })),
    ).rejects.toThrow('resend 422')
  })
})
