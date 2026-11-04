<script setup lang="ts">
// What a lab's own registration filings print beyond revenue, as printed:
// the statement of operations line by line, the commitment schedules, the
// 10%-customer tables, the share counts in "The Offering", and the risk-factor
// headings with what each amendment changed. A line the statement does not
// print and a count the filing leaves blank are stated as gaps, never filled.

import { periodName } from '../../../shared/utils/terminal-filings'
import {
  billions,
  millions,
  statementValue,
  type CommitmentView,
  type ConcentrationView,
  type ProspectusFilingRef,
  type ProspectusIssuerView,
  type StatementLineView,
} from '../../../shared/utils/terminal-prospectus'
import type { Fact, TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ issuer: ProspectusIssuerView }>()

const id = computed(() => `prospectus-${props.issuer.provider}`)
const filingLabel = (f: Pick<ProspectusFilingRef, 'form' | 'filed'>) => `${f.form} of ${f.filed}`

// ── statement of operations ────────────────────────────────────────────────

const statement = computed(() => props.issuer.statement)

const statementColumns = computed<TableColumn[]>(() => [
  { key: 'label', label: 'Line', class: 'min-w-48 text-default' },
  ...statement.value.periods.map((p, i) => ({
    key: `p${i}`,
    label: periodName(p),
    hint: [p.form, p.unaudited ? 'unaudited' : null].filter(Boolean).join(' · '),
    numeric: true,
    class: 'text-default',
  })),
])

const statementRows = computed(() =>
  statement.value.lines.map((l: StatementLineView) => ({
    key: l.key,
    label: l.label,
    unit: l.unit,
    ...Object.fromEntries(l.values.map((v, i) => [`p${i}`, statementValue(v, l.unit)])),
  })),
)

const superseded = computed(() => {
  const s = statement.value.superseded
  if (!s.length) return null
  const filings = [...new Set(s.map((p) => filingLabel(p)))]
  return `${s.length} period${s.length === 1 ? '' : 's'} also reported in the ${filings.join(' and the ')}. Each column above comes from the newest filing that reports it. The prospectus_statements export has both.`
})

// ── commitments ────────────────────────────────────────────────────────────

const SCHEDULE_TITLE: Record<CommitmentView['schedule'], string> = {
  contractual_obligations: 'Contractual obligations, by year due',
  purchase_commitments: 'Non-cancelable purchase commitments, by year',
  purchase_commitments_interim: 'Fixed or minimum guaranteed purchase commitments',
  obligations_aggregate: 'Aggregate obligations, including short-term and subsequent commitments',
}

const bucketed = computed(() => props.issuer.commitments.filter((c) => c.lines[0]!.buckets.length))
const single = computed(() => props.issuer.commitments.filter((c) => !c.lines[0]!.buckets.length))

const scheduleColumns = (c: CommitmentView): TableColumn[] => [
  { key: 'label', label: 'Obligation', class: 'text-default' },
  { key: 'total', label: 'Total', numeric: true, class: 'text-highlighted' },
  ...c.lines[0]!.buckets.map((b, i) => ({
    key: `b${i}`,
    label: b.label,
    numeric: true,
    class: 'text-default',
  })),
]

const scheduleRows = (c: CommitmentView) =>
  c.lines.map((l) => ({
    label: l.label,
    total: millions(l.total),
    ...Object.fromEntries(l.buckets.map((b, i) => [`b${i}`, millions(b.val)])),
  }))

const scheduleNote = (c: CommitmentView) =>
  [
    c.as_of ? `As of ${c.as_of}` : 'As stated',
    `${c.form} of ${c.filed}`,
    c.schedule === 'contractual_obligations' ? 'MD&A' : 'commitments note',
    c.audited ? 'audited' : 'unaudited',
  ].join(' · ')

const singleFacts = computed<Fact[]>(() =>
  single.value.map((c) => ({
    key: `${c.schedule}-${c.as_of ?? c.accession_no}`,
    label: `${SCHEDULE_TITLE[c.schedule]}${c.as_of ? `, as of ${c.as_of}` : ''} (${filingLabel(c)})`,
    value: `${c.approximate ? 'approx. ' : ''}${billions(c.lines[0]!.total)}`,
    mono: true,
    wide: true,
  })),
)

// ── concentration ──────────────────────────────────────────────────────────

const concentrationColumns = (c: ConcentrationView): TableColumn[] => [
  { key: 'label', label: 'Customer', class: 'text-default' },
  ...c.columns.map((col, i) => ({
    key: `c${i}`,
    label: col.start
      ? periodName({ end: col.end, days: daysBetween(col.start, col.end) })
      : `at ${col.end}`,
    hint: col.unaudited ? 'unaudited' : undefined,
    numeric: true,
    class: 'text-default',
  })),
]

const concentrationRows = (c: ConcentrationView) =>
  c.customers.map((cust) => ({
    label: cust.label,
    ...Object.fromEntries(cust.pct.map((p, i) => [`c${i}`, p === null ? '<10%' : `${p}%`])),
  }))

function daysBetween(start: string, end: string): number {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  )
}

// ── shares ─────────────────────────────────────────────────────────────────

const shares = computed(() => props.issuer.shares)
const shareFacts = computed<Fact[]>(() => {
  const s = shares.value
  if (!s) return []
  return [
    ...s.lines
      .filter((l) => l.shares !== null)
      .map((l, i) => ({
        key: `after-${i}`,
        label: l.label,
        value: `${l.shares!.toLocaleString('en-US')}${l.with_option === null ? '' : ` (${l.with_option.toLocaleString('en-US')} with the option)`}`,
        mono: true,
      })),
    ...s.before
      .filter((l) => l.shares !== null)
      .map((l, i) => ({
        key: `before-${i}`,
        label: `${l.label} outstanding as of ${s.before_as_of}`,
        value: l.shares!.toLocaleString('en-US'),
        mono: true,
      })),
  ]
})
const blankShares = computed(() => {
  const s = shares.value
  if (!s) return 0
  return [...s.lines, ...s.before].filter((l) => l.shares === null).length
})

// ── risk factors ───────────────────────────────────────────────────────────

const risk = computed(() => props.issuer.risk_factors)
const diffCounts = (changes: { kind: string }[]) => {
  const n = (k: string) => changes.filter((c) => c.kind === k).length
  return `${n('added')} added, ${n('removed')} removed, ${n('reworded')} reworded`
}
</script>

<template>
  <TerminalPanel
    :id="id"
    :title="`${issuer.display}’s registration statement`"
    :note="`What ${issuer.entity_name}’s S-1 and its amendments print beyond revenue. Each figure comes from the newest filing that states it.`"
  >
    <template #meta>
      <span class="font-mono">CIK {{ issuer.cik }}</span>
    </template>

    <section :aria-labelledby="`${id}-statement`" class="space-y-2">
      <h3 :id="`${id}-statement`" class="text-sm text-highlighted">Statement of operations</h3>
      <p class="text-xs text-muted">
        $ millions, shares in thousands, and per-share figures in $. Dashes are the statement’s own.
      </p>
      <TerminalTable
        :caption="`${issuer.display} consolidated statement of operations by period, newest first`"
        :columns="statementColumns"
        :rows="statementRows"
        :row-key="(r) => r.key"
        nested
      />
      <TerminalGap
        v-if="statement.not_printed.length"
        inline
        :title="`Not printed: ${statement.not_printed.join(', ').toLowerCase()}.`"
        reason="The statement groups operating expenses under its own lines, so no gross margin is shown."
      />
      <p v-if="superseded" class="text-xs text-muted">{{ superseded }}</p>
    </section>

    <section :aria-labelledby="`${id}-commitments`" class="space-y-2">
      <h3 :id="`${id}-commitments`" class="text-sm text-highlighted">Commitments</h3>
      <TerminalGap
        v-if="!issuer.commitments.length"
        inline
        title="No commitment schedule printed."
        reason="The filings we read print no contractual-obligations table or commitments note with figures."
      />
      <div v-for="c in bucketed" :key="`${c.schedule}-${c.as_of}`" class="space-y-1">
        <p class="text-xs text-default">
          {{ SCHEDULE_TITLE[c.schedule] }}
          <span class="text-muted">· {{ scheduleNote(c) }} · $ millions</span>
        </p>
        <TerminalTable
          :caption="`${SCHEDULE_TITLE[c.schedule]}, ${scheduleNote(c)}`"
          :columns="scheduleColumns(c)"
          :rows="scheduleRows(c)"
          :row-key="(r) => r.label"
          nested
        />
      </div>
      <TerminalFacts v-if="singleFacts.length" :items="singleFacts" layout="list" />
      <ul v-if="single.length" class="space-y-1 text-xs text-muted">
        <li v-for="c in single" :key="`q-${c.schedule}-${c.as_of ?? c.accession_no}`">
          <q>{{ c.statement }}</q>
          <span>
            ·
            <a
              :href="c.filing_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-default"
              >{{ filingLabel(c) }}</a
            ></span
          >
        </li>
      </ul>
    </section>

    <section :aria-labelledby="`${id}-concentration`" class="space-y-2">
      <h3 :id="`${id}-concentration`" class="text-sm text-highlighted">Customer concentration</h3>
      <TerminalGap
        v-if="!issuer.concentration.length"
        inline
        title="No 10%-customer table printed."
        reason="The filings we read disclose no customer concentration."
      />
      <div v-for="c in issuer.concentration" :key="c.basis" class="space-y-1">
        <p class="text-xs text-default">
          {{ c.basis === 'revenue' ? 'Share of revenue' : 'Share of accounts receivable' }}
          <span class="text-muted"
            >· customers at 10% or more, named as the {{ filingLabel(c) }} names them. “&lt;10%”
            stands for its “*”</span
          >
        </p>
        <TerminalTable
          :caption="`${issuer.display} customers at 10% or more of ${c.basis === 'revenue' ? 'revenue' : 'accounts receivable'}`"
          :columns="concentrationColumns(c)"
          :rows="concentrationRows(c)"
          :row-key="(r) => r.label"
          nested
        />
      </div>
    </section>

    <section :aria-labelledby="`${id}-shares`" class="space-y-2">
      <h3 :id="`${id}-shares`" class="text-sm text-highlighted">Shares outstanding</h3>
      <TerminalGap
        v-if="!shares"
        inline
        title="No “The Offering” summary read."
        reason="Share counts appear in the prospectus summary of a registration filing."
      />
      <template v-else>
        <TerminalGap
          v-if="blankShares"
          inline
          :title="`${blankShares} of ${shares.lines.length + shares.before.length} share counts blank in the ${filingLabel(shares)}.`"
          reason="A preliminary prospectus prints them once the price range is set."
        />
        <TerminalFacts v-if="shareFacts.length" :items="shareFacts" layout="list" />
      </template>
    </section>

    <section :aria-labelledby="`${id}-risk`" class="space-y-2">
      <h3 :id="`${id}-risk`" class="text-sm text-highlighted">Risk factors</h3>
      <p class="text-sm text-default">
        {{ risk.latest.count }} headings in {{ risk.latest.sections.length }} subsections in the
        {{ filingLabel(risk.latest) }}.
      </p>
      <div v-for="d in risk.diffs" :key="d.to.accession_no" class="space-y-1">
        <p class="text-sm text-default">
          Against the {{ filingLabel(d.from) }}: {{ diffCounts(d.changes) }}.
        </p>
        <ul class="space-y-1 text-xs">
          <li
            v-for="c in d.changes.filter((x) => x.kind !== 'reworded')"
            :key="`${c.kind}-${c.heading}`"
          >
            <UBadge
              :color="c.kind === 'added' ? 'info' : 'warning'"
              :icon="c.kind === 'added' ? 'i-lucide-plus' : 'i-lucide-minus'"
              variant="subtle"
              size="sm"
              >{{ c.kind }}</UBadge
            >
            <span class="text-default"> {{ c.heading }}</span>
            <span class="text-muted"> · {{ c.section }}</span>
          </li>
        </ul>
        <TerminalExpand
          v-if="d.changes.some((x) => x.kind === 'reworded')"
          :show="`Show the ${d.changes.filter((x) => x.kind === 'reworded').length} reworded headings`"
          hide="Hide the reworded headings"
        >
          <dl class="space-y-2 text-xs">
            <div
              v-for="c in d.changes.filter((x) => x.kind === 'reworded')"
              :key="c.heading"
              class="space-y-1"
            >
              <dt class="text-muted">Was: {{ c.previous }}</dt>
              <dd class="text-default">Now: {{ c.heading }}</dd>
            </div>
          </dl>
        </TerminalExpand>
      </div>
      <TerminalExpand :show="`Show all ${risk.latest.count} headings`" hide="Hide the headings">
        <div class="space-y-3">
          <div v-for="s in risk.latest.sections" :key="s.title" class="space-y-1">
            <h4 class="text-xs text-highlighted">{{ s.title }}</h4>
            <ol class="list-decimal space-y-1 pl-6 text-xs text-default">
              <li v-for="h in s.headings" :key="h">{{ h }}</li>
            </ol>
          </div>
        </div>
      </TerminalExpand>
    </section>

    <template #foot>
      <TerminalSources :sources="issuer.sources" />
    </template>
  </TerminalPanel>
</template>
