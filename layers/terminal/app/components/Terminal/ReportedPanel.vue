<script setup lang="ts">
// Reported figures on /revenue: what press headlines say each private lab
// earns, is worth and has raised. Kept apart from the filed figures above it:
// the newest report and a median per quarter for figures given as fact, then
// every recent headline, talks and forecasts included.

import { absoluteStamp, compactUsd } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type {
  ReportedBasis,
  ReportedData,
  ReportedHeadline,
  ReportedMetric,
  ReportedSeries,
} from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ reported: ReportedData }>()

const now = useNow()

const METRIC_LABEL: Record<ReportedMetric, string> = {
  revenue_run_rate: 'Run-rate revenue',
  revenue: 'Revenue',
  valuation: 'Valuation',
  funding: 'Round size',
  funding_total: 'Total raised',
}

const BASIS_LABEL: Record<ReportedBasis, string> = {
  reported: 'Reported',
  sought: 'In talks',
  projected: 'Forecast',
}

const money = (amount: number, currency: 'USD' | 'EUR') =>
  currency === 'EUR' ? compactUsd(amount).replace('$', '€') : compactUsd(amount)

const figureLabel = (h: Pick<ReportedHeadline, 'metric' | 'period'>) =>
  h.period ? `${METRIC_LABEL[h.metric]}, ${h.period}` : METRIC_LABEL[h.metric]

const seriesColumns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  { key: 'figure', label: 'Figure' },
  { key: 'latest', label: 'Latest report', numeric: true },
  { key: 'when', label: 'Reported', class: 'whitespace-nowrap' },
  { key: 'median', label: 'Quarter median', numeric: true, hint: 'by report date' },
  { key: 'reports', label: 'Reports', numeric: true },
]

const recentColumns: TableColumn[] = [
  { key: 'when', label: 'Reported', class: 'whitespace-nowrap' },
  { key: 'lab', label: 'Lab' },
  { key: 'figure', label: 'Figure' },
  { key: 'basis', label: 'Basis' },
  { key: 'amount', label: 'Amount', numeric: true },
  { key: 'title', label: 'Headline' },
]

const seriesKey = (s: ReportedSeries) => `${s.lab}|${s.metric}|${s.currency}`
const headlineKey = (h: ReportedHeadline) => `${h.url}|${h.metric}|${h.basis}|${h.amount_text}`

const quarterText = (s: ReportedSeries) => {
  const q = s.quarters[0]
  if (!q) return ''
  const range =
    q.reports > 1 ? ` (${money(q.low, s.currency)} to ${money(q.high, s.currency)})` : ''
  return `${q.quarter}: ${money(q.median, s.currency)}${range}`
}

const status = computed(() => {
  const c = props.reported.coverage
  const files = c.files_read + c.files_waiting
  return [
    `We’ve read ${c.files_read.toLocaleString('en-US')} of ${files.toLocaleString('en-US')} GDELT files since ${c.from.slice(0, 10)} for these headlines.`,
    c.unread
      ? `${c.unread} ${c.unread === 1 ? 'headline waits' : 'headlines wait'} to be read.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
})

const caveats = [
  {
    label: 'what the press sees',
    text: 'GDELT doesn’t crawl Bloomberg, Reuters, the Wall Street Journal or the Financial Times, so a figure they break shows up here when another outlet repeats it. We read headlines only, never the article.',
  },
  {
    label: 'how a figure is read',
    text: 'Our judge model labels each amount in a headline with its lab, what it measures and how firm it is. We keep a label only when the amount and the lab’s name are in the headline as written.',
  },
]
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs text-toned">{{ status }}</p>

    <template v-if="reported.series.length">
      <TerminalTable
        caption="Each lab’s newest reported figure, and the median of what was reported in the newest quarter with a report"
        :columns="seriesColumns"
        :rows="reported.series"
        :row-key="seriesKey"
        nested
      >
        <template #cell-lab="{ row }">{{ LAB_DISPLAY[row.lab] }}</template>
        <template #cell-figure="{ row }">{{ METRIC_LABEL[row.metric] }}</template>
        <template #cell-latest="{ row }">{{ money(row.latest.amount, row.currency) }}</template>
        <template #cell-when="{ row }">
          <a
            :href="row.latest.url"
            target="_blank"
            rel="noopener noreferrer"
            :title="row.latest.title"
            class="underline underline-offset-2 hover:text-primary"
          >
            <time :datetime="row.latest.published_at">{{
              absoluteStamp(row.latest.published_at, now)
            }}</time>
          </a>
          <span class="block text-xs text-muted">{{ row.latest.outlet }}</span>
        </template>
        <template #cell-median="{ row }">{{ quarterText(row) }}</template>
        <template #cell-reports="{ row }">{{ row.quarters[0]?.reports ?? 0 }}</template>
      </TerminalTable>
    </template>
    <p v-else class="text-sm text-default">No headline has been read as a reported figure yet.</p>

    <TerminalTable
      v-if="reported.recent.length"
      caption="Recent headlines that state a lab’s revenue, valuation or funding, newest first"
      :columns="recentColumns"
      :rows="reported.recent"
      :row-key="headlineKey"
      row-header="title"
      align="top"
      nested
    >
      <template #cell-when="{ row }">
        <time :datetime="row.published_at" :title="row.published_at">{{
          absoluteStamp(row.published_at, now)
        }}</time>
      </template>
      <template #cell-lab="{ row }">{{ LAB_DISPLAY[row.lab] }}</template>
      <template #cell-figure="{ row }">{{ figureLabel(row) }}</template>
      <template #cell-basis="{ row }">{{ BASIS_LABEL[row.basis] }}</template>
      <template #cell-amount="{ row }">{{ row.amount_text }}</template>
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
    </TerminalTable>

    <TerminalSources :caveats="caveats" />
  </div>
</template>
