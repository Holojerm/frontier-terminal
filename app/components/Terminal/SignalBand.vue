<script setup lang="ts">
// The lead band: what an analyst should act on, above everything else.
// Order of precedence, top to bottom — alert-tier rows, the ticker, then raw
// change counts by axis, then an explicit quiet state. A terminal that
// cannot say "nothing moved" is a terminal you have to re-read every morning.

import { relativeStamp } from '#shared/utils/terminal-format'
import type { OverviewData } from '#shared/utils/terminal-types'

const props = defineProps<{ overview: OverviewData }>()

const now = useNow()
const movement = computed(() => props.overview.movement)

const counters = computed(() => [
  { label: 'pricing', n: movement.value.recent.pricing },
  { label: 'hiring', n: movement.value.recent.hiring },
  { label: 'sec', n: movement.value.recent.sec },
])

/**
 * Why a quiet band is quiet. Three situations look identical as a zero and
 * are not: nothing has been compared yet, everything was compared and held
 * still, or something moved but not lately. A band that prints the same
 * sentence for all three is not reporting, it is decorating.
 */
const quietReason = computed(() => {
  const m = movement.value
  if (m.recent.total > 0) return null
  if (m.sources_total === 0) {
    return 'No source has been polled yet, so there is nothing to compare. The first poll writes a baseline; the second can produce a change.'
  }
  const compared = m.sources_total - m.sources_not_yet_compared
  if (m.total_changes === 0 && compared === 0) {
    return `First observation: all ${m.sources_total} sources have exactly one snapshot, so nothing has been diffed yet. The next poll produces the first comparison.`
  }
  if (m.total_changes === 0) {
    return `No change on record: ${compared} of ${m.sources_total} sources have been compared against an earlier snapshot and none has moved.`
  }
  return `No change in the ${m.window_hours}h to the newest detection. ${m.total_changes} change${m.total_changes === 1 ? '' : 's'} on record overall.`
})
</script>

<template>
  <section
    id="signal"
    aria-labelledby="signal-heading"
    class="space-y-4 rounded border border-default bg-elevated p-4 sm:p-6"
  >
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="signal-heading" class="text-2xl text-highlighted">Signal</h2>
      <p v-if="overview.latest_fetched_at" class="text-xs text-toned">
        newest fetch
        <time :datetime="overview.latest_fetched_at" :title="overview.latest_fetched_at">
          {{ relativeStamp(overview.latest_fetched_at, now) }}
        </time>
      </p>
    </header>

    <!-- 1. Alert-tier rows (notable, critical), if any. -->
    <TerminalAlertList v-if="overview.alerts.length" :alerts="overview.alerts" :level="3" />
    <p v-if="overview.alert_count > overview.alerts.length" class="text-sm">
      <NuxtLink to="/alerts" class="text-highlighted underline underline-offset-2">
        All {{ overview.alert_count }} alerts
      </NuxtLink>
    </p>

    <!-- 2. The ticker (info): what moved at low stakes, one line each. -->
    <section v-if="overview.ticker.length" aria-labelledby="ticker-heading" class="space-y-2">
      <h3 id="ticker-heading" class="text-xs tracking-wide text-toned uppercase">Ticker</h3>
      <TerminalTickerList :alerts="overview.ticker" />
      <p v-if="overview.ticker_count > overview.ticker.length" class="text-sm">
        <NuxtLink to="/alerts#ticker" class="text-highlighted underline underline-offset-2">
          All {{ overview.ticker_count }} ticker lines
        </NuxtLink>
      </p>
    </section>

    <!-- 3. Raw movement, whether or not the judge spoke. -->
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm text-toned">
      <span>
        <span class="font-mono text-lg text-highlighted">{{ movement.recent.total }}</span>
        change{{ movement.recent.total === 1 ? '' : 's' }}
      </span>
      <span v-if="movement.window_from && movement.latest_detected_at" class="text-xs">
        in the {{ movement.window_hours }}h to
        <time
          :datetime="movement.latest_detected_at"
          :title="`window ${movement.window_from} → ${movement.latest_detected_at}`"
        >
          {{ relativeStamp(movement.latest_detected_at, now) }}
        </time>
      </span>
      <span v-for="c in counters" :key="c.label">
        {{ c.label }} <span class="font-mono text-default">{{ c.n }}</span>
      </span>
      <span v-if="overview.alerts.length === 0 && movement.recent.total > 0" class="text-xs">
        {{ overview.ticker.length ? 'nothing above the ticker' : 'none judged alert-worthy' }}
      </span>
    </div>

    <!-- 4. Quiet state, said plainly and with its reason. -->
    <p v-if="quietReason" class="text-sm text-toned">{{ quietReason }}</p>
  </section>
</template>
