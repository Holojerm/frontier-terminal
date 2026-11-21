// The mail subscribers get: the confirmation, and the weekly digest fanned out
// to every confirmed row. Product mail through Resend; the app's alerts are the
// fleet dashboard's job and never come through here. The digest's copy is the
// caller's (the theses:digest task builds the thesis digest); this file only
// addresses it.

/** Recipients one Monday run will mail. Beyond it the rest wait for the next run. */
export const MAX_RECIPIENTS_PER_RUN = 2500

export function confirmationMail(cfg: SubscribeConfig, token: string, to: string): MailMessage {
  const rendered = renderEmail('subscribe-confirm', {
    appName: cfg.appName,
    appUrl: cfg.appUrl,
    confirmUrl: `${cfg.appUrl}/subscribe/confirm?t=${encodeURIComponent(token)}`,
  })
  return { to, subject: `Confirm your ${cfg.appName} digest subscription`, ...rendered }
}

const PLACEHOLDER = '%%UNSUBSCRIBE_PAGE%%'

/** The link in the footnote: a page that unsubscribes on load. */
const pageUrl = (cfg: SubscribeConfig, token: string): string =>
  `${cfg.appUrl}/subscribe/unsubscribe?u=${encodeURIComponent(token)}`

/** The List-Unsubscribe target: RFC 8058 one-click POSTs straight to it. */
const apiUrl = (cfg: SubscribeConfig, token: string): string =>
  `${cfg.appUrl}/api/subscribe/unsubscribe?u=${encodeURIComponent(token)}`

export interface DigestFanOutResult {
  recipients: number
  sent: number
  failedBatches: number
}

/** One rendered digest, the same for every recipient until the unsubscribe link is filled in. */
export interface DigestCopy {
  subject: string
  html: string
  text: string
}

interface FanOutDeps {
  cfg: SubscribeConfig
  digest: DigestCopy
  recipients: readonly DigestRecipient[]
  tokenFor: (id: string) => Promise<string>
  send: (messages: MailMessage[]) => Promise<void>
  markSent: (ids: string[]) => Promise<void>
}

/**
 * Sends the digest in batches, one message per recipient with their own
 * unsubscribe link. A row is marked only after its batch is accepted, so a
 * re-run mails exactly the ones that did not get it.
 */
export async function fanOutDigest(deps: FanOutDeps): Promise<DigestFanOutResult> {
  const result: DigestFanOutResult = {
    recipients: deps.recipients.length,
    sent: 0,
    failedBatches: 0,
  }
  for (let i = 0; i < deps.recipients.length; i += BATCH_SIZE) {
    const batch = deps.recipients.slice(i, i + BATCH_SIZE)
    const messages = await Promise.all(
      batch.map(async (r): Promise<MailMessage> => {
        const token = await deps.tokenFor(r.id)
        return {
          to: r.email,
          subject: deps.digest.subject,
          html: deps.digest.html.replaceAll(PLACEHOLDER, pageUrl(deps.cfg, token)),
          text: deps.digest.text.replaceAll(PLACEHOLDER, pageUrl(deps.cfg, token)),
          headers: {
            'List-Unsubscribe': `<${apiUrl(deps.cfg, token)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      }),
    )
    try {
      await deps.send(messages)
      await deps.markSent(batch.map((r) => r.id))
      result.sent += batch.length
    } catch {
      result.failedBatches++
    }
  }
  return result
}

/**
 * The Monday fan-out: build the subscriber copy once, with `build` given the
 * placeholder each recipient's unsubscribe link replaces, then mail every
 * confirmed row. Nothing is built when no one is due.
 */
export async function sendSubscriberDigest(
  db: ExtensionDb,
  cfg: SubscribeConfig,
  secret: string,
  now: Date,
  build: (unsubscribeUrl: string) => DigestCopy,
): Promise<DigestFanOutResult> {
  const recipients = await selectDigestRecipients(db, now, MAX_RECIPIENTS_PER_RUN)
  if (recipients.length === 0) return { recipients: 0, sent: 0, failedBatches: 0 }
  const digest = build(PLACEHOLDER)
  return fanOutDigest({
    cfg,
    digest,
    recipients,
    tokenFor: (id) => unsubscribeToken(secret, id),
    send: (messages) => sendMail(cfg, messages),
    markSent: (ids) => markDigestSent(db, ids, now),
  })
}
