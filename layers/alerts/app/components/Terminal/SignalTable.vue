<script setup lang="ts">
// Alerts as rows, not as a feed: when, which lab, which axis, what moved,
// and the one number behind it. Everything else an alert carries — the
// explanation, the rule that fired it, the cited rows, the source — is on
// the permalink, one click from the headline. Lab and axis are read off the
// cited rows (layers/alerts/shared/utils/terminal-labs.ts), so a row that cites nothing
// says so with a dash rather than a guess. "When" is one form down the
// column: the absolute stamp. A relative age that turned absolute past a day
// made the column switch forms partway down.

import {
  AXIS_DISPLAY,
  alertAxis,
  alertDelta,
  alertLabs,
  clipHeadline,
} from '../../../shared/utils/terminal-labs'
import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'
import { alertPath } from '../../../../core/shared/utils/terminal-tiers'
import type { AlertView } from '../../../shared/utils/terminal-types/alerts'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const props = defineProps<{
  alerts: AlertView[]
  /** The page's primary table: it runs with the page instead of its own scroll box. */
  flow?: boolean
  /** The page is one lab's, so a Lab column would repeat its name on every row. */
  scoped?: boolean
}>()

const stamps = useStamps()

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
// moving down the table hears what moved rather than a timestamp. On a phone
// the row stacks: the headline, then when, lab, topic and figure on one line.
const columns = computed<TableColumn[]>(() => [
  {
    key: 'when',
    label: 'When',
    class: 'whitespace-nowrap font-mono text-xs text-muted',
    stack: 'inline',
  },
  ...(props.scoped
    ? []
    : [{ key: 'labs', label: 'Lab', class: 'whitespace-nowrap', stack: 'inline' } as const]),
  { key: 'axis', label: 'Topic', class: 'whitespace-nowrap text-muted', stack: 'inline' },
  // min-w-48, not 64: in the home page's half-width panel at 1440 a wider
  // floor pushed the Δ column 8px past the box.
  { key: 'headline', label: 'What moved', class: 'min-w-48' },
  { key: 'delta', label: 'Δ', numeric: true, class: 'text-xs', stack: 'inline' },
])
</script>

<template>
  <TerminalTable
    :caption="
      scoped
        ? 'Alerts, newest first, with the time, topic, headline, and the figure that moved'
        : 'Alerts, newest first, with the time, lab, topic, headline, and the figure that moved'
    "
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.alert.id"
    :row-id="(r) => r.alert.id"
    row-header="headline"
    align="top"
    :flow="flow"
    stack
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
        {{ stamps.absolute(row.alert.created_at) }}
      </time>
    </template>
    <template #cell-delta="{ row }">{{ row.delta ?? '' }}</template>
  </TerminalTable>
</template>
