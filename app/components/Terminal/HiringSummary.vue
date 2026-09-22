<script setup lang="ts">
// Hiring on the front page: one row per lab — open roles, the change over
// the comparison window, the physical-infrastructure cluster and its
// change, and the department that moved most. Department mix and the
// daily series are on /hiring. A board with no public feed is a row that
// says so; the xAI entity blend ships as a visible mark on its row, as the
// source audit requires.

import type { ClusterSeries, HiringHistoryProvider } from '#shared/utils/terminal-types'
import type { HiringHistoryData } from '#shared/utils/terminal-types'

const props = defineProps<{ history: HiringHistoryData }>()

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '·')

const cluster = (p: HiringHistoryProvider): ClusterSeries | null => p.clusters[0] ?? null

/** The department whose count moved most since the comparison instant, if any moved. */
const topMover = (p: HiringHistoryProvider) => {
  const rows = p.compare?.departments ?? []
  let best: { department: string; d: number } | null = null
  for (const r of rows) {
    const d = r.now - r.then
    if (d !== 0 && (best === null || Math.abs(d) > Math.abs(best.d)))
      best = { department: r.department, d }
  }
  return best
}

const clusterLabel = computed(
  () => props.history.providers.map(cluster).find((c) => c !== null)?.label ?? 'Infrastructure',
)
const days = computed(
  () => props.history.providers.find((p) => p.compare)?.compare?.days ?? props.history.window_days,
)
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Open roles per lab, the change over the comparison window, the infrastructure cluster, and
        the department that moved most
      </caption>
      <thead>
        <tr class="border-b border-default text-left text-xs text-toned">
          <th scope="col" class="py-2 pr-3 font-medium">Lab</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Open roles</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Δ {{ days }}d</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">{{ clusterLabel }}</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Δ</th>
          <th scope="col" class="py-2 pr-3 font-medium">Moved most</th>
          <th scope="col" class="py-2 font-medium">Source</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in history.providers"
          :key="p.provider"
          class="border-b border-default align-baseline"
        >
          <th
            scope="row"
            class="whitespace-nowrap py-2 pr-3 text-left font-normal text-highlighted"
          >
            <NuxtLink
              :to="`/hiring#${p.provider}`"
              class="hover:underline hover:underline-offset-2"
            >
              {{ p.display }}
            </NuxtLink>
            <TerminalCaveatMark
              v-if="p.caveat"
              label="blended board"
              :text="p.caveat"
              class="ml-2"
            />
          </th>
          <template v-if="p.feed === 'ok' && p.total.length">
            <td class="py-2 pr-3 text-right font-mono text-highlighted">{{ p.total.at(-1) }}</td>
            <td class="py-2 pr-3 text-right font-mono text-default">
              {{ p.compare ? signed(p.compare.total_now - p.compare.total_then) : '—' }}
            </td>
            <td class="py-2 pr-3 text-right font-mono text-default">
              {{ cluster(p) ? cluster(p)!.now : '—' }}
            </td>
            <td class="py-2 pr-3 text-right font-mono text-default">
              {{
                cluster(p) && cluster(p)!.then !== null
                  ? signed(cluster(p)!.now - cluster(p)!.then!)
                  : '—'
              }}
            </td>
            <td class="py-2 pr-3 text-xs text-toned">
              <template v-if="topMover(p)">
                <span class="text-default">{{ topMover(p)!.department }}</span>
                <span class="ml-1 font-mono">{{ signed(topMover(p)!.d) }}</span>
              </template>
              <template v-else>none</template>
            </td>
          </template>
          <td
            v-else-if="p.feed === 'no_public_feed'"
            colspan="5"
            class="py-2 pr-3 text-xs text-toned"
          >
            No public feed
            <TerminalCaveatMark
              :name="`Why ${p.display} has no hiring feed`"
              :text="p.reason ?? ''"
            />
          </td>
          <td v-else colspan="5" class="py-2 pr-3 text-xs text-toned">No parsed roles yet</td>
          <td class="py-2">
            <TerminalProvenanceTag
              v-if="p.sources[0]"
              :source-url="p.sources[0].source_url"
              :fetched-at="p.sources[0].fetched_at"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
