<script setup lang="ts">
// Who supplies power to Epoch's lab sites: listed companies with their sites, then
// one row per page read; a site with no company read gets a gap row. A site's
// power sits on its own rows only: summed per company it would read as what the
// company supplies, which no page says.

import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'
import { type PowerSitesData } from '../../../shared/utils/power-sites'

const stamps = useStamps()

const props = defineProps<{ data: PowerSitesData }>()

const mw = (v: number) => `${count(Math.round(v))} MW`
const labs = (ids: readonly string[]) =>
  ids.map((l) => (LAB_DISPLAY as Record<string, string>)[l] ?? l).join(', ')

const tickerColumns: TableColumn[] = [
  { key: 'ticker', label: 'Ticker' },
  { key: 'company', label: 'Company' },
  { key: 'roles', label: 'Role' },
  { key: 'labs', label: 'Labs' },
  { key: 'n', label: 'Sites', numeric: true },
  { key: 'sites', label: 'Where' },
]
const tickers = computed(() =>
  props.data.tickers.map((t) => ({
    ticker: t.ticker,
    company: t.company,
    roles: t.roles.map((r) => POWER_ROLE_LABEL[r]).join(', '),
    labs: labs(t.labs),
    n: count(t.sites.length),
    sites: t.sites.join(', '),
  })),
)

const linkColumns: TableColumn[] = [
  { key: 'site', label: 'Site' },
  { key: 'labs', label: 'Labs' },
  { key: 'now', label: 'Now', numeric: true },
  { key: 'planned', label: 'Planned', numeric: true },
  { key: 'role', label: 'Role' },
  { key: 'company', label: 'Company', class: 'min-w-64' },
  { key: 'stated', label: 'Stated', numeric: true, hint: 'by the page' },
  { key: 'source', label: 'Source' },
]
const siteCells = (s: {
  name: string
  labs: readonly string[]
  mw_now: number
  mw_planned: number | null
  planned_date: string | null
}) => ({
  site: s.name,
  labs: labs(s.labs),
  now: mw(s.mw_now),
  planned:
    s.mw_planned === null
      ? '—'
      : `${mw(s.mw_planned)}${s.planned_date ? ` by ${stamps.date(s.planned_date)}` : ''}`,
})

const gapOf = computed(() => new Map(props.data.gaps.map((g) => [g.site, g])))

const links = computed(() => {
  const read = props.data.sites.map((s) => {
    const site = siteCells(s)
    const rows = [
      ...(s.grid
        ? [
            {
              ...site,
              key: `${s.name}|grid`,
              role: 'Grid',
              company: s.grid.name,
              ticker: null as string | null,
              note: '',
              stated: '',
              stated_meaning: null as string | null,
              quote: s.grid.quote,
              source_url: s.grid.source_url as string | null,
              fetched_at: s.grid.fetched_at as string | null,
              gap: null as { title: string; reason: string } | null,
            },
          ]
        : []),
      ...s.links.map((l, i) => ({
        ...site,
        key: `${s.name}|${i}`,
        role: POWER_ROLE_LABEL[l.role],
        company: l.parent ? `${l.company} (${l.parent})` : l.company,
        ticker: l.ticker,
        note: l.unlisted ?? '',
        stated: l.mw === null ? '' : mw(l.mw),
        stated_meaning: l.mw_meaning,
        quote: l.quote,
        source_url: l.source_url as string | null,
        fetched_at: l.fetched_at as string | null,
        gap: null as { title: string; reason: string } | null,
      })),
    ]
    return { mw_now: s.mw_now, rows }
  })
  const unread = props.data.uncovered.map((u) => {
    const gap = gapOf.value.get(u.name)
    return {
      mw_now: u.mw_now,
      rows: [
        {
          ...siteCells(u),
          key: `${u.name}|gap`,
          role: '',
          company: '',
          ticker: null as string | null,
          note: '',
          stated: '',
          stated_meaning: null as string | null,
          quote: '',
          source_url: null as string | null,
          fetched_at: null as string | null,
          gap: {
            title: 'No power company read yet',
            reason: gap?.reason ?? 'No page we have read names its utility, generator or host yet.',
          },
        },
      ],
    }
  })
  return [...read, ...unread].sort((a, b) => b.mw_now - a.mw_now).flatMap((s) => s.rows)
})

/** What the table never reads, beside the per-site gaps already on their rows. */
const standing = computed(() => props.data.gaps.filter((g) => g.site === null))
</script>

<template>
  <div class="space-y-4">
    <TerminalTable
      caption="Listed companies tied to the power of data-center sites used by a frontier lab"
      :columns="tickerColumns"
      :rows="tickers"
      :row-key="(t) => t.ticker"
      nested
    />
    <TerminalTable
      caption="Each utility, generator, equipment maker and site host read for a lab’s data-center site, with the page and the quote it rests on"
      :columns="linkColumns"
      :rows="links"
      :row-key="(l) => l.key"
      align="top"
      nested
    >
      <template #cell-company="{ row }">
        <TerminalGap
          v-if="row.gap"
          inline
          :title="row.gap.title"
          :reason="row.gap.reason"
          :name="`Why: no power company read for ${row.site}`"
        />
        <template v-else>
          <p class="text-default">
            {{ row.company }}
            <span v-if="row.ticker" class="ml-1 font-mono text-highlighted">{{ row.ticker }}</span>
            <span v-if="row.note" class="ml-1 text-muted">({{ row.note }})</span>
          </p>
          <p class="mt-1 text-muted">“{{ row.quote }}”</p>
        </template>
      </template>
      <template #cell-stated="{ row }">
        <span :title="row.stated_meaning ?? undefined">{{ row.stated }}</span>
        <span v-if="row.stated_meaning" class="sr-only">{{ row.stated_meaning }}</span>
      </template>
      <template #cell-source="{ row }">
        <TerminalProvenanceTag
          v-if="row.source_url && row.fetched_at"
          :source-url="row.source_url"
          :fetched-at="row.fetched_at"
        />
      </template>
    </TerminalTable>
    <TerminalGap v-for="g in standing" :key="g.id" inline :title="g.title" :reason="g.reason" />
    <TerminalSources
      :sources="data.source ? [data.source] : []"
      :caveats="[{ text: data.caveat, label: 'how to read this' }]"
    >
      <span>Sites and power: CC BY 4.0, Epoch AI</span>
    </TerminalSources>
  </div>
</template>
