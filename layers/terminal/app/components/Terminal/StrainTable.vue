<script setup lang="ts">
// Capacity strain as one row per lab: incidents in the newest window
// against the prior one, what is open now, and the open incident by name.
// A count is a proxy for what the vendor chose to post — never an SLA — so
// each row carries the feed's caveat, and a prior-window count that starts
// after the history does is marked partial, not low. A feed the audit cut is
// a row that says so (sources.yaml `cut.meta-status`).

import { absoluteStamp, relativeStamp } from '../../../shared/utils/terminal-format'
import type { IncidentProviderView, IncidentsData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

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

const columns = computed<TableColumn[]>(() => [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'last', label: `Last ${props.incidents.window_days}d`, numeric: true },
  { key: 'prior', label: `Prior ${props.incidents.window_days}d`, numeric: true },
  { key: 'open', label: 'Open', numeric: true },
  { key: 'incident', label: 'Open incident', class: 'max-w-72 text-xs' },
  { key: 'source', label: 'Source', keep: true },
])
</script>

<template>
  <TerminalTable
    caption="Status-page incidents per lab: newest window, prior window, open now, and the open incident"
    :columns="columns"
    :rows="incidents.providers"
    :row-key="(p) => p.provider"
    :gap="(p) => p.feed !== 'ok'"
  >
    <template #cell-last="{ row: p }">
      <span class="text-highlighted">{{ p.last_window }}</span>
    </template>
    <template #cell-prior="{ row: p }">
      {{ p.prior_window }}
      <TerminalCaveatMark
        v-if="priorPartial(p)"
        :name="`Why ${p.display}’s prior window is partial`"
        :text="`We have history since ${absoluteStamp(p.coverage_from!, now)}. The prior window is partial until our checks cover all of it.`"
      />
    </template>
    <template #cell-open="{ row: p }">
      <span :class="p.open.length ? 'text-warning' : undefined">{{ p.open.length }}</span>
    </template>
    <template #cell-incident="{ row: p }">
      <!-- One line: the title truncates (its full text is the tooltip) so an
           open incident does not make its row three lines tall. -->
      <span v-if="p.open[0]" class="flex max-w-64 min-w-0 items-baseline gap-1">
        <a
          :href="p.open[0].incident_url"
          target="_blank"
          rel="noopener noreferrer"
          class="min-w-0 truncate text-default underline decoration-1 underline-offset-2 hover:text-highlighted"
          :title="p.open[0].title"
          >{{ p.open[0].title }}</a
        >
        <span class="whitespace-nowrap text-muted">
          {{ p.open[0].impact ?? 'impact not published' }} · since
          <time :datetime="p.open[0].started_at" :title="p.open[0].started_at">{{
            relativeStamp(p.open[0].started_at, now)
          }}</time>
          <template v-if="p.open.length > 1"> +{{ p.open.length - 1 }}</template>
        </span>
      </span>
      <span v-else class="text-muted">none</span>
    </template>
    <template #cell-source="{ row: p }">
      <TerminalSources
        :sources="p.sources.slice(0, 1)"
        :caveats="
          p.caveat ? [{ name: `Caveat for ${p.display} status incidents`, text: p.caveat }] : []
        "
      />
    </template>
    <template #gap="{ row: p }">
      <TerminalGap inline v-bind="feedGap('incidents', p)!" />
    </template>
  </TerminalTable>
</template>
