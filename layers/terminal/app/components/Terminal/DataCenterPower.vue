<script setup lang="ts">
// Epoch AI's estimate of data-center power, per lab by named user. A shared
// site counts in full for each lab that uses it, so the rows do not add up
// to the total, which is stated on its own line.

import { count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { DataCentersData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ data: DataCentersData; labs?: string[] }>()

const mw = (v: number) => `${count(Math.round(v))} MW`
const h100 = (v: number) => `${(v / 1e6).toFixed(2)}M`

const columns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  { key: 'mw', label: 'Power', numeric: true },
  { key: 'h100e', label: 'H100-equivalents', numeric: true },
  { key: 'sites', label: 'Sites', numeric: true, hint: 'shared' },
  { key: 'largest', label: 'Largest' },
]
const rows = computed(() =>
  props.data.labs
    .filter((l) => !props.labs || props.labs.includes(l.lab))
    .map((l) => ({
      key: l.lab,
      lab: LAB_DISPLAY[l.lab],
      mw: mw(l.mw),
      h100e: h100(l.h100e),
      sites: l.shared ? `${l.sites} (${l.shared})` : String(l.sites),
      largest: l.names.slice(0, 3).join(', '),
    })),
)
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-muted">
      <span class="font-mono text-highlighted">{{ mw(data.total_mw) }}</span>
      across {{ count(data.sites) }} sites, {{ h100(data.total_h100e) }} H100-equivalents, as of
      Epoch’s data on {{ data.snapshot }}.
    </p>
    <TerminalTable
      caption="Estimated data-center power per lab, by Epoch AI’s named users"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.key"
      nested
    />
    <TerminalGap
      v-for="l in (data.speculative_only ?? []).filter((x) => !labs || labs.includes(x))"
      :key="l"
      inline
      :title="`${LAB_DISPLAY[l]}: no site counted`"
      reason="Epoch names this lab as a user only at #speculative, which we don’t count."
    />
    <TerminalSources
      :sources="data.source ? [data.source] : []"
      :caveats="[{ text: data.caveat, label: 'estimates' }]"
    >
      <span>CC BY 4.0, Epoch AI</span>
    </TerminalSources>
  </div>
</template>
