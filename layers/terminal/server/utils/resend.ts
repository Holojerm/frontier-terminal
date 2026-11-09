// Resend over fetch: the one provider that can mail arbitrary addresses (the
// OWNER_EMAIL binding only reaches one verified inbox). No SDK, so no new
// dependency. Single sends use POST /emails, groups POST /emails/batch.

import type { SubscribeConfig } from './subscribe-config'

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

/** The most messages one /emails/batch call takes is 100; D1 binds cap us lower elsewhere. */
export const BATCH_SIZE = 50

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

function payload(cfg: SubscribeConfig, m: MailMessage) {
  return {
    from: `${cfg.appName} <${cfg.from}>`,
    to: [m.to],
    reply_to: `contact@${new URL(cfg.appUrl).hostname}`,
    subject: m.subject,
    html: m.html,
    text: m.text,
    ...(m.headers ? { headers: m.headers } : {}),
  }
}

/** Sends the messages; throws with the provider's status (never the key) on a refusal. */
export async function sendMail(
  cfg: SubscribeConfig,
  messages: MailMessage[],
  fetcher: Fetcher = fetch,
): Promise<void> {
  if (messages.length === 0) return
  const single = messages.length === 1
  const res = await fetcher(`https://api.resend.com/emails${single ? '' : '/batch'}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(
      single ? payload(cfg, messages[0]!) : messages.map((m) => payload(cfg, m)),
    ),
  })
  if (!res.ok) throw new Error(`resend ${res.status}`)
}
