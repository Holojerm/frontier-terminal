<script setup lang="ts">
// One thesis on the index: who it is about, where it stands claim by claim,
// and the way in.

import { statusCounts, thesisPath } from '#shared/utils/thesis-format'
import type { ThesisView } from '#shared/utils/thesis-types'

const props = defineProps<{ thesis: ThesisView }>()

const counts = computed(() => statusCounts(props.thesis.claims))
</script>

<template>
  <article
    :aria-labelledby="`thesis-${thesis.id}`"
    class="space-y-4 rounded border border-default p-4 sm:p-6"
  >
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 :id="`thesis-${thesis.id}`" class="text-2xl text-highlighted">
        <NuxtLink :to="thesisPath(thesis.id)" class="hover:underline">{{
          thesis.company_name
        }}</NuxtLink>
      </h2>
      <span v-if="thesis.ticker" class="font-mono text-sm text-toned">{{ thesis.ticker }}</span>
    </header>

    <p class="max-w-2xl text-default">{{ thesis.statement }}</p>

    <ThesisMeta :thesis="thesis" />

    <div class="space-y-2">
      <p class="text-sm text-toned">
        {{ thesis.claims.length }} {{ thesis.claims.length === 1 ? 'claim' : 'claims' }}
      </p>
      <ul class="flex flex-wrap gap-2" aria-label="Claims by status">
        <li v-for="c in counts" :key="c.status">
          <ThesisStatusBadge :status="c.status" :count="c.n" size="sm" />
        </li>
      </ul>
    </div>

    <UButton
      :to="thesisPath(thesis.id)"
      color="neutral"
      variant="outline"
      trailing-icon="i-lucide-arrow-right"
      :aria-label="`Read the ${thesis.company_name} thesis`"
    >
      Read the thesis
    </UButton>
  </article>
</template>
