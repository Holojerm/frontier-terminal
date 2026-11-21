<script setup lang="ts">
// The listed-companies table on /dependencies: every ticker the graph, the
// suppliers table and the power table name, one row each. A row says what
// each table ties the company to and links to the table that has the figures.
// With `lab` (a lab page) the payload is the companies tied to that lab
// (/api/listed?lab=), and the counts are of that set. With two labs (a compare
// page) it is the companies tied to both. A company whose job board we read
// links to its open roles on /hiring.

import {
  listedEvidence,
  listedGroup,
  listedTieText,
  type ListedData,
} from '../../../shared/utils/listed'
import { count } from '#layers/core/shared/utils/terminal-format'
import type { ListedHiringData } from '../../../../talent/shared/utils/listed-hiring'
import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'
import type { LabId } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const props = defineProps<{ data: ListedData; lab?: LabId | readonly [LabId, LabId] }>()

const { data: hiring } = await useFetch<ListedHiringData>('/api/hiring/listed')

/** "316 open roles, 44 data-center" for a company whose board we read. */
function hiringEvidence(ticker: string): { text: string; to: string }[] {
  const b = hiring.value?.boards.find((x) => x.ticker === ticker && x.latest)
  if (!b?.latest) return []
  const dc = `${count(b.latest.datacenter)} data-center`
  const text =
    b.latest.total === null ? `${dc} roles open` : `${count(b.latest.total)} open roles, ${dc}`
  return [{ text, to: `/hiring#listed-${ticker}` }]
}

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
    evidence: [...c.ties.map((t) => listedEvidence(t)), ...hiringEvidence(c.ticker)],
  })),
)

const note = computed(() => {
  const n = props.data.counts
  const lab = props.lab
  const tied = !lab
    ? ''
    : typeof lab === 'string'
      ? ` tied to ${LAB_DISPLAY[lab]}`
      : ` tied to both ${LAB_DISPLAY[lab[0]]} and ${LAB_DISPLAY[lab[1]]}`
  return `${n.companies} listed ${n.companies === 1 ? 'company' : 'companies'}${tied}: ${n.graph} on the graph, ${n.suppliers} in the suppliers table and ${n.power} in the power table on the Compute page. Not investment advice.`
})
</script>

<template>
  <TerminalPanel
    id="listed"
    title="Listed companies"
    :note="note"
    :more="lab ? { label: 'Every listed company, and the graph', to: '/dependencies' } : undefined"
  >
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
