<script setup lang="ts">
// Ground truth: how the data checks out against what was filed later. Press
// reports of a lab's revenue are scored against the lab's own filing, and the
// alert track record's totals sit beside them (its rows are on /alerts).

import type { GroundTruthData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Ground truth',
    summary:
      'Press reports of an AI lab’s revenue checked against the SEC filing that printed the figure later: the filed value, the first report, the error in percent and the days between them. Also how often we saw a change before the press did. Reports no filing can check yet are listed with the reason.',
  },
})

const { data, error } = await useFetch<GroundTruthData>('/api/ground-truth')

useSeo({
  title: 'Ground truth: press reports of AI lab revenue against SEC filings',
  description:
    'Each press report of an AI lab’s revenue, checked against the SEC filing that printed the figure later, with the error and the days between them.',
  dateModified: data.value?.as_of,
})
</script>

<template>
  <TerminalPage
    title="Ground truth"
    lede="Press reports of a lab’s revenue, checked against the SEC filing that printed the figure later. Below that, how often we saw a change before the press did."
    :as-of="data?.as_of"
    :error="Boolean(error)"
    error-title="Ground truth didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalGroundTruth v-if="data" :truth="data" />
  </TerminalPage>
</template>
