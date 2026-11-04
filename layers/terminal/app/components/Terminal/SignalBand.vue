<script setup lang="ts">
// The lead band: what changed, as a table an analyst can scan in one
// breath. Alert rows first, then the minor changes as one line, then the raw
// change counts by axis, then an explicit quiet state — a terminal that
// cannot say "nothing moved" is a terminal you have to re-read every morning.

import { relativeStamp } from '../../../shared/utils/terminal-format'
import { alertPath, INFO_TIER_LABEL } from '../../../shared/utils/terminal-tiers'
import type { OverviewData } from '../../../shared/utils/terminal-types'

const props = defineProps<{ overview: OverviewData }>()

/** Rows on the band; the rest are one link away. */
const SHOWN = 5

const now = useNow()
const movement = computed(() => props.overview.movement)
const shown = computed(() => props.overview.alerts.slice(0, SHOWN))
const newestInfo = computed(() => props.overview.info[0] ?? null)

const counters = computed(() => [
  { label: 'prices', n: movement.value.recent.pricing },
  { label: 'hiring', n: movement.value.recent.hiring },
  { label: 'SEC', n: movement.value.recent.sec },
  { label: 'incidents', n: movement.value.recent.incidents },
  { label: 'disclosures', n: movement.value.recent.disclosures },
])

/**
 * Why a quiet band is quiet. Three situations look identical as a zero and
 * are not: nothing has been compared yet, everything was compared and held
 * still, or something moved but not lately.
 */
const quietReason = computed(() => {
  const m = movement.value
  if (m.recent.total > 0) return null
  if (m.sources_total === 0) return 'No source polled yet. Comparison starts on the second poll.'
  const compared = m.sources_total - m.sources_not_yet_compared
  if (m.total_changes === 0 && compared === 0) {
    return `First observation: ${m.sources_total} sources, one snapshot each. Nothing to compare yet.`
  }
  if (m.total_changes === 0) {
    return `No change on record; ${compared} of ${m.sources_total} sources compared.`
  }
  return `No change in the last ${m.window_hours}h. ${m.total_changes} on record overall.`
})
</script>

<template>
  <TerminalPanel
    id="signal"
    title="Signal"
    note="What changed: judged alerts, minor changes, and raw change counts by axis."
    :more="
      overview.alert_count > shown.length
        ? { label: `All ${overview.alert_count} alerts`, to: '/alerts' }
        : undefined
    "
    flush
  >
    <template #meta>
      <span class="flex flex-wrap items-baseline gap-x-3">
        <span v-if="overview.latest_fetched_at">
          newest fetch
          <time :datetime="overview.latest_fetched_at" :title="overview.latest_fetched_at">
            {{ relativeStamp(overview.latest_fetched_at, now) }}
          </time>
        </span>
        <NuxtLink to="/data#coverage" class="underline underline-offset-2 hover:text-default">
          {{ movement.sources_total }} sources
        </NuxtLink>
      </span>
    </template>

    <!-- 1. Alert-tier rows (notable, critical), if any. -->
    <TerminalSignalTable v-if="shown.length" :alerts="shown" />

    <div class="space-y-2 p-3" :class="shown.length ? 'border-t border-default' : undefined">
      <!-- 2. The minor changes, as one line: how much low-stakes movement, and the newest of it. -->
      <p v-if="newestInfo" class="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
        <NuxtLink
          to="/alerts#minor-changes"
          class="whitespace-nowrap underline underline-offset-2 hover:text-default"
        >
          {{ INFO_TIER_LABEL }} · {{ overview.info_count }}
        </NuxtLink>
        <span class="min-w-0 truncate">
          <time :datetime="newestInfo.created_at" class="font-mono text-xs">
            {{ relativeStamp(newestInfo.created_at, now) }}
          </time>
          <NuxtLink
            :to="alertPath(newestInfo.id)"
            :title="newestInfo.headline"
            class="ml-2 hover:text-default"
          >
            {{ newestInfo.headline }}
          </NuxtLink>
        </span>
      </p>

      <!-- 3. Raw movement, whether or not the judge spoke. -->
      <p class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted">
        <span>
          <span class="font-mono text-highlighted">{{ movement.recent.total }}</span>
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
      </p>

      <!-- 4. Quiet state, said plainly and with its reason. -->
      <p v-if="quietReason" class="text-sm text-muted">{{ quietReason }}</p>
    </div>
  </TerminalPanel>
</template>
