<script setup lang="ts">
// The two things every thesis surface says last: the payload's own caveat,
// and where a missing dataset can be asked for.

import manifest from '~~/fleet.json'

import { datasetRequestUrl } from '#shared/utils/thesis-format'

defineProps<{ caveat: string }>()

const requestUrl = datasetRequestUrl(manifest.links.github)
</script>

<template>
  <TerminalPanel id="thesis-notes" title="Notes">
    <div class="max-w-2xl space-y-2 text-sm text-muted">
      <p>{{ caveat }}</p>
      <p>Not investment advice.</p>
      <p>
        Testing a claim needs a public number.
        <a
          :href="requestUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary underline underline-offset-2"
          >Request a dataset</a
        >
        on GitHub.
      </p>
    </div>
  </TerminalPanel>
</template>
