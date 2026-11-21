<script setup lang="ts">
// Capex guidance from earnings releases against the capex filed for the year:
// one row per figure a release printed, then what each filer's releases print
// and what we compare it with. A filer whose guidance we can't score is named
// with the reason.

import { grouped, roundBillions } from '#layers/core/shared/utils/terminal-format'
import type {
  GroundTruthGuidance,
  GroundTruthGuidanceData,
  GroundTruthGuidanceFiler,
} from '../../../../companies/shared/types/guidance'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const props = defineProps<{ guidance: GroundTruthGuidanceData; tolerancePct: number }>()

const guided = (g: GroundTruthGuidance) =>
  g.low === g.high ? roundBillions(g.low) : `${roundBillions(g.low)} to ${roundBillions(g.high)}`

const pct = (n: number) => `${grouped(Math.abs(n), 1)}%`

const resultText = (g: GroundTruthGuidance) => {
  const single = g.low === g.high
  switch (g.state) {
    case 'met':
      return single ? `Within ${props.tolerancePct}%` : 'Inside the range'
    case 'above':
      return single ? `${pct(g.error_pct!)} above` : `${pct(g.error_pct!)} above the range`
    case 'below':
      return single ? `${pct(g.error_pct!)} below` : `${pct(g.error_pct!)} below the range`
    case 'open':
      return 'Year not filed yet'
    default:
      return 'Not scored'
  }
}

const partsText = (g: GroundTruthGuidance) =>
  g.actual && g.actual.parts.length > 1
    ? g.actual.parts.map((p) => `${p.label}, ${roundBillions(p.value)}`).join('. ')
    : ''

const printed = computed(() => props.guidance.filers.filter((f) => f.releases_with_figure > 0))

const columns: TableColumn[] = [
  { key: 'filer', label: 'Filer' },
  { key: 'period', label: 'Year' },
  { key: 'guided', label: 'Guided capex', numeric: true },
  { key: 'release', label: 'Release', class: 'whitespace-nowrap' },
  { key: 'sentence', label: 'What the release says', class: 'min-w-64' },
  { key: 'actual', label: 'Filed capex', numeric: true },
  { key: 'result', label: 'Result' },
  { key: 'lead', label: 'Days early', numeric: true },
]

const filerColumns: TableColumn[] = [
  { key: 'filer', label: 'Filer' },
  { key: 'read', label: 'Releases read', numeric: true },
  { key: 'with', label: 'With a capex figure', numeric: true },
  { key: 'how', label: 'What we compare it with', class: 'min-w-64' },
]

const rowKey = (g: GroundTruthGuidance) => `${g.accession_no}|${g.fiscal_year}`
const filerKey = (f: GroundTruthGuidanceFiler) => f.ticker
const stamps = useStamps()
</script>

<template>
  <TerminalPanel
    id="guidance"
    title="Capex guidance against filings"
    note="What an earnings release said a filer would spend on capex in a year, against the capex its annual report filed for that year."
    :more="{ label: 'Every filed capex quarter', to: '/exposure' }"
  >
    <div class="space-y-4">
      <TerminalTable
        v-if="guidance.rows.length"
        caption="Each capex figure an earnings release printed for a fiscal year, with the capex later filed for that year"
        :columns="columns"
        :rows="guidance.rows"
        :row-key="rowKey"
        align="top"
        nested
      >
        <template #cell-filer="{ row }">{{ row.filer }}</template>
        <template #cell-period="{ row }">{{ row.period }}</template>
        <template #cell-guided="{ row }">{{ guided(row) }}</template>
        <template #cell-release="{ row }">
          <a
            :href="row.source_url"
            target="_blank"
            rel="noopener noreferrer"
            class="underline underline-offset-2 hover:text-primary"
          >
            <time :datetime="row.filed">{{ stamps.date(row.filed) }}</time>
          </a>
          <span class="block text-xs text-muted">8-K, exhibit 99.1</span>
        </template>
        <template #cell-sentence="{ row }">
          <span class="text-muted">“{{ row.sentence }}”</span>
        </template>
        <template #cell-actual="{ row }">
          <template v-if="row.actual">
            <a
              :href="row.actual.filing_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-primary"
              >{{ roundBillions(row.actual.value) }}</a
            ><TerminalCaveatMark
              v-if="partsText(row)"
              :name="`How ${row.filer}’s ${row.period} figure is added up`"
              :text="partsText(row)"
              class="ml-1 align-middle"
            />
            <span class="block font-sans text-xs text-muted"
              >{{ row.actual.form }}, {{ row.actual.first_filed }}</span
            >
          </template>
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-result="{ row }">{{ resultText(row) }}</template>
        <template #cell-lead="{ row }">
          <template v-if="row.lead_days !== null">{{ row.lead_days }}</template>
          <span v-else class="text-muted">—</span>
        </template>
      </TerminalTable>
      <TerminalGap
        v-else
        title="No guidance read yet."
        :reason="`We read each earnings release filed since ${stamps.date(guidance.since)}. None is stored yet.`"
      />

      <TerminalTable
        caption="For each filer, how many earnings releases we read, how many print a capex figure, and what that figure is compared with"
        :columns="filerColumns"
        :rows="guidance.filers"
        :row-key="filerKey"
        align="top"
        nested
      >
        <template #cell-filer="{ row }">{{ row.filer }}</template>
        <template #cell-read="{ row }">{{ row.releases_read }}</template>
        <template #cell-with="{ row }">{{ row.releases_with_figure }}</template>
        <template #cell-how="{ row }">{{ row.gap ?? row.compared_with }}</template>
      </TerminalTable>

      <p v-if="printed.length" class="max-w-2xl text-sm text-muted">
        Guidance given on the earnings call is in the next panel.
      </p>
    </div>
  </TerminalPanel>
</template>
