<script setup lang="ts">
// The webhooks section of /data's "For institutions" panel. The example body
// is built by the same function the delivery cron uses
// (layers/terminal/shared/utils/webhooks.ts), so it can't drift from what a
// client receives.

import { mailto } from '../../../shared/utils/contact'
import {
  exampleWebhookPayload,
  WEBHOOK_HEADERS,
  WEBHOOK_REPLAY_WINDOW_SECONDS,
  WEBHOOK_RETRY_HOURS,
  WEBHOOK_TIMEOUT_SECONDS,
} from '../../../shared/utils/webhooks'

const props = defineProps<{ schemaVersion?: string }>()

const site = useSiteContext()

const example = computed(() =>
  JSON.stringify(
    exampleWebhookPayload({ schemaVersion: props.schemaVersion ?? '1.x', origin: site.appUrl }),
    null,
    2,
  ),
)

const headers = computed(() =>
  [
    `${WEBHOOK_HEADERS.signature}: sha256=<hex>`,
    `${WEBHOOK_HEADERS.delivery}: whd_…`,
    `${WEBHOOK_HEADERS.timestamp}: <unix seconds>`,
    `${WEBHOOK_HEADERS.event}: alert.created`,
  ].join('\n'),
)

const node = `import { createHmac, timingSafeEqual } from 'node:crypto'

// rawBody: the request body as bytes, before any JSON parsing.
export function verify(rawBody, headers, secret) {
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
  )
  const given = Buffer.from(headers['x-frontier-signature'] ?? '')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  const sentAt = Number(headers['x-frontier-timestamp'])
  return Math.abs(Date.now() / 1000 - sentAt) <= ${WEBHOOK_REPLAY_WINDOW_SECONDS}
}`

const python = `import hashlib, hmac, time

# raw_body: the request body as bytes, before any JSON parsing.
def verify(raw_body: bytes, headers, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(headers.get("X-Frontier-Signature", ""), expected):
        return False
    sent_at = int(headers.get("X-Frontier-Timestamp", "0"))
    return abs(time.time() - sent_at) <= ${WEBHOOK_REPLAY_WINDOW_SECONDS}`

const code = 'font-mono text-highlighted'
// A code block that can overflow is a focusable region, so a keyboard can scroll it (DESIGN.md › Scroll).
const block =
  'overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default focus-visible:outline-2 focus-visible:outline-primary'
</script>

<template>
  <section id="webhooks" class="scroll-mt-24 space-y-3" aria-labelledby="institutions-webhooks">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h3 id="institutions-webhooks" class="text-highlighted">Webhooks</h3>
      <UButton
        :to="mailto('Webhook')"
        external
        icon="i-lucide-mail"
        label="Ask for a webhook"
        variant="outline"
        class="self-start sm:self-auto"
      />
    </div>
    <p>
      With a key, you can get alerts pushed to you instead of polling. Email us an https URL and the
      lowest severity you want: <code :class="code">critical</code>,
      <code :class="code">notable</code>, or <code :class="code">info</code> for everything. We set
      it up and send you a signing secret once, the same way we send keys.
    </p>
    <ul class="flex list-disc flex-col gap-1 pl-5">
      <li>
        We send an alert only after it’s on the public site, never before. That’s usually within 40
        minutes of the check that found it.
      </li>
      <li>
        Judged alerts (a model’s reading of the changes) wait an hour first, like our posts on X and
        Bluesky, so we can withdraw a bad one. A withdrawn alert is never sent.
      </li>
      <li>
        The URL must be https on port 443 with a public hostname. We don’t send to IP addresses or
        private networks, and we don’t follow redirects.
      </li>
      <li>Revoking or expiring your key stops its webhooks.</li>
    </ul>

    <p>Each delivery is a POST with a JSON body and these headers:</p>
    <pre
      :class="block"
      tabindex="0"
      role="region"
      aria-label="Webhook headers"
    ><code>{{ headers }}</code></pre>
    <pre
      :class="block"
      tabindex="0"
      role="region"
      aria-label="Example webhook body"
    ><code>{{ example }}</code></pre>
    <p class="text-muted">
      <code :class="code">alert.changes</code> has the cited rows of the
      <span class="font-mono">changes</span> table, up to 100. The permalink has all of them.
    </p>

    <p>
      Check the signature before you trust a delivery. It’s an HMAC-SHA256 of the raw body, keyed
      with your secret. The timestamp header matches <code :class="code">sent_at</code>, which is
      inside the signed body. Reject anything more than {{ WEBHOOK_REPLAY_WINDOW_SECONDS / 60 }}
      minutes off your clock, so an old delivery can’t be replayed.
    </p>
    <p class="text-highlighted">Node</p>
    <pre
      :class="block"
      tabindex="0"
      role="region"
      aria-label="Signature check in Node"
    ><code>{{ node }}</code></pre>
    <p class="text-highlighted">Python</p>
    <pre
      :class="block"
      tabindex="0"
      role="region"
      aria-label="Signature check in Python"
    ><code>{{ python }}</code></pre>

    <p>
      Answer with any 2xx within {{ WEBHOOK_TIMEOUT_SECONDS }} seconds. Anything else counts as a
      failure, and we retry after 5 minutes, then 10, 20, and so on, up to 6 hours apart, for
      {{ WEBHOOK_RETRY_HOURS }} hours. A retry has the same
      <code :class="code">{{ WEBHOOK_HEADERS.delivery }}</code
      >, so store the ids you’ve handled and skip repeats. You may get one delivery twice. If a
      delivery still fails after {{ WEBHOOK_RETRY_HOURS }} hours, we pause the webhook and get in
      touch. Missed alerts are always on
      <NuxtLink to="/alerts" class="text-primary underline underline-offset-2">/alerts</NuxtLink>
      and in the API.
    </p>
  </section>
</template>
