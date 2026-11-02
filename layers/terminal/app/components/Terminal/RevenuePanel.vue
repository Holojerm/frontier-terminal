<script setup lang="ts">
// Disclosed revenue per lab, primary source only. Three states, each said
// in words: no audited disclosure (nothing shown, and the press run-rate
// that would fill the space is named as deliberately absent); a public
// parent's figure — consolidated, or one segment it reports — labelled as
// the parent's; the lab's own filing — XBRL, or the statement of operations
// printed in an S-1 that tags none. Every value links to the filing that
// reported it, and to its page here.

import { filingPath } from '../../../shared/utils/terminal-filings'
import { compactUsd, count, periodLabel } from '../../../shared/utils/terminal-format'
import type { RevenueData, RevenueProviderView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

defineProps<{ revenue: RevenueData }>()

const MAX_PERIODS = 8

const shown = (p: RevenueProviderView) => p.periods.slice(0, MAX_PERIODS)
const overflow = (p: RevenueProviderView) => Math.max(0, p.periods.length - MAX_PERIODS)

const filerName = (p: RevenueProviderView) =>
  `${p.filer?.entity_name ?? p.filer?.ticker ?? p.display} (${p.filer?.ticker ?? `CIK ${p.filer?.cik}`})`

const fromProspectus = (p: RevenueProviderView) => p.periods.some((r) => r.basis === 'prospectus')

const relationLine = (p: RevenueProviderView) =>
  p.filer?.relation === 'parent' && p.filer.segment_label
    ? `${filerName(p)}, ${p.filer.segment_label} segment: a parent segment, not ${p.display}’s revenue`
    : p.filer?.relation === 'parent'
      ? `${filerName(p)} consolidated: the parent’s revenue, not ${p.display}’s`
      : p.filer
        ? `${filerName(p)}: the lab’s own filing${p.filer.tagged_by === 'resolved' && p.filer.resolved_from ? `, CIK resolved from its ${p.filer.resolved_from.form} of ${p.filer.resolved_from.file_date}` : ''}`
        : ''

const PERIOD_COLUMNS: TableColumn[] = [
  { key: 'period', label: 'Period', class: 'text-default' },
  { key: 'val', label: 'Revenue', numeric: true, class: 'text-highlighted' },
  { key: 'filing', label: 'Filing', class: 'whitespace-nowrap text-muted' },
]

const BADGE = {
  issuer: { color: 'success', icon: 'i-lucide-file-check', label: 'issuer filing' },
  parent: { color: 'warning', icon: 'i-lucide-git-branch', label: 'parent filing' },
  segment: { color: 'warning', icon: 'i-lucide-git-branch', label: 'parent segment' },
  none: { color: 'neutral', icon: 'i-lucide-eye-off', label: 'no audited disclosure' },
} as const

const badge = (p: RevenueProviderView) =>
  p.disclosure === 'issuer'
    ? BADGE.issuer
    : p.disclosure === 'parent'
      ? p.filer?.segment_label
        ? BADGE.segment
        : BADGE.parent
      : BADGE.none
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <TerminalCard
        v-for="p in revenue.providers"
        :id="`revenue-${p.provider}`"
        :key="p.provider"
        :title="p.display"
        :sources="p.sources"
      >
        <template #meta>
          <UBadge :color="badge(p).color" :icon="badge(p).icon" variant="subtle" size="sm">
            {{ badge(p).label }}
          </UBadge>
        </template>

        <!-- The honest gap: nothing shown, and the number that would have
             filled the space named as deliberately absent. -->
        <TerminalGap
          v-if="p.disclosure === 'none'"
          title="No SEC filing reports this lab’s revenue."
          reason="Press-reported run-rates are excluded."
        />

        <TerminalGap
          v-else-if="p.disclosure === 'no_rows'"
          :title="
            p.filer?.relation === 'issuer'
              ? 'S-1 filed; no revenue read yet.'
              : 'Filer tagged; no XBRL facts parsed yet.'
          "
          :reason="
            p.filer?.relation === 'issuer'
              ? 'Read from the S-1’s statement of operations on the next survey poll. XBRL follows with the first 10-Q.'
              : 'They appear on the next EDGAR poll.'
          "
        />

        <template v-else>
          <p class="text-sm text-muted">
            {{ relationLine(p) }}
            <a
              v-if="p.filer?.resolved_from"
              :href="p.filer.resolved_from.filing_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-default"
              >{{ p.filer.resolved_from.accession_no }}</a
            >
          </p>

          <TerminalTable
            :caption="`${p.display} reported revenue by period, newest first`"
            :columns="PERIOD_COLUMNS"
            :rows="shown(p)"
            :row-key="(r) => r.entity_key"
            nested
          >
            <template #cell-period="{ row: r }">
              <time :datetime="r.start">{{ r.start }}</time> →
              <time :datetime="r.end">{{ r.end }}</time>
              <span class="text-muted"> · {{ periodLabel(r.days) }}</span>
              <span v-if="r.unaudited" class="text-muted"> · unaudited</span>
            </template>
            <template #cell-val="{ row: r }">
              <span :title="`USD ${count(r.val)}`">{{ compactUsd(r.val) }}</span>
            </template>
            <template #cell-filing="{ row: r }">
              <NuxtLink
                :to="filingPath(r.accession_no)"
                class="underline underline-offset-2 hover:text-default"
                :title="`Every period accession ${r.accession_no} reported`"
                >{{ r.form }}</NuxtLink
              >
              filed <time :datetime="r.filed">{{ r.filed }}</time>
              ·
              <a
                :href="r.filing_url"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-default"
                :title="`Accession ${r.accession_no} · ${r.basis === 'xbrl' ? 'tag' : 'row'} ${r.tag}`"
                >EDGAR</a
              >
            </template>
          </TerminalTable>

          <div class="space-y-1 text-xs text-muted">
            <p v-if="overflow(p)">+ {{ overflow(p) }} more periods</p>
            <p v-if="p.superseded.length">
              {{ p.superseded.length }} earlier value{{ p.superseded.length === 1 ? '' : 's' }} for
              these periods restated by a later filing — see the revenue_facts export.
            </p>
            <p v-if="fromProspectus(p)">
              Read from the S-1’s Consolidated Statements of Operations: the filing tags no
              financials in XBRL. A later filing’s value for the same period replaces it.
            </p>
            <p v-if="p.tags.length">
              XBRL tag{{ p.tags.length === 1 ? '' : 's' }}:
              <code class="text-default">{{ p.tags.join(', ') }}</code>
            </p>
          </div>
        </template>

        <template v-if="p.filer?.caveat" #foot>
          <TerminalCaveatMark :name="`Caveat for ${p.display} revenue`" :text="p.filer.caveat" />
        </template>
      </TerminalCard>
    </div>

    <p class="text-xs text-muted">{{ revenue.rule }}</p>
  </div>
</template>
