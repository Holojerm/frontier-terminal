<script setup lang="ts">
// Capacity strain per provider: how many incidents each lab posted on its
// own status page in the newest 30 days against the 30 before, and what is
// open right now. A count is a proxy for what the vendor chose to post —
// never an SLA — so each card carries the feed's caveat and says where its
// history begins: a Statuspage feed is a rolling window, and a prior-30
// count that starts after the window does is partial, not low.
//
// xAI ships as a stated cut (sources.yaml `cut.xai-status`), the way
// Google hiring does — a 403 is not a zero.

import { absoluteStamp, relativeStamp } from '#shared/utils/terminal-format'
import type { IncidentProviderView, IncidentsData } from '#shared/utils/terminal-types'

const props = defineProps<{ incidents: IncidentsData }>()

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

/** Bar width against the larger of the two counts on the card — 100% is that card's own max. */
const widthPct = (p: IncidentProviderView, n: number) => {
  const top = Math.max(p.last_window, p.prior_window, 1)
  return `${Math.max(2, Math.round((n / top) * 100))}%`
}

const bars = (p: IncidentProviderView) => [
  { label: `last ${props.incidents.window_days}d`, n: p.last_window, tone: 'bg-primary' },
  { label: `prior ${props.incidents.window_days}d`, n: p.prior_window, tone: 'bg-accented' },
]
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4 md:grid-cols-2">
      <article
        v-for="p in incidents.providers"
        :key="p.provider"
        :aria-labelledby="`strain-${p.provider}`"
        class="space-y-3 rounded border border-default bg-elevated p-4"
      >
        <header class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 :id="`strain-${p.provider}`" class="text-lg text-highlighted">{{ p.display }}</h3>
          <span v-if="p.feed === 'ok'" class="text-sm text-toned">
            <span class="font-mono text-highlighted">{{ p.open.length }}</span>
            open now
          </span>
        </header>

        <!-- Honest cut: no public feed, never a fabricated zero. -->
        <UAlert
          v-if="p.feed === 'no_public_feed'"
          color="info"
          variant="soft"
          icon="i-lucide-eye-off"
          title="No public feed"
          :description="`${p.reason ?? ''} Verdict transcribed from the source audit — showing nothing beats guessing.`"
        />

        <TerminalEmptyState
          v-else-if="p.feed === 'no_rows'"
          title="No parsed incidents yet."
          :body="
            p.sources.length
              ? 'The feed has been snapshotted; rows land when its parser lane runs.'
              : 'This status page has not been polled yet.'
          "
        />

        <template v-else>
          <ul class="space-y-1">
            <li
              v-for="b in bars(p)"
              :key="b.label"
              class="grid grid-cols-[minmax(5rem,30%)_1fr_auto] items-center gap-2 text-xs"
            >
              <span class="text-toned">{{ b.label }}</span>
              <span class="h-2 overflow-hidden rounded bg-muted" aria-hidden="true">
                <span class="block h-full" :class="b.tone" :style="{ width: widthPct(p, b.n) }" />
              </span>
              <span class="whitespace-nowrap font-mono text-default">{{ b.n }}</span>
            </li>
          </ul>

          <p v-if="priorPartial(p)" class="text-xs text-toned">
            Held history begins {{ absoluteStamp(p.coverage_from!, now) }} — the prior window is
            partial until the feed has been polled through it.
          </p>

          <ul v-if="p.open.length" class="space-y-1">
            <li v-for="i in p.open" :key="i.entity_key" class="text-sm">
              <UBadge color="warning" variant="subtle" size="sm" icon="i-lucide-activity">
                {{ i.impact }}
              </UBadge>
              <a
                :href="i.incident_url"
                target="_blank"
                rel="noopener noreferrer"
                class="ml-2 text-highlighted underline underline-offset-2"
                >{{ i.title }}</a
              >
              <span class="ml-2 text-xs text-toned">
                {{ i.status }} · since
                <time :datetime="i.started_at" :title="i.started_at">
                  {{ relativeStamp(i.started_at, now) }}
                </time>
              </span>
            </li>
          </ul>
        </template>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TerminalProvenanceTag
            v-for="s in p.sources"
            :key="s.source_id"
            :label="s.label"
            :source-url="s.source_url"
            :fetched-at="s.fetched_at"
          />
          <TerminalCaveatMark
            v-if="p.caveat"
            :name="`Caveat for ${p.display} status incidents`"
            :text="p.caveat"
          />
        </div>
      </article>
    </div>

    <p class="text-xs text-muted">
      Windows count incidents by the start time the vendor posted, back from the newest status fetch
      (<time :datetime="incidents.window_to" :title="incidents.window_to">{{
        absoluteStamp(incidents.window_to, now)
      }}</time
      >). Impact and status are each vendor’s own words — Statuspage’s none / minor / major /
      critical is not mapped onto Google’s low / medium / high.
    </p>
  </div>
</template>
