<script setup lang="ts">
// Misalignment disclosure as one row per lab: reports and notices on the
// lab's own index, and the median days from discovery to publication. A lab
// with no index is a row that says so and gives the audit's reason: the
// count measures disclosure, so a blank here is the finding, not a zero.

import type { DisclosuresData } from '#shared/utils/terminal-types'

// Omit the entry list: this table renders the per-lab counts only, and a
// page can drop the array before it is serialised into the hydration payload.
defineProps<{ disclosures: Omit<DisclosuresData, 'entries'> }>()

const days = (n: number) => (Number.isInteger(n) ? `${n}d` : `${n.toFixed(1)}d`)
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Misalignment disclosures per lab: reports and notices on the lab’s own index, and the median
        days from discovery to publication
      </caption>
      <thead>
        <tr class="border-b border-default text-left text-xs text-toned">
          <th scope="col" class="py-2 pr-3 font-medium">Lab</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Reports</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Notices</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Median to disclosure</th>
          <th scope="col" class="py-2 font-medium">Source</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in disclosures.providers"
          :key="p.provider"
          class="border-b border-default align-baseline"
        >
          <th
            scope="row"
            class="whitespace-nowrap py-2 pr-3 text-left font-normal text-highlighted"
          >
            {{ p.display }}
          </th>
          <template v-if="p.feed === 'ok'">
            <td class="py-2 pr-3 text-right font-mono text-highlighted">{{ p.reports }}</td>
            <td class="py-2 pr-3 text-right font-mono text-default">{{ p.notices }}</td>
            <td class="whitespace-nowrap py-2 pr-3 text-right font-mono text-default">
              <template v-if="p.median_days_to_disclosure !== null">
                {{ days(p.median_days_to_disclosure) }}
                <span class="text-xs text-toned">over {{ p.timed_reports }}</span>
              </template>
              <span v-else class="text-toned">—</span>
            </td>
          </template>
          <td
            v-else-if="p.feed === 'no_public_feed'"
            colspan="3"
            class="py-2 pr-3 text-xs text-toned"
          >
            No disclosure index
            <TerminalCaveatMark
              :name="`Why ${p.display} has no disclosure index`"
              :text="p.reason ?? ''"
            />
          </td>
          <td v-else colspan="3" class="py-2 pr-3 text-xs text-toned">No parsed entries yet</td>
          <td class="py-2">
            <span class="inline-flex items-center gap-1">
              <TerminalProvenanceTag
                v-if="p.sources[0]"
                :source-url="p.sources[0].source_url"
                :fetched-at="p.sources[0].fetched_at"
              />
              <TerminalCaveatMark
                v-if="p.caveat"
                :name="`Caveat for ${p.display} disclosures`"
                :text="p.caveat"
              />
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
