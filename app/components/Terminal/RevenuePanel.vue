<script setup lang="ts">
// Disclosed revenue per lab, primary source only. Three states, each said
// in words: no audited disclosure (nothing shown, and the press run-rate
// that would fill the space is named as deliberately absent); a public
// parent's consolidated figure, labelled as the parent's; the lab's own
// filing. Every value links to the filing that reported it.

import { compactUsd, count, periodLabel } from '#shared/utils/terminal-format'
import type { RevenueData, RevenueProviderView } from '#shared/utils/terminal-types'

const props = defineProps<{
  revenue: RevenueData
  /** On the landing page: the newest period per lab and a link to the axis. */
  compact?: boolean
}>()

const MAX_PERIODS = 8

// On the front page the labs with nothing on file share one line; a card
// each would say the same sentence three times.
const undisclosed = computed(() =>
  props.compact ? props.revenue.providers.filter((p) => p.disclosure === 'none') : [],
)
const cards = computed(() =>
  props.compact
    ? props.revenue.providers.filter((p) => p.disclosure !== 'none')
    : props.revenue.providers,
)

const shown = (p: RevenueProviderView) =>
  props.compact ? p.periods.slice(0, 2) : p.periods.slice(0, MAX_PERIODS)
const overflow = (p: RevenueProviderView) =>
  props.compact ? 0 : Math.max(0, p.periods.length - MAX_PERIODS)

const filerName = (p: RevenueProviderView) =>
  `${p.filer?.entity_name ?? p.filer?.ticker ?? p.display} (${p.filer?.ticker ?? `CIK ${p.filer?.cik}`})`

const relationLine = (p: RevenueProviderView) =>
  p.filer?.relation === 'parent'
    ? `${filerName(p)} consolidated — the parent’s top line, not ${p.display}’s`
    : p.filer
      ? `${filerName(p)} — the lab’s own filing${p.filer.tagged_by === 'resolved' && p.filer.resolved_from ? `, CIK resolved from its ${p.filer.resolved_from.form} of ${p.filer.resolved_from.file_date}` : ''}`
      : ''
</script>

<template>
  <div class="space-y-4">
    <p v-if="compact && undisclosed.length" class="text-sm text-toned">
      No SEC-disclosed revenue: {{ undisclosed.map((p) => p.display).join(', ') }}. Press run-rates
      are not shown.
    </p>
    <div class="grid gap-4 md:grid-cols-2">
      <article
        v-for="p in cards"
        :key="p.provider"
        :aria-labelledby="`revenue-${p.provider}`"
        class="space-y-3 rounded border border-default bg-elevated p-4"
      >
        <header class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 :id="`revenue-${p.provider}`" class="text-lg text-highlighted">{{ p.display }}</h3>
          <UBadge
            v-if="p.disclosure === 'parent' || p.disclosure === 'issuer'"
            :color="p.disclosure === 'issuer' ? 'success' : 'warning'"
            variant="subtle"
            size="sm"
            :icon="p.disclosure === 'issuer' ? 'i-lucide-file-check' : 'i-lucide-git-branch'"
          >
            {{ p.disclosure === 'issuer' ? 'issuer filing' : 'parent filing' }}
          </UBadge>
          <UBadge v-else color="neutral" variant="subtle" size="sm" icon="i-lucide-eye-off">
            no audited disclosure
          </UBadge>
        </header>

        <!-- The honest gap: nothing shown, and the number that would have
             filled the space named as deliberately absent. -->
        <TerminalEmptyState
          v-if="p.disclosure === 'none'"
          title="No SEC filing carries this lab’s revenue."
          body="Press-reported run-rates are not shown."
        />

        <TerminalEmptyState
          v-else-if="p.disclosure === 'no_rows'"
          title="Filer tagged, nothing parsed yet."
          body="Its XBRL facts land on the first company-facts poll."
        />

        <template v-else>
          <p class="text-sm text-toned">
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

          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <caption class="sr-only">
                {{
                  p.display
                }}
                reported revenue by period, newest first
              </caption>
              <thead>
                <tr class="border-b border-default text-left">
                  <th scope="col" class="py-1 pr-2 font-medium text-toned">Period</th>
                  <th scope="col" class="py-1 pr-2 text-right font-medium text-toned">Revenue</th>
                  <th scope="col" class="py-1 font-medium text-toned">Filing</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in shown(p)" :key="r.entity_key" class="border-b border-default">
                  <th scope="row" class="py-1 pr-2 text-left font-normal text-default">
                    <time :datetime="r.start">{{ r.start }}</time> →
                    <time :datetime="r.end">{{ r.end }}</time>
                    <span class="text-toned"> · {{ periodLabel(r.days) }}</span>
                  </th>
                  <td
                    class="py-1 pr-2 text-right font-mono text-highlighted"
                    :title="`USD ${count(r.val)}`"
                  >
                    {{ compactUsd(r.val) }}
                  </td>
                  <td class="whitespace-nowrap py-1 text-toned">
                    <a
                      :href="r.filing_url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="underline underline-offset-2 hover:text-default"
                      :title="`Accession ${r.accession_no} · tag ${r.tag}`"
                      >{{ r.form }}</a
                    >
                    <span> filed </span>
                    <time :datetime="r.filed">{{ r.filed }}</time>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="overflow(p)" class="text-xs text-toned">+ {{ overflow(p) }} more periods</p>
          <p v-if="!compact && p.superseded.length" class="text-xs text-toned">
            {{ p.superseded.length }} earlier value{{ p.superseded.length === 1 ? '' : 's' }} for
            these periods restated by a later filing — see the revenue_facts export.
          </p>
          <p v-if="!compact && p.tags.length" class="text-xs text-toned">
            XBRL tag{{ p.tags.length === 1 ? '' : 's' }}:
            <code class="text-default">{{ p.tags.join(', ') }}</code>
          </p>
        </template>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TerminalProvenanceTag
            v-for="s in p.sources"
            :key="s.source_id"
            :label="s.label"
            :source-url="s.source_url"
            :fetched-at="s.fetched_at"
          />
          <TerminalCaveatMark
            v-if="p.filer?.caveat"
            :name="`Caveat for ${p.display} revenue`"
            :text="p.filer.caveat"
          />
        </div>
      </article>
    </div>

    <p v-if="!compact" class="text-xs text-muted">{{ revenue.rule }}</p>
    <p v-if="compact" class="text-sm">
      <NuxtLink to="/revenue" class="text-primary underline underline-offset-2">
        Every period, restatements and filings
      </NuxtLink>
    </p>
  </div>
</template>
