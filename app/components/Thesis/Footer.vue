<script setup lang="ts">
// The two things every thesis surface says last: the payload's own caveat,
// and where a missing dataset can be asked for.

import manifest from '~~/fleet.json'

import { datasetRequestUrl } from '#shared/utils/thesis-format'

defineProps<{ caveat: string }>()

const requestUrl = datasetRequestUrl(manifest.links.github)
</script>

<template>
  <section aria-labelledby="thesis-notes" class="max-w-2xl space-y-3">
    <h2 id="thesis-notes" class="text-xl text-highlighted">Notes</h2>
    <p class="text-sm text-muted">{{ caveat }}</p>
    <p class="text-sm text-muted">Not investment advice.</p>
    <p class="text-sm text-muted">
      A claim you would like tested needs a public number behind it.
      <a
        :href="requestUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-primary underline underline-offset-2"
        >Request a dataset</a
      >
      on GitHub.
    </p>
  </section>
</template>
