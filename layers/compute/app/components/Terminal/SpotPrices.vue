<script setup lang="ts">
// Spot against on-demand: per provider, what the same instance costs when
// it can be taken back, as a share of its own on-demand price. Providers
// are shown singly; a combined figure appears only once enough of them
// print a spot price for the same GPU (the payload decides, not the page).
// Prices read at two decimals; the exact printed value is the tooltip.

import { exactUsd, gpuHour, sharePct } from '#layers/core/shared/utils/terminal-format'
import type { Bounds, UtilizationData } from '../../../shared/utils/compute-views'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const props = defineProps<{ spot: UtilizationData['spot'] }>()

const pct = (n: number) => sharePct(n)
const range = (b: Bounds, f: (n: number) => string) =>
  f(b.low) === f(b.high) ? f(b.low) : `${f(b.low)}–${f(b.high)}`

const columns: TableColumn[] = [
  { key: 'provider_name', label: 'Provider' },
  { key: 'gpu', label: 'GPU' },
  { key: 'share', label: 'Spot as % of on-demand', numeric: true },
  { key: 'spot_price', label: 'Spot', numeric: true },
  { key: 'on_demand', label: 'On-demand', numeric: true },
  { key: 'rows', label: 'Rows', numeric: true },
  { key: 'source', label: 'Read from', keep: true },
]

const rows = computed(() =>
  props.spot.providers.map((p) => ({
    ...p,
    key: `${p.provider}:${p.gpu}`,
    on_demand: gpuHour(p.on_demand),
    on_demand_exact: exactUsd(p.on_demand),
    spot_price: range(p.spot, gpuHour),
    spot_exact: range(p.spot, exactUsd),
    share: range(p.ratio, pct),
  })),
)

const combined = computed(() => props.spot.combined.filter((c) => c.providers > 0))
</script>

<template>
  <div class="space-y-3">
    <TerminalGap
      v-if="!spot.providers.length"
      title="No spot prices yet."
      reason="None of the provider pages we read printed a spot price at the last check."
    />
    <template v-else>
      <TerminalTable
        caption="Spot price against on-demand price for the same GPU instance, per provider, in USD per GPU-hour"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.key"
        nested
      >
        <template #cell-share="{ row: r }">
          <span class="font-mono text-highlighted">{{ r.share }}</span>
        </template>
        <template #cell-spot_price="{ row: r }">
          <span :title="r.spot_exact">{{ r.spot_price }}</span>
        </template>
        <template #cell-on_demand="{ row: r }">
          <span :title="r.on_demand_exact">{{ r.on_demand }}</span>
        </template>
        <template #cell-source="{ row: r }">
          <TerminalProvenanceTag :source-url="r.source_url" :fetched-at="r.fetched_at" />
        </template>
      </TerminalTable>

      <p v-for="c in combined" :key="c.gpu" class="text-xs text-muted">
        <template v-if="c.ratio">
          {{ c.gpu }}: median across {{ c.providers }} providers
          <span class="font-mono text-highlighted">{{ range(c.ratio, pct) }}</span>
        </template>
        <template v-else>
          {{ c.gpu }}: {{ c.providers }} of the {{ spot.providers_needed }} providers we need before
          we print a combined figure.
        </template>
      </p>
    </template>

    <TerminalSources :caveats="[{ text: spot.caveat, label: 'how to read it' }]" />
  </div>
</template>
