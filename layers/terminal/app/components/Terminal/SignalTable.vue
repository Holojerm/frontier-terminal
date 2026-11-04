<script setup lang="ts">
// Alerts as rows, not as a feed: when, which lab, which axis, what moved,
// and the one number behind it. Everything else an alert carries — the
// explanation, the rule that fired it, the cited rows, the source — is on
// the permalink, one click from the headline. Lab and axis are read off the
// cited rows (layers/terminal/shared/utils/terminal-labs.ts), so a row that cites nothing
// says so with a dash rather than a guess.

import { relativeStamp } from '../../../shared/utils/terminal-format'
import {
  AXIS_DISPLAY,
  LAB_DISPLAY,
  alertAxis,
  alertDelta,
  alertLabs,
  clipHeadline,
} from '../../../shared/utils/terminal-labs'
import { alertPath } from '../../../shared/utils/terminal-tiers'
import type { AlertView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{
  alerts: AlertView[]
  /** The page's primary table: it runs with the page instead of its own scroll box. */
  flow?: boolean
}>()

const now = useNow()

const rows = computed(() =>
  props.alerts.map((a) => {
    const labs = alertLabs(a)
    const axis = alertAxis(a)
    return {
      alert: a,
      labs: labs.length ? labs.map((id) => LAB_DISPLAY[id]).join(', ') : null,
      axis: axis ? AXIS_DISPLAY[axis] : null,
      delta: alertDelta(a),
    }
  }),
)

// The headline is the row header: it names the row, and a screen reader
// moving down the table hears what moved rather than a timestamp.
const columns: TableColumn[] = [
  { key: 'when', label: 'When', class: 'whitespace-nowrap font-mono text-xs text-muted' },
  { key: 'labs', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'axis', label: 'Topic', class: 'whitespace-nowrap text-muted' },
  { key: 'headline', label: 'What moved', class: 'min-w-64' },
  { key: 'delta', label: 'Δ', numeric: true, class: 'text-xs' },
]
</script>

<template>
  <TerminalTable
    caption="Alerts, newest first, with the time, lab, topic, headline, and the figure that moved"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.alert.id"
    :row-id="(r) => r.alert.id"
    row-header="headline"
    align="top"
    :flow="flow"
  >
    <template #cell-headline="{ row }">
      <UIcon
        :name="SEVERITY_BADGE[row.alert.severity].icon"
        :class="row.alert.severity === 'critical' ? 'text-error' : 'text-warning'"
        class="mr-1 inline-block size-3.5 align-[-2px]"
        :aria-label="row.alert.severity"
      />
      <NuxtLink
        :to="alertPath(row.alert.id)"
        :title="row.alert.headline"
        class="text-highlighted underline decoration-1 underline-offset-2 hover:text-primary"
      >
        {{ clipHeadline(row.alert.headline) }}
      </NuxtLink>
    </template>
    <template #cell-when="{ row }">
      <time :datetime="row.alert.created_at" :title="row.alert.created_at">
        {{ relativeStamp(row.alert.created_at, now) }}
      </time>
    </template>
    <template #cell-delta="{ row }">{{ row.delta ?? '' }}</template>
  </TerminalTable>
</template>
