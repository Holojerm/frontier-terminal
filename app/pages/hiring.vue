<script setup lang="ts">
// The hiring axis over time: open roles per lab per day, reconstructed by
// undoing the change log backwards from each board's current listing, and
// the department mix now against the comparison instant. Google is a stated
// cut and xAI's board carries its entity-blend caveat, both as on the
// landing page.

import { absoluteStamp, count } from '#shared/utils/terminal-format'
import type { HiringHistoryData, HiringHistoryProvider } from '#shared/utils/terminal-types'

const NO_DEPARTMENT = '(no department)'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Hiring',
    summary:
      'Open roles per day at OpenAI, Anthropic and xAI reconstructed from each job board’s change log, with the department mix now against 30 days ago and the caveats per board.',
  },
})

useSeo({
  title: 'Hiring',
  description:
    'Open roles over time at the frontier AI labs, per day and per department, reconstructed from each job board’s change log with the source URL behind every count.',
})

const { data: hiring, error } = await useFetch<HiringHistoryData>('/api/hiring/history')

const now = useNow()

const boards = computed(() =>
  (hiring.value?.providers ?? []).filter((p) => p.feed === 'ok' && p.dates.length > 0),
)

// One x axis across the boards: the union of their dates, with null where
// a board's series has not started.
const chart = computed(() => {
  const dates = [...new Set(boards.value.flatMap((p) => p.dates))].sort()
  return {
    x: dates,
    series: boards.value.map((p) => {
      const at = new Map(p.dates.map((d, i) => [d, p.total[i]!]))
      return { id: p.provider, label: p.display, values: dates.map((d) => at.get(d) ?? null) }
    }),
  }
})

const xLabel = (d: string) => absoluteStamp(`${d}T00:00:00Z`, now.value).replace(/ \d\d:\d\dZ$/, '')

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

const anyLog = computed(() => (hiring.value?.log.changes ?? 0) > 0)

const showTable = ref(false)

const compareRows = (p: HiringHistoryProvider) => p.compare?.departments ?? []
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Hiring</h1>
      <p class="max-w-2xl text-muted">
        Open roles per day, per lab. A job board is a set, so the count on any day is today’s
        listing with every later change undone — a role added after that day removed, a role closed
        after it restored. Nothing is estimated; the log either holds the change or it does not.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Hiring history could not be read"
      description="The history endpoint failed to respond. Nothing is shown rather than a stale or inferred number."
    />

    <template v-else-if="hiring">
      <TerminalPanel
        id="series"
        title="Open roles over time"
        :note="
          anyLog
            ? `${count(hiring.log.changes)} job change rows from ${hiring.log.from?.slice(0, 10)} to ${hiring.log.to?.slice(0, 10)}, applied backwards from each board’s current listing.`
            : 'No job change rows yet; each board shows its current listing only.'
        "
      >
        <TerminalLineChart
          v-if="chart.series.length && chart.x.length > 1"
          :x="chart.x"
          :series="chart.series"
          :format="count"
          :x-label="xLabel"
          :title="`Open roles per day at ${chart.series.map((s) => s.label).join(', ')} from ${chart.x[0]} to ${chart.x.at(-1)}`"
        />
        <TerminalEmptyState
          v-else
          title="No series to draw yet."
          body="A series needs a board with a current listing and at least two days on record. The first poll of each board writes its baseline; the days after it fill the line."
          :action="{ label: 'See coverage', to: '/#coverage' }"
        />

        <UCollapsible v-if="chart.x.length > 1" v-model:open="showTable" class="space-y-2">
          <UButton
            variant="link"
            color="neutral"
            size="sm"
            trailing-icon="i-lucide-chevron-down"
            class="px-0 text-toned"
            :label="showTable ? 'Hide the daily table' : 'Show the daily table'"
          />
          <template #content>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <caption class="sr-only">
                  Open roles at the end of each day, per lab
                </caption>
                <thead>
                  <tr class="border-b border-default text-left">
                    <th scope="col" class="py-2 pr-4 font-medium text-muted">Date</th>
                    <th
                      v-for="s in chart.series"
                      :key="s.id"
                      scope="col"
                      class="py-2 pr-4 text-right font-medium text-muted"
                    >
                      {{ s.label }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(d, i) in chart.x" :key="d" class="border-b border-default">
                    <th scope="row" class="py-1 pr-4 text-left font-normal">
                      <time :datetime="d">{{ d }}</time>
                    </th>
                    <td
                      v-for="s in chart.series"
                      :key="s.id"
                      class="py-1 pr-4 text-right font-mono"
                    >
                      {{ s.values[i] === null ? '—' : count(s.values[i]!) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </UCollapsible>
      </TerminalPanel>

      <TerminalPanel
        id="departments"
        title="Department mix, now against earlier"
        :note="`Each board’s open roles by department today and ${hiring.window_days} days ago — or on the first day on record when the series is younger than that.`"
      >
        <div class="grid gap-4 md:grid-cols-2">
          <article
            v-for="p in hiring.providers"
            :id="p.provider"
            :key="p.provider"
            :aria-labelledby="`mix-${p.provider}`"
            class="space-y-3 rounded border border-default bg-elevated p-4"
          >
            <header class="flex flex-wrap items-baseline justify-between gap-2">
              <h3 :id="`mix-${p.provider}`" class="text-lg text-highlighted">{{ p.display }}</h3>
              <span v-if="p.compare" class="text-sm text-toned">
                <span class="font-mono text-highlighted">{{ p.compare.total_now }}</span> open,
                <span class="font-mono">{{
                  signed(p.compare.total_now - p.compare.total_then)
                }}</span>
                since {{ p.compare.at }} ({{ p.compare.days }}d)
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

            <!-- Honest cut: no public feed, never a fabricated series. -->
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

            <template v-else-if="p.compare">
              <div class="overflow-x-auto">
                <table class="w-full text-xs">
                  <caption class="sr-only">
                    {{
                      p.display
                    }}
                    open roles by department, then and now
                  </caption>
                  <thead>
                    <tr class="border-b border-default text-left">
                      <th scope="col" class="py-1 pr-2 font-medium text-toned">Department</th>
                      <th scope="col" class="py-1 pr-2 text-right font-medium text-toned">
                        {{ p.compare.at }}
                      </th>
                      <th scope="col" class="py-1 pr-2 text-right font-medium text-toned">Now</th>
                      <th scope="col" class="py-1 text-right font-medium text-toned">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="d in compareRows(p)"
                      :key="d.department"
                      class="border-b border-default"
                    >
                      <th
                        scope="row"
                        class="max-w-48 truncate py-1 pr-2 text-left font-normal text-default"
                        :title="d.department"
                      >
                        {{ d.department }}
                      </th>
                      <td class="py-1 pr-2 text-right font-mono text-toned">{{ d.then }}</td>
                      <td class="py-1 pr-2 text-right font-mono text-default">{{ d.now }}</td>
                      <td
                        class="py-1 text-right font-mono"
                        :class="d.now === d.then ? 'text-toned' : 'text-highlighted'"
                      >
                        {{ d.now === d.then ? '·' : signed(d.now - d.then) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p
                v-if="p.join_from && p.compare.at < p.join_from.slice(0, 10)"
                class="text-xs text-toned"
              >
                Departments come from the board’s /departments join, first fetched
                {{ absoluteStamp(p.join_from, now) }}; before that, rows carried no department,
                which the “{{ NO_DEPARTMENT }}” row above reflects.
              </p>
              <p
                v-if="p.baseline_at && p.series_from && p.baseline_at > p.series_from"
                class="text-xs text-toned"
              >
                Rows before this store’s baseline poll ({{ absoluteStamp(p.baseline_at, now) }}) are
                imported history; a role that opened or closed between the last imported poll and
                that baseline is not in the log and is carried as it stands today.
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
      </TerminalPanel>
    </template>
  </div>
</template>
