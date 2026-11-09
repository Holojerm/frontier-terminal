<script setup lang="ts">
// Every open thesis: who it is about, where each claim stands, and the way
// into the claim-by-claim page. Nothing here knows which companies exist;
// the list is whatever /api/theses returns.

import { thesisCardView, type ThesisCardView } from '../../../shared/utils/thesis-format'
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

// Cards need each claim's status only; transform runs before the payload is serialised.
const { data: theses, error } = await useFetch('/api/theses', {
  key: 'theses-cards',
  transform: (d: ThesesData): Omit<ThesesData, 'theses'> & { theses: ThesisCardView[] } => ({
    ...d,
    theses: d.theses.map(thesisCardView),
  }),
})

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
    lede="A thesis is a public position. It’s a set of claims, each with a kill condition written before the data arrived, checked against our own numbers."
    :as-of="theses?.as_of"
    :error="Boolean(error)"
    error-title="Theses didn’t load"
    error-body="We won’t show an old status in its place. Try reloading in a minute."
  >
    <template v-if="theses">
      <TerminalGap
        v-if="theses.theses.length === 0"
        title="No theses are open."
        reason="Each one opens with its claims and kill conditions already written."
      />
      <div v-else class="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
        <ThesisCard v-for="thesis in theses.theses" :key="thesis.id" :thesis="thesis" />
      </div>

      <ThesisFooter :caveat="theses.caveat" />
    </template>
  </TerminalPage>
</template>
