<script setup lang="ts">
// CoreWeave's filed revenue per megawatt of active power, per quarter, and
// the newest quarter's revenue as a share of what that power would bill at
// its own list prices: a floor with no upper bound, because filings don't
// separate contract discount from idle capacity.

import { compactUsd, count, sharePct } from '../../../shared/utils/terminal-format'
import type { UtilizationData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ coreweave: NonNullable<UtilizationData['coreweave']> }>()

const columns: TableColumn[] = [
  { key: 'quarter', label: 'Quarter' },
  { key: 'revenue', label: 'Revenue', numeric: true },
  { key: 'power', label: 'Active power at quarter end', numeric: true },
  { key: 'per_mw', label: 'Revenue per average MW', numeric: true },
]

const rows = computed(() =>
  props.coreweave.quarters.toReversed().map((q) => ({
    key: q.period_end,
    quarter: q.quarter,
    revenue: compactUsd(q.revenue_usd),
    power: `${q.qualifier ? `${q.qualifier} ` : ''}${count(q.active_mw)} MW`,
    per_mw: q.revenue_per_mw === null ? '—' : compactUsd(q.revenue_per_mw),
  })),
)
</script>

<template>
  <div class="space-y-3">
    <p v-if="coreweave.floor" class="text-sm text-muted">
      {{ coreweave.floor.quarter }} revenue was
      <span class="font-mono text-highlighted">
        {{ sharePct(coreweave.floor.share.low) }}–{{ sharePct(coreweave.floor.share.high) }}
      </span>
      of what its active power would bill at CoreWeave’s on-demand list prices.
    </p>
    <TerminalGap
      v-if="!coreweave.quarters.length"
      title="No quarter to show yet."
      reason="We need a quarter with both a filed revenue figure and a stated active power."
    />
    <TerminalTable
      v-else
      caption="CoreWeave quarterly revenue, active power as its earnings release states it, and revenue per average megawatt"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.key"
      nested
    />
    <TerminalSources
      :sources="coreweave.sources"
      :caveats="[{ text: coreweave.caveat, label: 'why it’s a floor' }]"
    />
  </div>
</template>
