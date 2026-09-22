<script setup lang="ts">
// Capacity strain as one row per lab: incidents in the newest window
// against the prior one, what is open now, and the open incident by name.
// The front page's reading of the status feeds; the cards with bars are on
// /incidents and the lab pages. A feed the audit cut is a row that says so.

import { absoluteStamp, relativeStamp } from '#shared/utils/terminal-format'
import type { IncidentProviderView, IncidentsData } from '#shared/utils/terminal-types'

// `Omit<…, 'incidents'>` rather than IncidentsData: this table renders the
// per-provider counts and never the incident list, and saying so lets a page
// drop that array before it is serialised into the hydration payload.
const props = defineProps<{ incidents: Omit<IncidentsData, 'incidents'> }>()

const now = useNow()
const DAY_MS = 86_400_000

/** Start of the prior window: two window lengths back from the anchor. */
const priorFrom = computed(() =>
  new Date(
    Date.parse(props.incidents.window_to) - 2 * props.incidents.window_days * DAY_MS,
  ).toISOString(),
)

/** True when the held history starts after the prior window opens. */
const priorPartial = (p: IncidentProviderView) =>
  p.coverage_from !== null && p.coverage_from > priorFrom.value
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Status-page incidents per lab: newest window, prior window, open now, and the open incident
      </caption>
      <thead>
        <tr class="border-b border-default text-left text-xs text-toned">
          <th scope="col" class="py-2 pr-3 font-medium">Lab</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">
            Last {{ incidents.window_days }}d
          </th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">
            Prior {{ incidents.window_days }}d
          </th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Open</th>
          <th scope="col" class="py-2 pr-3 font-medium">Open incident</th>
          <th scope="col" class="py-2 font-medium">Source</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in incidents.providers"
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
            <td class="py-2 pr-3 text-right font-mono text-highlighted">{{ p.last_window }}</td>
            <td class="whitespace-nowrap py-2 pr-3 text-right font-mono text-default">
              {{ p.prior_window }}
              <TerminalCaveatMark
                v-if="priorPartial(p)"
                :name="`Why ${p.display}’s prior window is partial`"
                :text="`Held history begins ${absoluteStamp(p.coverage_from!, now)}; the prior window is partial until the feed has been polled through it.`"
              />
            </td>
            <td
              class="py-2 pr-3 text-right font-mono"
              :class="p.open.length ? 'text-warning' : 'text-default'"
            >
              {{ p.open.length }}
            </td>
            <td class="max-w-72 py-2 pr-3 text-xs">
              <template v-if="p.open[0]">
                <a
                  :href="p.open[0].incident_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-default underline decoration-1 underline-offset-2 hover:text-highlighted"
                  :title="p.open[0].title"
                  >{{ p.open[0].title }}</a
                >
                <span class="ml-1 whitespace-nowrap text-toned">
                  {{ p.open[0].impact }} · since
                  <time :datetime="p.open[0].started_at" :title="p.open[0].started_at">{{
                    relativeStamp(p.open[0].started_at, now)
                  }}</time>
                </span>
                <span v-if="p.open.length > 1" class="text-toned"> +{{ p.open.length - 1 }}</span>
              </template>
              <span v-else class="text-toned">none</span>
            </td>
          </template>
          <td
            v-else-if="p.feed === 'no_public_feed'"
            colspan="4"
            class="py-2 pr-3 text-xs text-toned"
          >
            No public feed
            <TerminalCaveatMark
              :name="`Why ${p.display} has no status feed`"
              :text="p.reason ?? ''"
            />
          </td>
          <td v-else colspan="4" class="py-2 pr-3 text-xs text-toned">No parsed incidents yet</td>
          <td class="py-2">
            <span class="inline-flex items-center gap-1">
              <TerminalProvenanceTag
                v-if="p.sources[0]"
                :source-url="p.sources[0].source_url"
                :fetched-at="p.sources[0].fetched_at"
              />
              <TerminalCaveatMark
                v-if="p.caveat"
                :name="`Caveat for ${p.display} status incidents`"
                :text="p.caveat"
              />
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
