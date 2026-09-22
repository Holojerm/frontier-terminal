<script setup lang="ts">
// Alerts as rows, not as a feed: when, which lab, which axis, what moved,
// and the one number behind it. Everything else an alert carries — the
// explanation, the rule that fired it, the cited rows, the source — is on
// the permalink, one click from the headline. Lab and axis are read off the
// cited rows (shared/utils/terminal-labs.ts), so a row that cites nothing
// says so with a dash rather than a guess.

import { relativeStamp } from '#shared/utils/terminal-format'
import {
  AXIS_DISPLAY,
  LAB_DISPLAY,
  alertAxis,
  alertDelta,
  alertLabs,
  clipHeadline,
} from '#shared/utils/terminal-labs'
import { alertPath } from '#shared/utils/terminal-tiers'
import type { AlertView } from '#shared/utils/terminal-types'

defineProps<{ alerts: AlertView[] }>()

const now = useNow()

const labs = (a: AlertView) => {
  const ids = alertLabs(a)
  return ids.length ? ids.map((id) => LAB_DISPLAY[id]).join(', ') : null
}
const axis = (a: AlertView) => {
  const id = alertAxis(a)
  return id ? AXIS_DISPLAY[id] : null
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Alerts, newest first: time, lab, axis, headline and the figure that moved
      </caption>
      <thead>
        <tr class="border-b border-default text-left text-xs text-toned">
          <th scope="col" class="py-2 pr-3 font-medium">When</th>
          <th scope="col" class="py-2 pr-3 font-medium">Lab</th>
          <th scope="col" class="py-2 pr-3 font-medium">Axis</th>
          <th scope="col" class="py-2 pr-3 font-medium">What moved</th>
          <th scope="col" class="py-2 text-right font-medium">Δ</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="alert in alerts"
          :id="alert.id"
          :key="alert.id"
          class="border-b border-default align-top"
        >
          <td class="whitespace-nowrap py-2 pr-3 font-mono text-xs text-toned">
            <time :datetime="alert.created_at" :title="alert.created_at">
              {{ relativeStamp(alert.created_at, now) }}
            </time>
          </td>
          <td class="whitespace-nowrap py-2 pr-3 text-default">{{ labs(alert) ?? '—' }}</td>
          <td class="whitespace-nowrap py-2 pr-3 text-toned">{{ axis(alert) ?? '—' }}</td>
          <th scope="row" class="min-w-64 py-2 pr-3 text-left font-normal">
            <UIcon
              :name="SEVERITY_BADGE[alert.severity].icon"
              :class="alert.severity === 'critical' ? 'text-error' : 'text-warning'"
              class="mr-1 inline-block size-3.5 align-[-2px]"
              :aria-label="alert.severity"
            />
            <NuxtLink
              :to="alertPath(alert.id)"
              :title="alert.headline"
              class="text-highlighted underline decoration-1 underline-offset-2 hover:text-primary"
            >
              {{ clipHeadline(alert.headline) }}
            </NuxtLink>
          </th>
          <td class="whitespace-nowrap py-2 text-right font-mono text-xs text-default">
            {{ alertDelta(alert) ?? '' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
