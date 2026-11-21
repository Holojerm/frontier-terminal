<script setup lang="ts">
// Dependencies: the labs and the public companies around them as a graph.
// A circle is a company, sized by a figure from its own filing. A line is a
// figure one company's filing puts on another. The series behind every
// figure are on /exposure and /revenue.

import type { ListedData } from '../../shared/utils/listed'
import type { SuppliersData } from '../../shared/utils/suppliers'
import type { DependenciesData } from '../../shared/utils/terminal-dependencies'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Dependencies',
    summary:
      'A graph of the AI labs and the public companies they buy from and are funded by. Each company is a circle sized by its own filed backlog, obligations, or capex. Each line is a figure one company’s SEC filing puts on another: OpenAI’s backlog at Amazon, Microsoft’s funding commitment to OpenAI, Anthropic’s commitment to Amazon. Every figure links to its filing. Under the graph, one table of every listed company the site ties to a lab, and a table of chip, hardware and compute-rental companies with the passage in each one’s filing that names a lab or a cloud.',
  },
})

const [{ data, error }, { data: suppliers }, { data: listed }] = await Promise.all([
  useFetch<DependenciesData>('/api/dependencies'),
  useFetch<SuppliersData>('/api/suppliers'),
  useFetch<ListedData>('/api/listed'),
])

useSeo({
  title: 'Dependencies: who the AI labs buy from and who funds them, from SEC filings',
  description:
    'A graph of the AI labs and the cloud companies around them. Each line is a figure one company’s SEC filing puts on another, linked to the filing.',
  dateModified: data.value?.as_of,
})
</script>

<template>
  <TerminalPage
    title="Dependencies"
    lede="Who the labs buy compute from and who funds them, from each company’s SEC filings."
    :as-of="data?.as_of"
    :error="Boolean(error)"
    error-title="Dependencies didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalDependencies v-if="data" :graph="data">
      <template #listed>
        <TerminalListed v-if="listed?.companies.length" :data="listed" />
      </template>
      <template #suppliers>
        <TerminalSuppliers v-if="suppliers?.rows.length" :data="suppliers" />
      </template>
    </TerminalDependencies>
  </TerminalPage>
</template>
