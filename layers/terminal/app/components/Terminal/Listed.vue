<script setup lang="ts">
// The listed-companies table on /dependencies: every ticker the graph, the
// suppliers table and the power table name, one row each. A row says what
// each table ties the company to and links to the table that has the figures.

import {
  listedEvidence,
  listedGroup,
  listedTieText,
  type ListedData,
} from '../../../shared/utils/listed'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ data: ListedData }>()

const columns: TableColumn[] = [
  { key: 'ticker', label: 'Ticker' },
  { key: 'company', label: 'Company' },
  { key: 'group', label: 'What it is' },
  { key: 'says', label: 'What ties it to a lab', class: 'w-1/2 min-w-72' },
  { key: 'evidence', label: 'Where the figures are' },
]

const rows = computed(() =>
  props.data.companies.map((c) => ({
    ticker: c.ticker,
    company: c.company,
    group: listedGroup(c),
    says: c.ties.map((t) => listedTieText(t, c)),
    evidence: c.ties.map((t) => listedEvidence(t)),
  })),
)

const note = computed(() => {
  const n = props.data.counts
  return `${n.companies} listed companies: ${n.graph} on the graph, ${n.suppliers} in the suppliers table and ${n.power} in the power table on the Compute page. Not investment advice.`
})
</script>

<template>
  <TerminalPanel id="listed" title="Listed companies" :note="note">
    <div class="space-y-4">
      <TerminalTable
        caption="Every listed company the graph, the suppliers table and the power table name, with what each source says ties it to a lab and where its figures are"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.ticker"
        align="top"
        nested
      >
        <template #cell-ticker="{ row }">
          <span class="font-mono text-highlighted">{{ row.ticker }}</span>
        </template>
        <template #cell-says="{ row }">
          <p v-for="s in row.says" :key="s" class="text-default">{{ s }}</p>
        </template>
        <template #cell-evidence="{ row }">
          <NuxtLink
            v-for="e in row.evidence"
            :key="e.to + e.text"
            :to="e.to"
            class="block underline underline-offset-2 hover:text-default"
            >{{ e.text }}</NuxtLink
          >
        </template>
      </TerminalTable>
      <p class="text-xs text-muted">{{ data.rule }}</p>
    </div>
  </TerminalPanel>
</template>
