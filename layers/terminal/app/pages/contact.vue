<script setup lang="ts">
// How to reach the people behind the terminal — above all, how to pay for the
// data. The public site stays free and CC BY; this page is where someone who
// needs more than that (terms of their own, delivery they can depend on,
// coverage we lack) finds out who to ask, without having to guess.

import { DATA_LICENSE } from '#shared/utils/license'
import { CONTACT_EMAIL, mailto } from '../../shared/utils/contact'

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.5',
    title: 'Contact',
    summary:
      'Commercial data licensing — terms without the attribution condition, a dependable feed, full history and source payloads, custom coverage — plus corrections and press. Write to contact@frontierterm.com.',
  },
})

useSeo({
  title: 'Contact',
  description:
    'License Frontier Terminal’s data for a product, a fund or a report: your own terms, a dependable feed, full history, custom coverage. Corrections and press too.',
})
</script>

<template>
  <TerminalPage
    title="Contact"
    lede="Building a product, a fund process or a report on this data? Write to us."
    narrow
  >
    <TerminalPanel id="commercial" title="Paying for the data">
      <div class="max-w-2xl space-y-4 text-default">
        <p>
          Everything on the site stays free under {{ DATA_LICENSE.short }}. A paid arrangement is
          for what the public site cannot promise. Tell us what you need — for example:
        </p>
        <ul class="list-disc space-y-2 pl-5">
          <li>
            <strong class="text-highlighted">Terms of your own.</strong> A licence without the
            attribution condition, or one your compliance team has signed.
          </li>
          <li>
            <strong class="text-highlighted">Delivery you can depend on.</strong> A feed with a
            committed schedule instead of a public endpoint behind a per-address rate limit.
          </li>
          <li>
            <strong class="text-highlighted">History and source bytes.</strong> The full change log
            and the captured payload behind every number.
          </li>
          <li>
            <strong class="text-highlighted">Coverage we don’t have.</strong> Another lab, another
            source, another axis.
          </li>
        </ul>
        <UButton
          :to="mailto('Data licensing')"
          external
          size="lg"
          icon="i-lucide-mail"
          :label="`Email ${CONTACT_EMAIL}`"
        />
        <p class="text-sm text-muted">
          It helps to say who you are, what you would use it for, which labs or tables matter, and
          how fresh the numbers need to be.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="other" title="Everything else">
      <div class="max-w-2xl space-y-3 text-sm text-default">
        <p>
          <strong class="text-highlighted">A number looks wrong.</strong>
          <a :href="mailto('Correction')" class="text-primary underline underline-offset-2"
            >Send a correction</a
          >
          with the page and, if you have it, the row’s source URL — every row prints the one it was
          read from.
        </p>
        <p>
          <strong class="text-highlighted">Press and everything else.</strong> The same address:
          <a :href="mailto('Hello')" class="text-primary underline underline-offset-2">{{
            CONTACT_EMAIL
          }}</a
          >.
        </p>
      </div>
    </TerminalPanel>
  </TerminalPage>
</template>
