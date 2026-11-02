<script setup lang="ts">
// One thesis on the index: who it is about, where it stands claim by claim,
// and the way in.

import { statusCounts, thesisPath } from '#shared/utils/thesis-format'
import type { ThesisView } from '#shared/utils/thesis-types'

const props = defineProps<{ thesis: ThesisView }>()

const counts = computed(() => statusCounts(props.thesis.claims))
</script>

<template>
  <TerminalCard :id="`thesis-${thesis.id}`" :level="2">
    <template #title>
      <NuxtLink
        :to="thesisPath(thesis.id)"
        class="text-base hover:underline hover:underline-offset-2"
        >{{ thesis.title }}</NuxtLink
      >
      <span v-if="thesis.ticker" class="ml-2 font-mono text-muted">{{ thesis.ticker }}</span>
    </template>
    <template #meta>
      {{ thesis.claims.length }} {{ thesis.claims.length === 1 ? 'claim' : 'claims' }}
    </template>

    <p class="max-w-2xl text-sm text-default">{{ thesis.statement }}</p>

    <ThesisMeta :thesis="thesis" />

    <ul class="flex flex-wrap gap-2" aria-label="Claims by status">
      <li v-for="c in counts" :key="c.status">
        <ThesisStatusBadge :status="c.status" :count="c.n" size="sm" />
      </li>
    </ul>

    <UButton
      :to="thesisPath(thesis.id)"
      color="neutral"
      variant="outline"
      size="sm"
      trailing-icon="i-lucide-arrow-right"
      :aria-label="`Read the ${thesis.title} thesis`"
    >
      Read the thesis
    </UButton>
  </TerminalCard>
</template>
