<script setup lang="ts">
// What the listed companies guided on their earnings calls, against what
// they filed later: one row per figure, with a short quote and a link to the
// company's own page for the call. Below it, what each company posts and why
// some of its calls can't be read.

import {
  CALL_METRIC_LABEL,
  CALL_SOURCE_LABEL,
  type CallCoverage,
  type CallGuidanceData,
  type CallStatement,
} from '../../../shared/utils/call-guidance'
import { grouped, roundBillions } from '../../../shared/utils/terminal-format'
import type { TableColumn } from '../../types/terminal-ui'

const ALL = 'All companies'
const ticker = ref<string>(ALL)
const query = computed(() => (ticker.value === ALL ? {} : { ticker: ticker.value }))
const { data, error } = await useFetch<CallGuidanceData>('/api/call-guidance', { query })

const companies = ref<string[]>([])
watch(
  data,
  (d) => {
    if (d && !d.ticker) companies.value = [ALL, ...d.companies.map((c) => c.ticker)]
  },
  { immediate: true },
)

const pct = (n: number) => `${grouped(n, Number.isInteger(n) ? 0 : 1)}%`
// Under a billion in millions: $650M, not $0.7B.
const dollars = (n: number) => (n < 1e9 ? `$${grouped(n / 1e6)}M` : roundBillions(n))
const one = (n: number, unit: CallStatement['unit']) => (unit === 'USD' ? dollars(n) : pct(n))

const guided = (s: CallStatement) => {
  const prefix = s.bound === 'at_least' ? 'At least ' : s.bound === 'at_most' ? 'At most ' : ''
  const value =
    s.low === s.high ? one(s.low, s.unit) : `${one(s.low, s.unit)} to ${one(s.high, s.unit)}`
  const growth =
    s.unit === 'growth_yoy' ? ' growth' : s.unit === 'growth_qoq' ? ' sequential growth' : ''
  return `${prefix}${value}${growth}`
}

const what = (s: CallStatement) =>
  s.segment ? `${CALL_METRIC_LABEL[s.metric]}: ${s.segment}` : CALL_METRIC_LABEL[s.metric]

const resultText = (s: CallStatement) => {
  switch (s.state) {
    case 'met':
      return 'Met'
    case 'above':
    case 'below': {
      const e = s.error_share ?? 0
      const size =
        s.unit === 'USD' ? pct(Math.abs(e) * 100) : `${grouped(Math.abs(e) * 100, 1)} pts`
      return `${size} ${s.state}`
    }
    case 'open':
      return 'Not filed yet'
    default:
      return 'Not scored'
  }
}

const clock = (ms: number) => {
  const t = Math.round(ms / 1000)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

const columns: TableColumn[] = [
  { key: 'company', label: 'Company' },
  { key: 'call', label: 'Call', class: 'whitespace-nowrap' },
  { key: 'what', label: 'Guided' },
  { key: 'guided', label: 'Figure', numeric: true },
  { key: 'quote', label: 'What was said', class: 'min-w-64' },
  { key: 'actual', label: 'Filed', numeric: true },
  { key: 'result', label: 'Result' },
]

const coverageColumns: TableColumn[] = [
  { key: 'company', label: 'Company' },
  { key: 'read', label: 'Documents read', numeric: true },
  { key: 'statements', label: 'Figures', numeric: true },
  { key: 'gap', label: 'What we can’t read', class: 'min-w-64' },
]

const rowKey = (s: CallStatement) => s.id
const coverageKey = (c: CallCoverage) => c.ticker
const docs = (c: CallCoverage) =>
  c.documents.exhibit + c.documents.transcript + c.documents.remarks + c.documents.audio
const stamps = useStamps()
</script>

<template>
  <TerminalPanel
    id="call-guidance"
    title="Earnings-call guidance against filings"
    note="What the listed companies said they would do on each call, against the figure a later 10-Q or 10-K filed."
    :more="{ label: 'Every listed company', to: '/dependencies#listed' }"
  >
    <div class="space-y-4">
      <UFormField label="Company" class="flex items-center gap-2" :ui="{ label: 'text-sm' }">
        <USelect v-model="ticker" :items="companies" size="sm" class="w-44" />
      </UFormField>

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="Call guidance didn’t load"
        description="Try reloading in a minute."
      />

      <template v-else-if="data">
        <p class="max-w-2xl text-sm text-muted">
          {{ data.tally.scored }} of {{ data.tally.statements }} figures scored:
          {{ data.tally.met }} met, {{ data.tally.above }} above, {{ data.tally.below }} below.
          <template v-if="data.tally.median_abs_error !== null"
            >Median miss on dollar figures {{ pct(data.tally.median_abs_error * 100) }}.</template
          >
        </p>

        <TerminalTable
          v-if="data.statements.length"
          caption="Each figure guided on an earnings call, with the figure later filed for the same measure and period"
          :columns="columns"
          :rows="data.statements"
          :row-key="rowKey"
          align="top"
          nested
        >
          <template #cell-company="{ row }">{{ row.company }}</template>
          <template #cell-call="{ row }">
            <a
              :href="row.sources[0]?.page_url ?? row.sources[0]?.url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-primary"
            >
              <time :datetime="row.call_date">{{ stamps.date(row.call_date) }}</time>
            </a>
            <span class="block text-xs text-muted">{{ row.call_period }}</span>
          </template>
          <template #cell-what="{ row }">
            {{ what(row) }}
            <span class="block text-xs text-muted">{{ row.period }}</span>
          </template>
          <template #cell-guided="{ row }">{{ guided(row) }}</template>
          <template #cell-quote="{ row }">
            <span class="text-muted">“{{ row.quote }}”</span>
            <span class="block text-xs text-muted">
              <template v-if="row.speaker">{{ row.speaker }}, </template>
              <a
                v-for="(src, i) in row.sources"
                :key="src.url"
                :href="src.url"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-primary"
                >{{ i ? ', ' : '' }}{{ CALL_SOURCE_LABEL[src.source]
                }}<template v-if="src.at_ms !== null"> at {{ clock(src.at_ms) }}</template
                ><template v-else-if="src.page !== null"> p. {{ src.page }}</template></a
              >
            </span>
          </template>
          <template #cell-actual="{ row }">
            <template v-if="row.actual">
              <a
                :href="row.actual.filing_url"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-primary"
                >{{ one(row.actual.value, row.unit) }}</a
              >
              <span class="block font-sans text-xs text-muted"
                >{{ row.actual.form }}, {{ row.actual.filed }}</span
              >
            </template>
            <span v-else class="text-muted">—</span>
          </template>
          <template #cell-result="{ row }">
            {{ resultText(row) }}
            <span v-if="row.reason" class="block text-xs text-muted">{{ row.reason }}</span>
          </template>
        </TerminalTable>
        <TerminalGap
          v-else
          title="No call guidance read yet."
          reason="Each call is read within the hour of its release or transcript."
        />
        <p v-if="data.omitted" class="text-sm text-muted">
          The newest {{ data.statements.length }} of {{ data.statements.length + data.omitted }}.
          Pick a company for all of its calls.
        </p>

        <TerminalExpand show="What each company posts" hide="Hide what each company posts">
          <TerminalTable
            caption="For each company, how many call documents we read, how many figures they gave, and what we can’t read"
            :columns="coverageColumns"
            :rows="data.companies"
            :row-key="coverageKey"
            align="top"
            nested
          >
            <template #cell-company="{ row }">
              <a
                :href="row.ir_url"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-primary"
                >{{ row.company }}</a
              >
            </template>
            <template #cell-read="{ row }">{{ docs(row) }}</template>
            <template #cell-statements="{ row }">{{ row.statements }}</template>
            <template #cell-gap="{ row }">
              <span class="text-muted">{{ row.gap ?? '—' }}</span>
            </template>
          </TerminalTable>
        </TerminalExpand>

        <p class="max-w-2xl text-xs text-muted">
          Replays marked transcribed are our machine transcript (AssemblyAI), not the company’s;
          audio and transcripts are never published here.
        </p>
      </template>
    </div>
  </TerminalPanel>
</template>
