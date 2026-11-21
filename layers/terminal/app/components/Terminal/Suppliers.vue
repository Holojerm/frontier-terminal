<script setup lang="ts">
// The suppliers table on /dependencies: listed chip, hardware and
// compute-rental companies, and what their own SEC filings say ties them to a
// lab or a cloud. Two tables. The first is one row per company. The second is
// one row per filed passage, so every figure keeps its quote and document.

import {
  SUPPLIER_LAYER_LABEL,
  SUPPLIER_RELATION_LABEL,
  supplierFigureText,
  type SupplierShare,
  type SuppliersData,
} from '../../../shared/utils/suppliers'
import type { TableColumn } from '../../types/terminal-ui'

const stamps = useStamps()

const props = defineProps<{ data: SuppliersData }>()

const figures = useFigures()

const share = (s: SupplierShare | null) => (s ? `${s.pct}%` : '')

const companyColumns: TableColumn[] = [
  { key: 'ticker', label: 'Ticker' },
  { key: 'company', label: 'Company' },
  { key: 'layer', label: 'Sells' },
  { key: 'named', label: 'Names in its filings', class: 'min-w-48' },
  { key: 'namedShare', label: 'Largest named customer', numeric: true, hint: 'share of revenue' },
  {
    key: 'unnamedShare',
    label: 'Largest unnamed share',
    numeric: true,
    hint: 'share of revenue',
  },
]
const companies = computed(() =>
  props.data.companies.map((c) => ({
    ticker: c.ticker,
    company: c.company,
    layer: SUPPLIER_LAYER_LABEL[c.layer],
    named: c.named.map((n) => n.name).join(', '),
    namedShare: share(c.top_named_share),
    namedWho: c.top_named_share?.counterparty ?? '',
    unnamedShare: share(c.top_unnamed_share),
    unnamedWho: c.top_unnamed_share?.counterparty ?? '',
  })),
)

const rowColumns: TableColumn[] = [
  { key: 'company', label: 'Company' },
  { key: 'says', label: 'What the filing says', class: 'w-1/2 min-w-80' },
  { key: 'figures', label: 'Figures', numeric: true },
  { key: 'filing', label: 'Filing' },
  { key: 'source', label: 'Source' },
]
const rows = computed(() =>
  props.data.rows.map((r, i) => ({
    key: `${r.ticker}|${i}`,
    ticker: r.ticker,
    company: r.company,
    relation: SUPPLIER_RELATION_LABEL[r.relation],
    counterparty: r.counterparty,
    unnamed: r.relation === 'concentration',
    quote: r.quote,
    alias: r.alias,
    figures: r.figures.map((f) => ({
      text: supplierFigureText(f, figures.usd),
      meaning: f.meaning,
    })),
    filing: `${r.form}, filed ${stamps.date(r.filed)}`,
    period: r.period,
    source_url: r.source_url,
    fetched_at: r.fetched_at,
  })),
)
</script>

<template>
  <TerminalPanel
    id="suppliers"
    title="Chip and compute suppliers"
    note="Listed companies whose own SEC filings tie them to a lab or a cloud. A share is the filing’s figure for one customer. Not investment advice."
  >
    <div class="space-y-4">
      <TerminalTable
        caption="Listed chip, hardware and compute-rental companies, the counterparties their filings name, and the largest share of revenue a filing puts on one customer"
        :columns="companyColumns"
        :rows="companies"
        :row-key="(c) => c.ticker"
        nested
      >
        <template #cell-ticker="{ row }">
          <span class="font-mono text-highlighted">{{ row.ticker }}</span>
        </template>
        <template #cell-namedShare="{ row }">
          <template v-if="row.namedShare">
            {{ row.namedShare }}
            <span class="block font-sans text-xs text-muted">{{ row.namedWho }}</span>
          </template>
        </template>
        <template #cell-unnamedShare="{ row }">
          <template v-if="row.unnamedShare">
            {{ row.unnamedShare }}
            <span class="block font-sans text-xs text-muted">{{ row.unnamedWho }}</span>
          </template>
        </template>
      </TerminalTable>

      <TerminalTable
        caption="Each filed passage that ties a supplier to a lab, a cloud or an unnamed large customer, with its figures and the document it is in"
        :columns="rowColumns"
        :rows="rows"
        :row-key="(r) => r.key"
        align="top"
        nested
      >
        <template #cell-company="{ row }">
          {{ row.company }}
          <span class="ml-1 font-mono text-highlighted">{{ row.ticker }}</span>
        </template>
        <template #cell-says="{ row }">
          <p class="text-default">
            <template v-if="row.unnamed">Unnamed customer, “{{ row.counterparty }}”</template>
            <template v-else>{{ row.relation }} {{ row.counterparty }}</template>
          </p>
          <p class="mt-1 text-muted">“{{ row.quote }}”</p>
          <p v-if="row.alias" class="mt-1 text-muted">
            The same document defines “{{ row.alias.term }}”: “{{ row.alias.quote }}”
          </p>
        </template>
        <template #cell-figures="{ row }">
          <span v-for="f in row.figures" :key="f.text + f.meaning" class="block">
            {{ f.text }}
            <span class="block font-sans text-xs text-muted">{{ f.meaning }}</span>
          </span>
        </template>
        <template #cell-filing="{ row }">
          {{ row.filing }}
          <span v-if="row.period" class="block text-xs text-muted">{{ row.period }}</span>
        </template>
        <template #cell-source="{ row }">
          <TerminalProvenanceTag :source-url="row.source_url" :fetched-at="row.fetched_at" />
        </template>
      </TerminalTable>

      <TerminalGap v-for="g in data.gaps" :key="g.id" inline :title="g.title" :reason="g.reason" />
      <p class="text-xs text-muted">{{ data.rule }}</p>
    </div>
  </TerminalPanel>
</template>
