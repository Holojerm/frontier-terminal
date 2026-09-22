<script setup lang="ts">
// The lead band: what changed, as a table an analyst can scan in one
// breath. Alert rows first, then the ticker as one line, then the raw
// change counts by axis, then an explicit quiet state — a terminal that
// cannot say "nothing moved" is a terminal you have to re-read every morning.

import { relativeStamp } from '#shared/utils/terminal-format'
import { alertPath } from '#shared/utils/terminal-tiers'
import type { OverviewData } from '#shared/utils/terminal-types'

const props = defineProps<{ overview: OverviewData }>()

/** Rows on the band; the rest are one link away. */
const SHOWN = 5

const now = useNow()
const movement = computed(() => props.overview.movement)
const shown = computed(() => props.overview.alerts.slice(0, SHOWN))
const newestTicker = computed(() => props.overview.ticker[0] ?? null)

const counters = computed(() => [
  { label: 'prices', n: movement.value.recent.pricing },
  { label: 'hiring', n: movement.value.recent.hiring },
  { label: 'SEC', n: movement.value.recent.sec },
  { label: 'incidents', n: movement.value.recent.incidents },
])

/**
 * Why a quiet band is quiet. Three situations look identical as a zero and
 * are not: nothing has been compared yet, everything was compared and held
 * still, or something moved but not lately.
 */
const quietReason = computed(() => {
  const m = movement.value
  if (m.recent.total > 0) return null
  if (m.sources_total === 0)
    return 'No source polled yet. The second poll produces the first comparison.'
  const compared = m.sources_total - m.sources_not_yet_compared
  if (m.total_changes === 0 && compared === 0) {
    return `First observation: ${m.sources_total} sources, one snapshot each. Nothing to compare yet.`
  }
  if (m.total_changes === 0) {
    return `No change on record across ${compared} of ${m.sources_total} compared sources.`
  }
  return `No change in the last ${m.window_hours}h. ${m.total_changes} on record overall.`
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
      <p class="flex flex-wrap items-baseline gap-x-3 text-xs text-toned">
        <span v-if="overview.latest_fetched_at">
          newest fetch
          <time :datetime="overview.latest_fetched_at" :title="overview.latest_fetched_at">
            {{ relativeStamp(overview.latest_fetched_at, now) }}
          </time>
        </span>
        <NuxtLink to="/data#coverage" class="underline underline-offset-2 hover:text-default">
          {{ movement.sources_total }} sources
        </NuxtLink>
      </p>
    </header>

    <!-- 1. Alert-tier rows (notable, critical), if any. -->
    <TerminalSignalTable v-if="shown.length" :alerts="shown" />
    <p v-if="overview.alert_count > shown.length" class="text-sm">
      <NuxtLink to="/alerts" class="text-primary underline underline-offset-2">
        All {{ overview.alert_count }} alerts
      </NuxtLink>
    </p>

    <!-- 2. The ticker, as one line: how much low-stakes movement, and the newest of it. -->
    <p v-if="newestTicker" class="flex flex-wrap items-baseline gap-x-2 text-sm text-toned">
      <NuxtLink
        to="/alerts#ticker"
        class="whitespace-nowrap underline underline-offset-2 hover:text-default"
      >
        Ticker · {{ overview.ticker_count }}
      </NuxtLink>
      <span class="min-w-0 truncate">
        <time :datetime="newestTicker.created_at" class="font-mono text-xs">
          {{ relativeStamp(newestTicker.created_at, now) }}
        </time>
        <NuxtLink
          :to="alertPath(newestTicker.id)"
          :title="newestTicker.headline"
          class="ml-2 hover:text-default"
        >
          {{ newestTicker.headline }}
        </NuxtLink>
      </span>
    </p>

    <!-- 3. Raw movement, whether or not the judge spoke. -->
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm text-toned">
      <span>
        <span class="font-mono text-lg text-highlighted">{{ movement.recent.total }}</span>
        change{{ movement.recent.total === 1 ? '' : 's' }}
        <span v-if="movement.latest_detected_at" class="text-xs">
          in the {{ movement.window_hours }}h to
          <time
            :datetime="movement.latest_detected_at"
            :title="`window ${movement.window_from} → ${movement.latest_detected_at}`"
          >
            {{ relativeStamp(movement.latest_detected_at, now) }}
          </time>
        </span>
      </span>
      <span v-for="c in counters" :key="c.label">
        {{ c.label }} <span class="font-mono text-default">{{ c.n }}</span>
      </span>
    </div>

    <!-- 4. Quiet state, said plainly and with its reason. -->
    <p v-if="quietReason" class="text-sm text-toned">{{ quietReason }}</p>
  </section>
</template>
