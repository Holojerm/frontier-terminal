<script setup lang="ts">
// Ground truth: how the data checks out against what was filed later. Press
// reports of a lab's revenue are scored against the lab's own filing, press
// reports of a deal's size against the other company's filing, and capex
// guidance against the year's filed capex. The alert track record's totals
// sit beside them (its rows are on /alerts).

import type { GroundTruthData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Ground truth',
    summary:
      'Press reports of an AI lab’s revenue checked against the SEC filing that printed the figure later: the filed value, the first report, the error in percent and the days between them. Press reports of a deal’s size checked against what the other company filed. Capex guidance from Meta, Alphabet, and Oracle earnings releases checked against the capex filed for the year, and what the listed companies around the labs guided on their earnings calls, checked against what they filed later. Also how often we saw a change before the press did. Anything no filing can check is listed with the reason.',
  },
})

const { data, error } = await useFetch<GroundTruthData>('/api/ground-truth')

useSeo({
  title: 'Ground truth: press reports and capex guidance against SEC filings',
  description:
    'Press reports of an AI lab’s revenue and deal sizes, and hyperscaler capex guidance, each checked against the SEC filing that printed the figure later.',
  dateModified: data.value?.as_of,
})
</script>

<template>
  <TerminalPage
    title="Ground truth"
    lede="Press reports of a lab’s revenue and deal sizes, and the guidance in earnings releases and calls, checked against the SEC filing that printed the figure later. Below that, how often we saw a change before the press did."
    :as-of="data?.as_of"
    :error="Boolean(error)"
    error-title="Ground truth didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalGroundTruth v-if="data" :truth="data" />
  </TerminalPage>
</template>
