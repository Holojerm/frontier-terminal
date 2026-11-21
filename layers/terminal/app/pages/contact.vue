<script setup lang="ts">
// How to reach the people behind the terminal: corrections first, then everything else.
// The data is free to read, the last 90 days are CC BY, and the full history is CC BY-NC
// (shared/utils/license.ts). This page offers no commercial licensing.

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.5',
    title: 'Contact',
    summary:
      'How to send a correction, a press question, or anything else. Write to contact@frontierterm.com.',
  },
})

useSeo({
  title: 'Contact',
  description:
    'Send a correction with the page and the row’s source URL. Press and anything else go to the same address.',
})
</script>

<template>
  <TerminalPage
    title="Contact"
    lede="Found a wrong number, or have a question? Write to us."
    narrow
  >
    <TerminalPanel id="corrections" title="Corrections">
      <div class="max-w-2xl space-y-4 text-default">
        <p>
          If a number looks wrong, send a correction with the page and, if you have it, the row’s
          source URL. Every row shows the URL we read it from.
        </p>
        <UButton
          :to="mailto('Correction')"
          external
          size="lg"
          icon="i-lucide-mail"
          :label="`Email ${CONTACT_EMAIL}`"
        />
      </div>
    </TerminalPanel>

    <TerminalPanel id="other" title="Everything else">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          Press and anything else go to
          <a :href="mailto('Hello')" class="text-primary underline underline-offset-2">{{
            CONTACT_EMAIL
          }}</a
          >.
        </p>
        <p class="text-muted">
          <NuxtLink to="/data#coverage" class="text-primary underline underline-offset-2"
            >Each source’s terms</NuxtLink
          >
          ·
          <NuxtLink to="/license" class="text-primary underline underline-offset-2"
            >License and attribution</NuxtLink
          >
        </p>
      </div>
    </TerminalPanel>
  </TerminalPage>
</template>
