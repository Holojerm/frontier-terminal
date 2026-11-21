<script setup lang="ts">
// The hardware layer: the monthly prints of the foundry, the server builders and
// their suppliers in Taiwan and Korea's chip exports (read hourly from the
// exchange, TSMC's 6-Ks and Korea Customs Service's releases,
// layers/terminal/shared/utils/prints.ts), then the chip and hardware suppliers whose
// own filings tie them to a lab or a cloud. The compute-rental and hosting
// suppliers stay on /dependencies beside the graph.

import type { PrintsData } from '../../shared/utils/prints'
import { HARDWARE_LAYERS, type SuppliersData } from '../../shared/utils/suppliers'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Hardware',
    summary:
      'The monthly revenue of TSMC and the Taiwan server, networking and power makers as first printed, with each revision, Korea’s chip exports for the first 10 and 20 days and the whole month, the quoted ties naming who each company builds for, and the chip, memory, networking, server and cooling companies whose own SEC filings tie them to a lab or a cloud, each with its source page.',
  },
})

const [{ data: prints, error }, { data: suppliers }] = await Promise.all([
  useFetch<PrintsData>('/api/prints'),
  useFetch<SuppliersData>('/api/suppliers'),
])

useSeo({
  title: 'TSMC and Taiwan AI server monthly revenue, Korea chip exports, and AI hardware suppliers',
  description:
    'Monthly revenue of TSMC and the Taiwan server and component makers as first printed, Korea’s chip exports, and the hardware suppliers whose filings name a lab.',
  dateModified: prints.value?.as_of ?? undefined,
})
</script>

<template>
  <TerminalPage
    title="Hardware"
    lede="What the foundry and the server builders bill each month, and which chip and hardware makers name a lab in their filings."
    :as-of="prints?.as_of"
    :error="Boolean(error)"
    error-title="Hardware prints didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalPanel
      v-if="prints"
      id="prints"
      title="Hardware prints"
      note="Monthly revenue of the foundry, the server builders and their suppliers in Taiwan, and Korea’s chip exports, as each was first printed."
    >
      <TerminalHardwarePrints :data="prints" />
    </TerminalPanel>

    <TerminalSuppliers
      v-if="suppliers?.rows.length"
      id="suppliers"
      title="Hardware suppliers"
      :data="suppliers"
      :layers="HARDWARE_LAYERS"
    />
  </TerminalPage>
</template>
