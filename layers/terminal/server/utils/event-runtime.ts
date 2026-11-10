// Builds the production EventDeps (event-work.ts) from runtime config and the
// Worker env, for the queue consumer and the events:sweep backstop. Each
// outbox is null when its secret is unset, which is how an unconfigured
// outbox stays free: its steps never touch D1.
//
// `db` and `kv` are imported explicitly for the reason terminal-handler.ts gives.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { createBufferPublisher } from '#layers/social/server/utils/buffer'
import { readSocialConfig } from '#layers/social/server/utils/social'
import { recordOpsEvent } from '#server/utils/ops'

import { parsePressList } from '../pipeline/press'
import { SCHEMA_VERSION } from './data-schema'
import type { EventDeps } from './event-work'
import type { MailMessage } from './resend'
import type { CacheStore } from './terminal-cache'
import { terminalStamps } from './terminal-cache'
import { getOwnerMailer } from './owner-mail'
import { sendMail } from './resend'
import { subscribeConfig } from './subscribe-config'
import { fetchWebhookSender, signingKeyRefusal } from './webhook-sign'

export const kvStore: CacheStore = {
  get: (key) => kv.getItem(key),
  set: (key, value, opts) => kv.setItem(key, value as never, opts),
}

export function eventDeps(env: Record<string, unknown> | undefined): EventDeps {
  const runtime = useRuntimeConfig()
  const origin = runtime.public.appUrl
  const social = readSocialConfig(runtime.social)
  const signingKey = runtime.webhookSigningKey
  const contacts = parsePressList(runtime.pressList)
  const mailer = getOwnerMailer(env)

  return {
    db,
    store: kvStore,
    now: () => new Date(),
    social: social
      ? { config: social, publisher: createBufferPublisher(social.apiKey), origin }
      : null,
    webhooks: signingKeyRefusal(signingKey)
      ? null
      : {
          signingKey,
          origin,
          schemaVersion: SCHEMA_VERSION,
          stamp: async () => (await terminalStamps(db)).poll,
          send: fetchWebhookSender(),
        },
    press:
      contacts.length && mailer
        ? {
            contacts,
            mailer,
            origin,
            briefed: kvStore,
            send: pressSender(runtime),
            replyTo: runtime.ownerEmailTo,
          }
        : null,
    record: (kind, detail) => recordOpsEvent(db, { kind, detail }),
  }
}

/** Resend, sending from the press address; null until both are configured. */
function pressSender(runtime: ReturnType<typeof useRuntimeConfig>) {
  const resend = subscribeConfig({
    resendApiKey: runtime.resendApiKey,
    subscribeEmailFrom: runtime.pressEmailFrom,
    public: runtime.public,
  })
  return resend ? (message: MailMessage) => sendMail(resend, [message]) : null
}
