<script setup lang="ts">
// Who supplies power to the sites Epoch AI credits to a lab. Two tables: the
// listed companies with the sites behind each, then every company we read,
// one row per page so each row keeps its own source and quote. A site's power
// is Epoch's and sits on the site's rows only: summed per company it would
// read as what the company supplies, which no page says.

import { count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import { POWER_ROLE_LABEL, type PowerSitesData } from '../../../shared/utils/power-sites'
import type { TableColumn } from '../../types/terminal-ui'

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
const links = computed(() =>
  props.data.sites.flatMap((s) => {
    const site = {
      site: s.name,
      labs: labs(s.labs),
      now: mw(s.mw_now),
      planned: s.mw_planned === null ? '—' : `${mw(s.mw_planned)} by ${s.planned_date}`,
    }
    return [
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
              source_url: s.grid.source_url,
              fetched_at: s.grid.fetched_at,
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
        source_url: l.source_url,
        fetched_at: l.fetched_at,
      })),
    ]
  }),
)

const uncovered = computed(() => props.data.uncovered.map((u) => u.name).join(', '))
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
        <p class="text-default">
          {{ row.company }}
          <span v-if="row.ticker" class="ml-1 font-mono text-highlighted">{{ row.ticker }}</span>
          <span v-if="row.note" class="ml-1 text-muted">({{ row.note }})</span>
        </p>
        <p class="mt-1 text-muted">“{{ row.quote }}”</p>
      </template>
      <template #cell-stated="{ row }">
        <span :title="row.stated_meaning ?? undefined">{{ row.stated }}</span>
        <span v-if="row.stated_meaning" class="sr-only">{{ row.stated_meaning }}</span>
      </template>
      <template #cell-source="{ row }">
        <TerminalProvenanceTag :source-url="row.source_url" :fetched-at="row.fetched_at" />
      </template>
    </TerminalTable>
    <TerminalGap
      v-if="data.uncovered.length"
      inline
      :title="`${count(data.uncovered.length)} more lab sites with no power company read yet`"
      :reason="uncovered"
    />
    <TerminalSources
      :sources="data.source ? [data.source] : []"
      :caveats="[{ text: data.caveat, label: 'how to read this' }]"
    >
      <span>Sites and power: CC BY 4.0, Epoch AI</span>
    </TerminalSources>
  </div>
</template>
