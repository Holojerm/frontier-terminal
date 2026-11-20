<script setup lang="ts">
// The ground-truth page's panels: press reports of a lab's revenue against the
// figure its filing printed later, the reports nothing filed can score yet,
// deal sizes and capex guidance against filings (each its own component), and
// the alert track record's totals. A report read back from GDELT's archive
// is counted as the press's, never as ours: `held` says which we had stored.
// With `lab` (a lab page) the payload is that lab's alone (/api/ground-truth?lab=),
// and the panels about every lab (capex guidance, alerts, the method) are left
// to /ground-truth.

import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type {
  GroundTruthData,
  LabId,
  GroundTruthFiled,
  GroundTruthReport,
  GroundTruthResolution,
  GroundTruthWaiting,
  ReportedMetric,
  TrackRecordTally,
} from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ truth: GroundTruthData; lab?: LabId }>()

const figures = useFigures()
const stamps = useStamps()

const METRIC_LABEL: Record<ReportedMetric, string> = {
  revenue_run_rate: 'Run-rate revenue',
  revenue: 'Revenue',
  valuation: 'Valuation',
  funding: 'Round size',
  funding_total: 'Total raised',
}

/** '+0.3%' when the report was above the filed figure, '−0.9%' when below. */
const pct = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const money = (amount: number, currency: 'USD' | 'EUR') =>
  currency === 'EUR' ? figures.usd(amount).replace('$', '€') : figures.usd(amount)

/** Two decimals in billions: $17.0B filed beside $16.8B reported would hide a 0.9% gap. */
const precise = (n: number) => {
  const compact = figures.usd(n)
  return compact.endsWith('B') ? `$${(n / 1e9).toFixed(2)}B` : compact
}

const derivedText = (f: GroundTruthFiled) => {
  const [long, short] = f.derived_from ?? []
  if (!long || !short) return ''
  return `No filing prints this period. It’s ${precise(long.val)} for the period ending ${long.end} minus ${precise(short.val)} for the one ending ${short.end}.`
}

const rangeText = (r: GroundTruthResolution) =>
  r.reports.length > 1 && r.low !== r.high ? `${precise(r.low)} to ${precise(r.high)}` : ''

const tally = computed(() => props.truth.tally)

const summary = computed(() => {
  const t = tally.value
  if (t.reports === 0) return ['No filing has printed a revenue figure the press reported first.']
  const lines = [
    `${plural(t.reports, 'press report')} stated a revenue figure before a filing printed it, across ${plural(t.periods, 'filed figure')}.`,
    `The median report was ${t.median_abs_error_pct!.toLocaleString('en-US', { maximumFractionDigits: 1 })}% from the filed number.`,
    `The first report of each figure came a median of ${plural(t.median_lead_days!, 'day')} before the filing.`,
  ]
  if (t.missed) {
    lines.push(
      `${plural(t.missed, 'report')} named a period and ${t.missed === 1 ? 'was' : 'were'} more than ${props.truth.tolerance_pct}% off.`,
    )
  }
  return lines
})

const heldText = computed(() => {
  const t = tally.value
  if (t.reports === 0 || !props.truth.first_stored_at) return ''
  const since = props.truth.first_stored_at.slice(0, 10)
  return t.held === t.reports
    ? 'We had stored every one of them before the filing day.'
    : `We had stored ${t.held} of the ${t.reports} before the filing day. We began storing headlines on ${since} and read the earlier ones back from GDELT’s archive. Those show the press had the number first. Our store didn’t have it yet.`
})

const leftOut = computed(() => {
  const t = tally.value
  return [
    t.restated
      ? `${plural(t.restated, 'report')} came on or after the filing day, so ${t.restated === 1 ? 'it isn’t' : 'they aren’t'} scored.`
      : '',
    t.open
      ? `${plural(t.open, 'report')} ${t.open === 1 ? 'isn’t' : 'aren’t'} within ${props.truth.tolerance_pct}% of any filed figure.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
})

const dealsText = computed(() => {
  const t = props.truth.deals.tally
  if (t.reports === 0) return 'No press report of a deal’s size has been labeled yet.'
  const parts = [`${plural(t.reports, 'press report')} stated the size of a deal as fact.`]
  parts.push(
    t.scored
      ? `${t.scored} could be checked against a figure filed later, and ${t.scored - t.missed} ${t.scored - t.missed === 1 ? 'was' : 'were'} within ${props.truth.tolerance_pct}%.`
      : 'None could be checked against a figure filed later.',
  )
  if (t.unsettled) {
    parts.push(
      `${t.unsettled} ${t.unsettled === 1 ? 'states' : 'state'} a figure no filing we read settles.`,
    )
  }
  if (t.restated) {
    parts.push(`${t.restated} ${t.restated === 1 ? 'repeats' : 'repeat'} a figure already filed.`)
  }
  if (t.open) parts.push(`${t.open} ${t.open === 1 ? 'waits' : 'wait'} for a filing.`)
  return parts.join(' ')
})

const guidanceText = computed(() => {
  const t = props.truth.guidance.tally
  if (t.figures === 0) return 'No capex guidance from an earnings release is stored yet.'
  const parts = [
    `${plural(t.figures, 'capex figure')} from earnings releases, ${t.scored} for a year that has since been filed.`,
  ]
  if (t.scored) {
    const outside = [
      t.above ? `above it for ${t.above}` : '',
      t.below ? `below it for ${t.below}` : '',
    ].filter(Boolean)
    parts.push(
      `The filed capex met the guidance for ${t.met}${outside.length ? ` and came in ${outside.join(' and ')}` : ''}.`,
    )
  }
  if (t.open) parts.push(`${t.open} ${t.open === 1 ? 'is' : 'are'} for a year not filed yet.`)
  if (t.unsettled) {
    parts.push(`${t.unsettled} ${t.unsettled === 1 ? 'isn’t' : 'aren’t'} scored.`)
  }
  return parts.join(' ')
})

const dealsSince = computed(() => props.truth.deals.first_labeled_at?.slice(0, 10) ?? null)

const pressText = (t: TrackRecordTally) =>
  t.matched === 0
    ? 'No alert has a rated press report yet.'
    : `Of ${plural(t.matched, 'alert')} with a rated press report, we saw ${t.led} first and the press saw ${t.lagged} first.${
        t.median_lead_hours === null
          ? ''
          : ` The median lead is ${t.median_lead_hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hours.`
      }`

const newsroomText = (t: TrackRecordTally) =>
  t.matched === 0
    ? 'No alert has a rated newsroom post yet.'
    : `Of ${plural(t.matched, 'alert')} with a rated post on the lab’s own newsroom, we saw ${t.led} before the lab posted and the lab posted ${t.lagged} first.`

const scored = computed(() => props.truth.resolutions.flatMap((r) => r.reports))

const reasonText = (w: GroundTruthWaiting) =>
  w.reason === 'no-filing'
    ? `${LAB_DISPLAY[w.lab]} hasn’t filed its own revenue with the SEC.`
    : 'We don’t read this figure from a filing.'

const resolutionColumns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  { key: 'period', label: 'Period' },
  { key: 'filed', label: 'Filed figure', numeric: true },
  { key: 'filing', label: 'First filed', class: 'whitespace-nowrap' },
  { key: 'first', label: 'First report', class: 'whitespace-nowrap' },
  { key: 'median', label: 'Median report', numeric: true },
  { key: 'error', label: 'Error', numeric: true, hint: 'median against filed' },
  { key: 'lead', label: 'Days early', numeric: true, hint: 'first report' },
  { key: 'reports', label: 'Reports', numeric: true },
  { key: 'held', label: 'Stored before', numeric: true, hint: 'the filing day' },
]

const reportColumns: TableColumn[] = [
  { key: 'when', label: 'Reported', class: 'whitespace-nowrap' },
  { key: 'lab', label: 'Lab' },
  { key: 'title', label: 'Headline', class: 'min-w-64' },
  { key: 'amount', label: 'Amount', numeric: true },
  { key: 'against', label: 'Compared with' },
  { key: 'error', label: 'Error', numeric: true },
  { key: 'lead', label: 'Days early', numeric: true },
]

const openColumns: TableColumn[] = [
  { key: 'when', label: 'Reported', class: 'whitespace-nowrap' },
  { key: 'lab', label: 'Lab' },
  { key: 'title', label: 'Headline', class: 'min-w-64' },
  { key: 'amount', label: 'Amount', numeric: true },
  { key: 'against', label: 'Nearest filed figure' },
  { key: 'error', label: 'Gap', numeric: true },
]

const waitingColumns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  { key: 'figure', label: 'Figure' },
  { key: 'reports', label: 'Reports', numeric: true },
  { key: 'latest', label: 'Latest report', numeric: true },
  { key: 'when', label: 'Reported', class: 'whitespace-nowrap' },
  { key: 'why', label: 'Why it isn’t scored' },
]

const resolutionKey = (r: GroundTruthResolution) => `${r.lab}|${r.filed.start}|${r.filed.end}`
const reportKey = (r: GroundTruthReport) => `${r.url}|${r.amount_text}`
const waitingKey = (w: GroundTruthWaiting) => `${w.lab}|${w.metric}|${w.currency}`
</script>

<template>
  <div class="space-y-6">
    <TerminalPanel
      id="summary"
      :title="lab ? 'Press against filings' : 'Summary'"
      :note="
        lab
          ? `Press reports of ${LAB_DISPLAY[lab]}’s revenue and deals, scored against the filing that printed the figure later.`
          : undefined
      "
      :more="lab ? { label: 'Every lab, and how we score it', to: '/ground-truth' } : undefined"
    >
      <div class="max-w-2xl space-y-2 text-sm text-default">
        <p>{{ summary.join(' ') }}</p>
        <p v-if="heldText">{{ heldText }}</p>
        <p v-if="leftOut" class="text-muted">{{ leftOut }}</p>
        <p>{{ dealsText }}</p>
        <p v-if="!lab">{{ guidanceText }}</p>
      </div>
    </TerminalPanel>

    <TerminalPanel
      v-if="!lab || truth.resolutions.length"
      id="filed"
      title="Press reports against filings"
      note="Revenue a headline stated before the lab’s own filing printed it. A positive error means the press was high."
      :more="{ label: 'Every filed period', to: '/revenue' }"
    >
      <div class="space-y-3">
        <TerminalTable
          v-if="truth.resolutions.length"
          caption="Each filed revenue figure the press reported first, with the first report, the median report, the error and the days between them"
          :columns="resolutionColumns"
          :rows="truth.resolutions"
          :row-key="resolutionKey"
          row-header="period"
          align="top"
          nested
        >
          <template #cell-lab="{ row }">{{ LAB_DISPLAY[row.lab] }}</template>
          <template #cell-period="{ row }">
            {{ row.filed.label
            }}<TerminalCaveatMark
              v-if="row.filed.derived_from"
              :name="`How ${row.filed.label} is worked out`"
              :text="derivedText(row.filed)"
              class="ml-1 align-middle"
            />
            <span v-if="row.filed.unaudited" class="block text-xs text-muted">unaudited</span>
          </template>
          <template #cell-filed="{ row }">{{ precise(row.filed.val) }}</template>
          <template #cell-filing="{ row }">
            <a
              :href="row.filed.filing_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-primary"
            >
              <time :datetime="row.filed.first_filed">{{ row.filed.first_filed }}</time>
            </a>
            <span class="block text-xs text-muted">{{ row.filed.form }}</span>
          </template>
          <template #cell-first="{ row }">
            <a
              :href="row.reports[0]!.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="row.reports[0]!.title"
              class="underline underline-offset-2 hover:text-primary"
            >
              <time :datetime="row.reports[0]!.published_at">{{
                stamps.absolute(row.reports[0]!.published_at)
              }}</time>
            </a>
            <span class="block text-xs text-muted">{{ row.reports[0]!.outlet }}</span>
          </template>
          <template #cell-median="{ row }">
            {{ precise(row.median) }}
            <span v-if="rangeText(row)" class="block font-sans text-xs text-muted">{{
              rangeText(row)
            }}</span>
          </template>
          <template #cell-error="{ row }">{{ pct(row.error_pct) }}</template>
          <template #cell-lead="{ row }">{{ row.lead_days }}</template>
          <template #cell-reports="{ row }">{{ row.reports.length }}</template>
          <template #cell-held="{ row }">{{ row.held }}</template>
        </TerminalTable>
        <TerminalGap
          v-else
          title="Nothing to score yet."
          reason="No lab’s filing has printed a revenue figure that a headline we read reported first."
          :action="{ label: 'What the press reports', to: '/revenue?tab=press' }"
        />

        <TerminalExpand
          v-if="scored.length"
          :show="`Show the ${plural(scored.length, 'report')} behind these`"
          hide="Hide the reports"
        >
          <TerminalTable
            caption="Every scored press report, with the filed figure it was compared with"
            :columns="reportColumns"
            :rows="scored"
            :row-key="reportKey"
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
            <template #cell-against="{ row }">
              {{ row.filed_label }}
              <span class="block text-xs text-muted">{{
                row.matched_by === 'stated' ? 'named in the headline' : 'nearest filed figure'
              }}</span>
            </template>
            <template #cell-error="{ row }">{{ pct(row.error_pct!) }}</template>
            <template #cell-lead="{ row }">{{ row.lead_days }}</template>
          </TerminalTable>
        </TerminalExpand>
      </div>
    </TerminalPanel>

    <TerminalPanel
      v-if="truth.open.length"
      id="open"
      title="Reports no filed figure settles"
      :note="`Revenue reports for a lab that has filed, more than ${truth.tolerance_pct}% from every filed figure. A later filing can still settle one.`"
    >
      <TerminalTable
        caption="Revenue reports that match no filed figure, each with the nearest one and the gap"
        :columns="openColumns"
        :rows="truth.open"
        :row-key="reportKey"
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
          <span class="block text-xs text-muted">{{ row.outlet }}</span>
        </template>
        <template #cell-amount="{ row }">{{ row.amount_text }}</template>
        <template #cell-against="{ row }">
          <template v-if="row.filed_label && row.filed_val !== null">
            {{ row.filed_label }}, {{ precise(row.filed_val) }}
          </template>
          <span v-else class="text-muted">None filed for that period</span>
        </template>
        <template #cell-error="{ row }">
          <template v-if="row.error_pct !== null">{{ pct(row.error_pct) }}</template>
          <span v-else class="text-muted">—</span>
        </template>
      </TerminalTable>
    </TerminalPanel>

    <TerminalPanel
      v-if="!lab || truth.waiting.length"
      id="waiting"
      title="Waiting for a filing"
      note="Figures the press reports that no filing can check yet."
      :more="{ label: 'Every press report', to: '/revenue?tab=press' }"
    >
      <TerminalTable
        v-if="truth.waiting.length"
        caption="Reported figures with no filed figure to score them against, and why"
        :columns="waitingColumns"
        :rows="truth.waiting"
        :row-key="waitingKey"
        align="top"
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
              stamps.absolute(row.latest.published_at)
            }}</time>
          </a>
          <span class="block text-xs text-muted">{{ row.latest.outlet }}</span>
        </template>
        <template #cell-why="{ row }">{{ reasonText(row) }}</template>
      </TerminalTable>
      <p v-else class="text-sm text-default">No reported figure is waiting.</p>
    </TerminalPanel>

    <TerminalGroundTruthDeals
      v-if="!lab || truth.deals.reports.length"
      :deals="truth.deals"
      :tolerance-pct="truth.tolerance_pct"
    />

    <template v-if="!lab">
      <TerminalGroundTruthGuidance
        :guidance="truth.guidance"
        :tolerance-pct="truth.tolerance_pct"
      />

      <TerminalPanel
        id="alerts"
        title="Alerts against the press"
        :note="`Notable and critical alerts since ${truth.alerts.from}. We compare when we saw the change with the first article about it.`"
        :more="{ label: 'Every alert with its first report', to: '/alerts?tab=track-record' }"
      >
        <div class="max-w-2xl space-y-2 text-sm text-default">
          <p>{{ pressText(truth.alerts.press) }}</p>
          <p>{{ newsroomText(truth.alerts.newsroom) }}</p>
          <p class="text-muted">
            {{ plural(truth.alerts.rated, 'alert') }} in all.
            <template v-if="truth.alerts.window_open">
              {{ truth.alerts.window_open }}
              {{ truth.alerts.window_open === 1 ? 'is' : 'are' }} less than
              {{ truth.alerts.window_days }} days old and not searched yet.
            </template>
            A lead isn’t a trading signal.
          </p>
        </div>
      </TerminalPanel>

      <TerminalPanel id="method" title="How we score it">
        <div class="max-w-2xl space-y-3 text-sm text-default">
          <p>
            We read news headlines from
            <a
              href="https://www.gdeltproject.org/"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary underline underline-offset-2"
              >GDELT</a
            >
            (a public index of news sites). When a headline states a lab’s revenue, a model labels
            the amount. We keep it only when the amount and the lab’s name are in the headline as
            written. We never fetch the article.
          </p>
          <p>
            When the lab files with the SEC, we compare. A report counts only if GDELT read it
            before the filing day. One from the filing day or later repeats the filing, so we leave
            it out.
          </p>
          <p>
            Most headlines name no year. For those we take the nearest filed figure that wasn’t
            public yet, for a period that had already ended, and count it when it’s within
            {{ truth.tolerance_pct }}%. When a headline names the year or quarter, we use that
            period, and a gap over {{ truth.tolerance_pct }}% is a miss.
          </p>
          <p>
            Filings print year-to-date columns. A quarter is the nine-month figure minus the
            six-month one, public from the later of the two filings. Interim figures in a
            registration statement are unaudited.
          </p>
          <p>
            GDELT’s time is the quarter hour it read the article. It doesn’t read Bloomberg,
            Reuters, the Wall Street Journal or the Financial Times, so a figure they break shows up
            here when another outlet repeats it. “Stored before” counts the reports our store held
            before the filing day. The rest we read back from GDELT’s archive later.
          </p>
          <p>
            Only a lab that files for itself is scored on revenue. A parent’s consolidated revenue
            isn’t the lab’s.
          </p>
          <p>
            Deal sizes go through the same steps. The model labels the amount as a contract, an
            investment or a loan and names the other company. We keep the label only when the
            amount, the lab and that company are in the headline as written. The filed side is the
            other company’s own number, or the lab’s prospectus for its total commitments.
          </p>
          <p>
            A filed figure often measures something else. Amazon files what Anthropic added to its
            backlog in a quarter, and a contract’s stated value can be held to that. For OpenAI it
            files the backlog left at each quarter end, which falls as Amazon delivers, so we score
            no headline against it. The table under the reports lists every filed figure we use and
            how. A report about a company whose filings we don’t read, or a figure no filing states,
            is listed with the reason.
          </p>
          <p>
            A report of an amount added is held to the quarter it was published in. One published
            after a quarter ended and before its filing is held to that quarter only when it is
            within
            {{ truth.tolerance_pct }}% of it. A report of a total is held to the first balance dated
            on or after the report. Either is matched within {{ truth.tolerance_pct }}%. A report
            within {{ truth.tolerance_pct }}% of a figure already filed repeats it and isn’t scored.
            <template v-if="dealsSince">
              We started labeling deal sizes on {{ dealsSince }}. Before then we kept a headline
              only when it used a revenue, valuation or funding word, so older deal headlines are
              here only if they used one.
            </template>
          </p>
          <p>
            For capex guidance we read the earnings release each filer attaches to its 8-K (exhibit
            99.1), for releases filed since {{ truth.guidance.since }}. We take the sentence that
            names capital expenditures, says expect or anticipate, names a year and states an amount
            in billions of dollars. We compare it with the capex the annual report files for that
            year. A range is met when the filed figure is inside it, and a single figure within
            {{ truth.tolerance_pct }}%. Otherwise we show how far outside it came in.
          </p>
          <p>
            Guidance given only on the earnings call isn’t here, because we don’t read call
            transcripts. Each filer defines capex its own way, and the table under the guidance rows
            says which filed lines we compare with. This isn’t investment advice.
          </p>
          <p class="text-muted">
            Press data from the GDELT Project (gdeltproject.org). Every headline and filed figure is
            in the
            <NuxtLink to="/data" class="text-primary underline underline-offset-2"
              >bulk exports</NuxtLink
            >
            as reported_articles, reported_figures, revenue_facts and filed_facts. This page’s rows,
            the guidance figures included, are at /api/ground-truth, which also takes as_of.
          </p>
        </div>
      </TerminalPanel>
    </template>
  </div>
</template>
