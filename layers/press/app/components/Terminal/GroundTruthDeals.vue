<script setup lang="ts">
// Press reports of a deal's size against what the other company filed: every
// labeled report with its result, then the filed figures a deal can be held
// to. A report no filed figure settles is listed with the reason, never scored.

import type { GroundTruthDeals } from '../../../shared/types/ground-truth'

const props = defineProps<{ deals: GroundTruthDeals; tolerancePct: number }>()

const stamps = useStamps()

const METRIC_LABEL: Record<DealMetric, string> = {
  commitment: 'Compute or cloud contract',
  investment: 'Investment in the lab',
  financing: 'Loan or credit line',
  commitment_total: 'All of the lab’s commitments',
}

const resultText = (d: GroundTruthDeal) => {
  switch (d.state) {
    case 'matched':
      return `Matched, ${signedPercent(d.error_pct!)}`
    case 'missed':
      return `Missed, ${signedPercent(d.error_pct!)}`
    case 'restated':
      return 'Already filed, not scored'
    case 'open':
      return 'Not filed yet'
    default:
      return 'No filed figure settles it'
  }
}

const filedText = (d: GroundTruthDeal) =>
  d.filed
    ? `${d.filed.label}, ${d.filed.period}: ${roundBillions(d.filed.value)}. ${d.filed.filer} ${d.filed.form}, filed ${d.filed.first_filed}.`
    : ''

const compareText = (m: GroundTruthDealMeasure) =>
  m.compares === 'added'
    ? 'Scored against the amount added in the quarter the report was published.'
    : m.compares === 'total'
      ? 'Scored against the first balance dated on or after the report.'
      : m.why

const emptyReason = computed(() =>
  props.deals.unread
    ? `A model labels the deal sizes in headlines we store. ${props.deals.unread} stored ${props.deals.unread === 1 ? 'headline is' : 'headlines are'} waiting for that reading.`
    : 'No stored headline states a deal’s size as fact.',
)

const columns: TableColumn[] = [
  { key: 'when', label: 'Reported', class: 'whitespace-nowrap' },
  { key: 'lab', label: 'Lab' },
  { key: 'title', label: 'Headline', class: 'min-w-64' },
  { key: 'amount', label: 'Amount', numeric: true },
  { key: 'with', label: 'With' },
  { key: 'result', label: 'Result', class: 'min-w-64' },
]

const measureColumns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  { key: 'filer', label: 'Filed by' },
  { key: 'deal', label: 'Kind of deal' },
  { key: 'label', label: 'Filed figure' },
  { key: 'how', label: 'How a report is checked', class: 'min-w-64' },
]

const dealKey = (d: GroundTruthDeal) => `${d.url}|${d.metric}|${d.amount_text}|${d.counterparty}`
const measureKey = (m: GroundTruthDealMeasure) => `${m.lab}|${m.filer}|${m.metric}`
</script>

<template>
  <TerminalPanel
    id="deals"
    title="Deal sizes against filings"
    note="The size of a compute, investment or financing deal as a headline stated it, against the figure the other company filed. A positive error means the press was high."
    :more="{ label: 'Every filed figure on a lab', to: '/exposure' }"
  >
    <div class="space-y-4">
      <TerminalTable
        v-if="deals.reports.length"
        caption="Each press report of a deal’s size, with the filed figure it was checked against or the reason none settles it"
        :columns="columns"
        :rows="deals.reports"
        :row-key="dealKey"
        row-header="title"
        align="top"
        nested
      >
        <template #cell-when="{ row }">
          <time :datetime="row.published_at" :title="row.published_at">{{
            stamps.absolute(row.published_at)
          }}</time>
        </template>
        <template #cell-lab="{ row }">{{ LAB_DISPLAY[row.lab] }}</template>
        <template #cell-title="{ row }">
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
            class="underline underline-offset-2 hover:text-primary"
            >{{ row.title }}</a
          >
          <span class="block text-xs text-muted"
            >{{ row.outlet }}{{ row.outlets > 1 ? ` and ${row.outlets - 1} more` : '' }}</span
          >
        </template>
        <template #cell-amount="{ row }">{{ row.amount_text }}</template>
        <template #cell-with="{ row }">
          {{ row.counterparty ?? 'All suppliers' }}
          <span class="block text-xs text-muted">{{ METRIC_LABEL[row.metric] }}</span>
        </template>
        <template #cell-result="{ row }">
          {{ resultText(row) }}
          <span v-if="row.filed" class="block text-xs text-muted">
            {{ filedText(row) }}
            <a
              :href="row.filed.filing_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-primary"
              >Filing</a
            >
          </span>
          <span v-else-if="row.why" class="block text-xs text-muted">{{ row.why }}</span>
        </template>
      </TerminalTable>
      <TerminalGap v-else title="No deal report to check yet." :reason="emptyReason" />

      <TerminalTable
        caption="The filed figures a deal report can be checked against, and how each is compared"
        :columns="measureColumns"
        :rows="deals.measures"
        :row-key="measureKey"
        align="top"
        nested
      >
        <template #cell-lab="{ row }">{{ LAB_DISPLAY[row.lab] }}</template>
        <template #cell-filer="{ row }">{{ row.filer }}</template>
        <template #cell-deal="{ row }">{{ METRIC_LABEL[row.metric] }}</template>
        <template #cell-label="{ row }">{{ row.label }}</template>
        <template #cell-how="{ row }">{{ compareText(row) }}</template>
      </TerminalTable>
    </div>
  </TerminalPanel>
</template>
