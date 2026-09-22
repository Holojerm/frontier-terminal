<script setup lang="ts">
// Disclosed revenue as one row per lab: the newest reported period, its
// value, the filing it came from. The front page's reading; every period,
// restatements and the parent/issuer distinction in full are on /revenue.

import { compactUsd, count, periodLabel } from '#shared/utils/terminal-format'
import type { RevenueData } from '#shared/utils/terminal-types'

defineProps<{ revenue: RevenueData }>()
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Newest SEC-reported revenue per lab, with the filing it came from
      </caption>
      <thead>
        <tr class="border-b border-default text-left text-xs text-toned">
          <th scope="col" class="py-2 pr-3 font-medium">Lab</th>
          <th scope="col" class="py-2 pr-3 font-medium">Newest period</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Revenue</th>
          <th scope="col" class="py-2 pr-3 font-medium">Filing</th>
          <th scope="col" class="py-2 font-medium">Source</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in revenue.providers"
          :key="p.provider"
          class="border-b border-default align-baseline"
        >
          <th
            scope="row"
            class="whitespace-nowrap py-2 pr-3 text-left font-normal text-highlighted"
          >
            {{ p.display }}
            <TerminalCaveatMark
              v-if="p.disclosure === 'parent' && p.filer"
              label="parent"
              :text="`${p.filer.entity_name ?? p.filer.ticker ?? ''} (${p.filer.ticker ?? `CIK ${p.filer.cik}`}) consolidated — the parent’s top line, not ${p.display}’s.`"
              class="ml-1"
            />
          </th>
          <template v-if="p.periods[0]">
            <td class="whitespace-nowrap py-2 pr-3 text-xs text-default">
              <time :datetime="p.periods[0].start">{{ p.periods[0].start }}</time> →
              <time :datetime="p.periods[0].end">{{ p.periods[0].end }}</time>
              <span class="text-toned"> · {{ periodLabel(p.periods[0].days) }}</span>
            </td>
            <td
              class="py-2 pr-3 text-right font-mono text-highlighted"
              :title="`USD ${count(p.periods[0].val)}`"
            >
              {{ compactUsd(p.periods[0].val) }}
            </td>
            <td class="whitespace-nowrap py-2 pr-3 text-xs text-toned">
              <a
                :href="p.periods[0].filing_url"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-default"
                :title="`Accession ${p.periods[0].accession_no} · tag ${p.periods[0].tag}`"
                >{{ p.periods[0].form }}</a
              >
              filed <time :datetime="p.periods[0].filed">{{ p.periods[0].filed }}</time>
            </td>
          </template>
          <td v-else-if="p.disclosure === 'none'" colspan="3" class="py-2 pr-3 text-xs text-toned">
            No SEC filing carries this lab’s revenue
          </td>
          <td v-else colspan="3" class="py-2 pr-3 text-xs text-toned">
            Filer tagged, nothing parsed yet
          </td>
          <td class="py-2">
            <TerminalProvenanceTag
              v-if="p.sources[0]"
              :source-url="p.sources[0].source_url"
              :fetched-at="p.sources[0].fetched_at"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
