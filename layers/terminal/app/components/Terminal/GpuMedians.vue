<script setup lang="ts">
// GPU rental list prices: per GPU the median across providers, then each
// provider once at the median of its own counted rows, with its page.

import { money } from '../../../shared/utils/terminal-format'
import type { GpuPricesData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

defineProps<{ gpu: GpuPricesData }>()

const columns: TableColumn[] = [
  { key: 'provider_name', label: 'Provider' },
  { key: 'price', label: '$ per GPU-hour', numeric: true },
  { key: 'rows', label: 'Rows counted', numeric: true },
  { key: 'source', label: 'Read from', keep: true },
]
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3 lg:grid-cols-2">
      <TerminalCard v-for="m in gpu.medians" :id="`gpu-${m.gpu}`" :key="m.gpu" :title="m.gpu">
        <template #meta>
          <span v-if="m.median !== null">
            median <span class="font-mono text-highlighted">{{ money(m.median) }}</span> across
            {{ m.providers.length }} providers
          </span>
        </template>
        <TerminalTable
          :caption="`On-demand ${m.gpu} list price per GPU-hour, per provider`"
          :columns="columns"
          :rows="m.providers.map((p) => ({ ...p, price: money(p.usd_per_gpu_hour) }))"
          :row-key="(p) => p.provider"
          nested
        >
          <template #cell-source="{ row: p }">
            <TerminalProvenanceTag :source-url="p.source_url" :fetched-at="p.fetched_at" />
          </template>
        </TerminalTable>
      </TerminalCard>
    </div>
    <TerminalGap
      v-for="f in gpu.failed"
      :key="f.provider"
      inline
      :title="`${f.provider_name} left out today`"
      :reason="f.detail"
    />
    <TerminalSources
      :caveats="[
        { text: gpu.method, label: 'method' },
        { text: gpu.caveat, label: 'list prices' },
      ]"
    />
  </div>
</template>
