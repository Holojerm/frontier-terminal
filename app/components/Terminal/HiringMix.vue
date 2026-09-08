<script setup lang="ts">
// Open roles per provider from the current entity set, by department. A job
// board is a set: a role absent from today's payload is closed, so the count
// is the board as it stands, never an accumulating series.
//
// Two caveats ship visibly, not behind a control, because sources.yaml says
// they must: the xAI board is an entity-blended SpaceX/xAI artifact, and
// Google has no public feed — shown as a stated cut, never a number.

import type {
  HiringData,
  HiringHistoryData,
  HiringProviderView,
} from '#shared/utils/terminal-types'

const props = defineProps<{
  hiring: HiringData
  /** When present, each board also shows its change since the comparison day (/hiring). */
  history?: HiringHistoryData | null
}>()

const compare = (p: HiringProviderView) =>
  props.history?.providers.find((h) => h.provider === p.provider)?.compare ?? null
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

const MAX_BARS = 8

const bars = (p: HiringProviderView) => p.departments.slice(0, MAX_BARS)
const overflow = (p: HiringProviderView) => Math.max(0, p.departments.length - MAX_BARS)
const widthPct = (p: HiringProviderView, n: number) => {
  const top = p.departments[0]?.count ?? 1
  return `${Math.max(2, Math.round((n / top) * 100))}%`
}
const share = (p: HiringProviderView, n: number) =>
  p.total === 0 ? '' : `${Math.round((n / p.total) * 100)}%`
</script>

<template>
  <div class="grid gap-4 md:grid-cols-2">
    <article
      v-for="p in hiring.providers"
      :key="p.provider"
      :aria-labelledby="`hiring-${p.provider}`"
      class="space-y-3 rounded border border-default bg-elevated p-4"
    >
      <header class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 :id="`hiring-${p.provider}`" class="text-lg text-highlighted">{{ p.display }}</h3>
        <span v-if="p.feed === 'ok'" class="text-sm text-toned">
          <span class="font-mono text-highlighted">{{ p.total }}</span> open roles
          <template v-if="compare(p)">
            ·
            <NuxtLink
              :to="`/hiring#${p.provider}`"
              class="text-highlighted underline underline-offset-2"
              :title="`${compare(p)!.total_then} open on ${compare(p)!.at}`"
            >
              <span class="font-mono">{{
                signed(compare(p)!.total_now - compare(p)!.total_then)
              }}</span>
              in {{ compare(p)!.days }}d
            </NuxtLink>
          </template>
        </span>
      </header>

      <UAlert
        v-if="p.caveat"
        color="warning"
        variant="soft"
        icon="i-lucide-triangle-alert"
        title="Entity-blended board"
        :description="p.caveat"
      />

      <!-- Honest cut: no public feed, never a fabricated number. -->
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
        title="No parsed roles yet."
        :body="
          p.sources.length
            ? 'The feed has been snapshotted; rows land when its parser lane runs.'
            : 'This board has not been polled yet.'
        "
      />

      <template v-else>
        <ul class="space-y-1">
          <li
            v-for="d in bars(p)"
            :key="d.department"
            class="grid grid-cols-[minmax(6rem,38%)_1fr_auto] items-center gap-2 text-xs"
          >
            <span class="truncate text-toned" :title="d.department">{{ d.department }}</span>
            <span class="h-2 overflow-hidden rounded bg-muted" aria-hidden="true">
              <span class="block h-full bg-primary" :style="{ width: widthPct(p, d.count) }" />
            </span>
            <span class="whitespace-nowrap font-mono text-default">
              {{ d.count }} <span class="text-toned">{{ share(p, d.count) }}</span>
            </span>
          </li>
        </ul>
        <p v-if="overflow(p)" class="text-xs text-toned">+ {{ overflow(p) }} more departments</p>
        <p v-if="p.company_names.length" class="text-xs text-toned">
          company_name on the rows: {{ p.company_names.join(', ') }}
        </p>
      </template>

      <ul v-if="p.sources.length" class="space-y-1">
        <li v-for="s in p.sources" :key="s.source_id">
          <TerminalProvenanceTag
            :label="s.label"
            :source-url="s.source_url"
            :fetched-at="s.fetched_at"
          />
        </li>
      </ul>
    </article>
  </div>
</template>
