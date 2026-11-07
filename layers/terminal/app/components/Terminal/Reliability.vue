<script setup lang="ts">
// /data#reliability: the feed's own track record, for a reviewer deciding
// whether to depend on it. Each source's checks, the periods our data was
// older than we say, how fast a filing reached an alert, each deploy's smoke
// test, and the corrections log. Every figure comes from /api/reliability,
// which computes it from stored records (terminal-reliability.ts).

import { absoluteStamp, count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import {
  durationLabel,
  type DeployCheck,
  type FilingDetection,
  type ReliabilityData,
  type RunTally,
  type SourceReliability,
} from '../../../shared/utils/terminal-reliability'
import { alertPath } from '../../../shared/utils/terminal-tiers'
import type { Fact, TableColumn } from '../../types/terminal-ui'

import manifest from '~~/fleet.json'

const now = useNow()
const { data, error } = await useFetch<ReliabilityData>('/api/reliability')
const at = (iso: string) => absoluteStamp(iso, now.value)
const repo = manifest.links.github

const pct = (t: RunTally | null) =>
  t === null
    ? 'Building'
    : t.runs === 0
      ? 'None yet'
      : `${(Math.floor((t.good / t.runs) * 1000) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`

const every = (minutes: number) => (minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`)

const PROVIDER: Record<string, string> = { ...LAB_DISPLAY, all: 'market-wide', other: 'other' }

const sourceHref = (s: SourceReliability) => (s.members ? '#coverage' : `#source-${s.source_id}`)

const sourceColumns: TableColumn[] = [
  { key: 'label', label: 'Source', class: 'min-w-44' },
  { key: 'stated', label: 'Checked every', class: 'whitespace-nowrap' },
  { key: 'short', label: '30 days', numeric: true, hint: 'Good checks' },
  { key: 'long', label: '90 days', numeric: true, hint: 'Good checks' },
  { key: 'gap', label: 'Longest wait for a good check', class: 'min-w-48' },
]

const periodColumns: TableColumn[] = [
  { key: 'from', label: 'Past its stated age from', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'to', label: 'Next check', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'minutes', label: 'Late by', numeric: true },
]

const detectionColumns: TableColumn[] = [
  { key: 'filing', label: 'Filing', class: 'min-w-56' },
  { key: 'accepted', label: 'EDGAR accepted', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'alerted', label: 'We alerted', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'from_acceptance', label: 'From acceptance', numeric: true },
  { key: 'from_release', label: 'From release', numeric: true },
]

const deployColumns: TableColumn[] = [
  { key: 'commit', label: 'Commit', class: 'font-mono text-xs' },
  { key: 'started', label: 'Pushed', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'result', label: 'Smoke test' },
]

const RESULT: Record<
  string,
  { color: 'success' | 'error' | 'neutral' | 'info'; icon: string; label: string }
> = {
  success: { color: 'success', icon: 'i-lucide-check', label: 'passed' },
  failure: { color: 'error', icon: 'i-lucide-x', label: 'failed' },
  timed_out: { color: 'error', icon: 'i-lucide-x', label: 'timed out' },
  cancelled: { color: 'neutral', icon: 'i-lucide-skip-forward', label: 'superseded' },
}
const resultOf = (d: DeployCheck) =>
  d.status !== 'completed'
    ? { color: 'info' as const, icon: 'i-lucide-loader', label: 'running' }
    : (RESULT[d.conclusion ?? ''] ?? {
        color: 'neutral' as const,
        icon: 'i-lucide-minus',
        label: d.conclusion ?? 'no result',
      })

const latency = (m: number | null) => (m === null ? 'none yet' : durationLabel(m))
const figure = (m: number | null) => (m === null ? 'None yet' : durationLabel(m))

const releasedLater = (r: FilingDetection) =>
  r.released_at !== null && r.accepted_at !== null && r.released_at !== r.accepted_at

const facts = computed<Fact[]>(() => {
  const d = data.value
  if (!d) return []
  const all = d.building
    ? null
    : d.sources.rows.reduce(
        (t, s) => ({ runs: t.runs + (s.short?.runs ?? 0), good: t.good + (s.short?.good ?? 0) }),
        { runs: 0, good: 0 },
      )
  const sec = d.freshness.find((l) => l.id === 'sec')
  const decided = d.deploys.tally.success + d.deploys.tally.failure
  return [
    { key: 'checks', label: 'Good checks, 30 days', value: pct(all), mono: true },
    {
      key: 'stale',
      label: 'SEC feeds late, 90 days',
      value: d.building ? 'Building' : sec?.checks ? durationLabel(sec.stale_minutes) : 'None yet',
      mono: true,
    },
    {
      key: 'acceptance',
      label: 'EDGAR acceptance to alert, median',
      value: figure(d.detection.acceptance.median_minutes),
      mono: true,
    },
    {
      key: 'release',
      label: 'EDGAR release to alert, median',
      value: figure(d.detection.release.median_minutes),
      mono: true,
    },
    {
      key: 'deploys',
      label: 'Deploys that passed',
      value:
        d.deploys.fetched_at === null
          ? 'Not read yet'
          : decided
            ? `${d.deploys.tally.success} of ${decided}`
            : 'None yet',
      mono: true,
    },
    { key: 'corrections', label: 'Corrections', value: count(d.corrections.count), mono: true },
  ]
})

/** While the rollup backfills, what it covers so far, in place of figures that would read as an outage. */
const buildingReason = computed(() => {
  const b = data.value?.building
  if (!b) return ''
  const through = b.rolled_through
    ? `Covered through ${at(b.rolled_through)}`
    : 'Nothing counted yet'
  const from = b.started ? `, from ${b.started}` : ''
  return `${through}${from}. History fills in within a run or two of a deploy. Gaps and late periods show once the count reaches the present.`
})

const link = 'text-primary underline underline-offset-2'
const code = 'font-mono text-highlighted'
</script>

<template>
  <TerminalPanel
    id="reliability"
    title="Reliability"
    note="How our own feed has held up: checks by source, stale data, filing alerts against EDGAR, deploys, and corrections. Every figure comes from stored records."
  >
    <TerminalGap
      v-if="error || !data"
      title="Reliability figures didn’t load"
      reason="The rest of this page still works. The same figures are at /api/reliability."
    />
    <div v-else class="flex flex-col gap-6 text-sm text-default">
      <TerminalFacts :items="facts" :cols="3" />

      <section class="space-y-2" aria-labelledby="reliability-sources">
        <h3 id="reliability-sources" class="text-highlighted">Checks by source</h3>
        <p class="max-w-3xl text-muted">
          A good check is one where the source answered: new content, the same content, or a page
          that isn’t there. Pages we build per model or per filing are grouped by kind. Worst first.
          <template v-if="data.sources.first_day">
            Counted from <time :datetime="data.sources.first_day">{{ data.sources.first_day }}</time
            ><template v-if="data.sources.rolled_through">
              through
              <time :datetime="data.sources.rolled_through">{{
                at(data.sources.rolled_through)
              }}</time></template
            >.
          </template>
        </p>
        <TerminalGap v-if="data.building" title="Building history" :reason="buildingReason" />
        <TerminalGap
          v-else-if="data.sources.rows.every((s) => !s.long?.runs)"
          title="No checks counted yet"
          reason="The hourly rollup hasn’t run on this database yet."
        />
        <TerminalTable
          v-else
          caption="Each source with its share of good checks over 30 and 90 days and its longest wait for a good check, worst first"
          :columns="sourceColumns"
          :rows="data.sources.rows"
          :row-key="(s) => s.source_id"
          :gap="(s) => !s.long?.runs"
          :gap-columns="['short', 'long', 'gap']"
          :edge="false"
          align="top"
        >
          <template #cell-label="{ row: s }">
            <a :href="sourceHref(s)" class="text-highlighted underline underline-offset-2">{{
              s.label
            }}</a>
            <span class="block text-xs text-muted"
              >{{ PROVIDER[s.provider] ?? s.provider }} · {{ s.axis }}</span
            >
          </template>
          <template #cell-stated="{ row: s }">{{ every(s.stated_minutes) }}</template>
          <template #cell-short="{ row: s }">
            {{ pct(s.short) }}
            <span v-if="s.short" class="block text-xs text-muted"
              >{{ count(s.short.good) }} of {{ count(s.short.runs) }}</span
            >
          </template>
          <template #cell-long="{ row: s }">
            {{ pct(s.long) }}
            <span v-if="s.long" class="block text-xs text-muted"
              >{{ count(s.long.good) }} of {{ count(s.long.runs) }}</span
            >
          </template>
          <template #cell-gap="{ row: s }">
            <template v-if="s.longest_gap">
              <span class="font-mono">{{ durationLabel(s.longest_gap.minutes) }}</span>
              <span class="block text-xs text-muted">
                <template v-if="s.longest_gap.to">
                  <time :datetime="s.longest_gap.from">{{ at(s.longest_gap.from) }}</time> to
                  <time :datetime="s.longest_gap.to">{{ at(s.longest_gap.to) }}</time>
                </template>
                <template v-else>
                  Still waiting since
                  <time :datetime="s.longest_gap.from">{{ at(s.longest_gap.from) }}</time>
                </template>
              </span>
            </template>
            <span v-else class="text-xs text-muted">One good check so far</span>
          </template>
          <template #gap>No checks in the last {{ data.days.long }} days.</template>
        </TerminalTable>
      </section>

      <section class="space-y-3" aria-labelledby="reliability-freshness">
        <h3 id="reliability-freshness" class="text-highlighted">
          When our data was older than we say
        </h3>
        <p class="max-w-3xl text-muted">
          We say how often we check on
          <NuxtLink to="/about#latency" :class="link">the About page</NuxtLink>. These are the
          stretches, over the last {{ data.days.long }} days, when no check ran in which most
          sources answered. A check can run late by the grace shown before we count it.
        </p>
        <TerminalGap v-if="data.building" title="Building history" :reason="buildingReason" />
        <div v-for="lane in data.building ? [] : data.freshness" :key="lane.id" class="space-y-2">
          <p>
            <span class="text-highlighted">{{ lane.label }}</span>
            <span class="text-muted">
              (every {{ every(lane.stated_minutes) }}, grace {{ lane.grace_minutes }} min).</span
            >
            <template v-if="lane.checks === 0"> No checks counted yet.</template>
            <template v-else-if="lane.periods.length === 0">
              Never late in {{ count(lane.checks) }} checks since
              <time :datetime="lane.from!">{{ at(lane.from!) }}</time
              >.
            </template>
            <template v-else>
              Late {{ lane.periods.length }} {{ lane.periods.length === 1 ? 'time' : 'times' }} for
              {{ durationLabel(lane.stale_minutes) }} in all, over {{ count(lane.checks) }} checks
              since <time :datetime="lane.from!">{{ at(lane.from!) }}</time
              >.
            </template>
          </p>
          <TerminalExpand
            v-if="lane.periods.length"
            :show="`Show the ${lane.periods.length === 1 ? 'period' : 'periods'}`"
            :hide="`Hide the ${lane.periods.length === 1 ? 'period' : 'periods'}`"
          >
            <TerminalTable
              :caption="`Periods when ${lane.label.toLowerCase()} were past their stated age, newest first`"
              :columns="periodColumns"
              :rows="lane.periods"
              :row-key="(p) => p.from"
              :edge="false"
              nested
            >
              <template #cell-from="{ row: p }"
                ><time :datetime="p.from">{{ at(p.from) }}</time></template
              >
              <template #cell-to="{ row: p }">
                <time v-if="p.to" :datetime="p.to">{{ at(p.to) }}</time>
                <span v-else class="font-sans text-muted">still late</span>
              </template>
              <template #cell-minutes="{ row: p }">{{ durationLabel(p.minutes) }}</template>
            </TerminalTable>
          </TerminalExpand>
        </div>
      </section>

      <section class="space-y-2" aria-labelledby="reliability-filings">
        <h3 id="reliability-filings" class="text-highlighted">SEC filings: EDGAR to our alert</h3>
        <p class="max-w-3xl text-muted">
          Each filing one of our rules alerted on (S-1s and amendments, 424B4s, 10-Qs and 10-Ks of
          the companies we track, and a lab’s first registration). No model writes these alerts, so
          the alert time is when the check that saw the filing ran. We read EDGAR’s acceptance time
          from the copy of the filer’s submissions feed or filing index we stored. EDGAR doesn’t
          publish a filing accepted after 5:30 p.m. Eastern until 6:00 a.m. Eastern on its filing
          date, so we time those from release too.
        </p>
        <TerminalGap
          v-if="data.detection.rows.length === 0"
          title="No filing alerts timed yet"
          reason="None of our rules has alerted on a filing, or the hourly job hasn’t read them yet."
        />
        <template v-else>
          <p>
            {{ data.detection.rows.length }}
            {{ data.detection.rows.length === 1 ? 'filing' : 'filings' }} since
            <time :datetime="data.detection.from!">{{ at(data.detection.from!) }}</time
            >. From release, the median is {{ latency(data.detection.release.median_minutes) }} and
            the slowest {{ latency(data.detection.release.worst_minutes) }}. From acceptance, the
            median is {{ latency(data.detection.acceptance.median_minutes) }} and the slowest
            {{ latency(data.detection.acceptance.worst_minutes) }}.
            <template v-if="data.detection.missing">
              {{ data.detection.missing }} {{ data.detection.missing === 1 ? 'has' : 'have' }} no
              stored acceptance time.
            </template>
          </p>
          <TerminalTable
            caption="Each filing a rule alerted on, with EDGAR’s acceptance time, our alert time, and the minutes between"
            :columns="detectionColumns"
            :rows="data.detection.rows"
            :row-key="(r) => r.accession_no"
            :edge="false"
            align="top"
          >
            <template #cell-filing="{ row: r }">
              <NuxtLink
                :to="alertPath(r.alert_id)"
                class="text-highlighted underline underline-offset-2"
                >{{ r.headline }}</NuxtLink
              >
              <span class="block text-xs text-muted">
                <span class="font-mono">{{ r.accession_no }}</span> · {{ r.rule }}
              </span>
            </template>
            <template #cell-accepted="{ row: r }">
              <template v-if="r.accepted_at">
                <a
                  :href="r.source_url ?? r.filing_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline underline-offset-2 hover:text-primary"
                  :title="r.fetched_at ? `Read from our copy fetched ${r.fetched_at}` : undefined"
                  ><time :datetime="r.accepted_at">{{ at(r.accepted_at) }}</time></a
                >
                <span v-if="releasedLater(r)" class="block font-sans text-muted"
                  >public <time :datetime="r.released_at!">{{ at(r.released_at!) }}</time></span
                >
              </template>
              <span v-else class="font-sans text-muted"
                >not in our copies (<a
                  :href="r.filing_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline underline-offset-2 hover:text-primary"
                  >EDGAR index</a
                >)</span
              >
            </template>
            <template #cell-alerted="{ row: r }"
              ><time :datetime="r.alerted_at">{{ at(r.alerted_at) }}</time></template
            >
            <template #cell-from_acceptance="{ row: r }">{{
              latency(r.minutes_from_acceptance)
            }}</template>
            <template #cell-from_release="{ row: r }">{{
              latency(r.minutes_from_release)
            }}</template>
          </TerminalTable>
          <p class="text-muted">
            Alerts our judge writes (8-Ks, say) aren’t timed here. The
            <NuxtLink to="/alerts?tab=track-record" :class="link">track record</NuxtLink> times
            every notable alert against the first press report.
          </p>
        </template>
      </section>

      <section class="space-y-2" aria-labelledby="reliability-deploys">
        <h3 id="reliability-deploys" class="text-highlighted">Deploys</h3>
        <p class="max-w-3xl text-muted">
          Every push to main runs a smoke test once it’s live. It waits for production to serve that
          commit, then checks the main pages and routes. A test cut short by a newer push shows as
          superseded. We read the results from
          <a
            :href="data.deploys.workflow_url"
            target="_blank"
            rel="noopener noreferrer"
            :class="link"
            >GitHub Actions</a
          >
          every hour.
        </p>
        <TerminalGap
          v-if="data.deploys.fetched_at === null"
          title="Not read from GitHub yet"
          reason="GitHub limits reads without a token by IP address, and Cloudflare’s servers share theirs with other sites, so GitHub can refuse our read for a while. When it does, we wait for its limit to reset (up to an hour) and try again. After any other failure we try again the next hour. The results are public on GitHub Actions meanwhile."
        />
        <TerminalGap
          v-else-if="data.deploys.rows.length === 0"
          title="No deploys in the last 90 days"
        />
        <template v-else>
          <p>
            {{ data.deploys.tally.success }} passed, {{ data.deploys.tally.failure }} failed, and
            {{ data.deploys.tally.cancelled }} superseded<template v-if="data.deploys.tally.running"
              >, with {{ data.deploys.tally.running }} running</template
            >, since <time :datetime="data.deploys.from!">{{ at(data.deploys.from!) }}</time
            >, when the smoke test started.
            <template v-if="data.deploys.build_sha">
              This page is served by
              <a
                :href="`${repo}/commit/${data.deploys.build_sha}`"
                target="_blank"
                rel="noopener noreferrer"
                :class="`${link} font-mono`"
                >{{ data.deploys.build_sha.slice(0, 8) }}</a
              >.
            </template>
          </p>
          <TerminalTable
            caption="Each push to main with its smoke test result, newest first"
            :columns="deployColumns"
            :rows="data.deploys.rows"
            :row-key="(d) => d.run_id"
            :edge="false"
          >
            <template #cell-commit="{ row: d }">
              <a
                :href="`${repo}/commit/${d.head_sha}`"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-primary"
                >{{ d.head_sha.slice(0, 8) }}</a
              >
            </template>
            <template #cell-started="{ row: d }"
              ><time :datetime="d.created_at">{{ at(d.created_at) }}</time></template
            >
            <template #cell-result="{ row: d }">
              <a
                :href="d.html_url"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="`Smoke test ${resultOf(d).label}, run on GitHub`"
              >
                <UBadge
                  :color="resultOf(d).color"
                  :icon="resultOf(d).icon"
                  variant="subtle"
                  size="sm"
                  >{{ resultOf(d).label }}</UBadge
                >
              </a>
            </template>
          </TerminalTable>
        </template>
      </section>

      <section class="space-y-2" aria-labelledby="reliability-corrections">
        <h3 id="reliability-corrections" class="text-highlighted">Corrections</h3>
        <p class="max-w-3xl">
          {{ data.corrections.count }}
          {{ data.corrections.count === 1 ? 'correction' : 'corrections' }} so far.
          <template v-if="data.corrections.latest">
            The latest, on
            <time :datetime="data.corrections.latest.on">{{ data.corrections.latest.on }}</time>
            ({{ data.corrections.latest.area }}): {{ data.corrections.latest.what }}
          </template>
          {{ ' ' }}<NuxtLink :to="data.corrections.url" :class="link">Every correction</NuxtLink>.
        </p>
      </section>
    </div>
    <template v-if="data" #foot>
      Computed from stored records at
      <time :datetime="data.computed_at">{{ at(data.computed_at) }}</time
      >. The same figures, with every timestamp and source URL, are at
      <NuxtLink to="/api/reliability" external :class="`${link} font-mono`"
        >/api/reliability</NuxtLink
      >
      and the MCP tool <code :class="code">get_reliability</code>.
    </template>
  </TerminalPanel>
</template>
