<script setup lang="ts">
// Every open thesis: who it is about, where each claim stands, and the way
// into the claim-by-claim page. Nothing here knows which companies exist;
// the list is whatever /api/theses returns.

import type { ThesesData } from '../../../shared/utils/thesis-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Theses',
    summary:
      'Open investment theses on public companies, each a set of claims checked against a kill condition written before the data arrived.',
  },
})

const { data: theses, error } = await useFetch<ThesesData>('/api/theses')

useSeo({
  title: 'Theses',
  description:
    'Open investment theses, each a set of claims checked against a kill condition written before the data arrived, with every reading and verdict sourced.',
  dateModified: theses.value?.as_of,
  breadcrumb: [{ name: 'Theses', path: '/theses' }],
})
</script>

<template>
  <TerminalPage
    title="Theses"
    lede="A thesis is a public position: a set of claims, each with a kill condition written before the data arrived, checked against the terminal’s own numbers."
    :as-of="theses?.as_of"
    :error="Boolean(error)"
    error-title="Theses could not be read"
    error-body="The theses endpoint failed to respond. No stale or inferred status is shown in its place."
  >
    <template v-if="theses">
      <TerminalGap
        v-if="theses.theses.length === 0"
        title="No theses are open."
        reason="Each one opens with its claims and kill conditions already written."
      />
      <div v-else class="grid gap-6 lg:grid-cols-2">
        <ThesisCard v-for="thesis in theses.theses" :key="thesis.id" :thesis="thesis" />
      </div>

      <ThesisFooter :caveat="theses.caveat" />
    </template>
  </TerminalPage>
</template>
