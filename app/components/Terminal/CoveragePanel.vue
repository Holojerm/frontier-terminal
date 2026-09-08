<script setup lang="ts">
// Coverage reference, not a finding: which sources back this terminal, when
// each was last fetched, how its last poll ended, and what caveat the audit
// attached to it. An analyst reads it to decide whether a number can be
// trusted, not every visit — which is why it sits last.

import type { CoverageData, SourceCoverage } from '#shared/utils/terminal-types'

defineProps<{ coverage: CoverageData }>()

const STATUS = {
  ok: { color: 'success', icon: 'i-lucide-check', label: 'ok' },
  unchanged: { color: 'neutral', icon: 'i-lucide-minus', label: 'unchanged' },
  baseline: { color: 'info', icon: 'i-lucide-flag', label: 'baseline' },
  failed: { color: 'error', icon: 'i-lucide-x', label: 'failed' },
  // Not attempted: the source needs a secret this deploy does not have.
  skipped: { color: 'warning', icon: 'i-lucide-key-round', label: 'not configured' },
} as const

const PROVIDER: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  all: 'market-wide',
  other: 'other',
}

const roleNote = (s: SourceCoverage) =>
  s.role === 'join'
    ? 'join table — fetched to enrich another source, yields no rows of its own'
    : s.role === 'cross-check'
      ? 'cross-check only — never a source of record'
      : null
</script>

<template>
  <div class="space-y-4">
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <caption class="sr-only">
          Every registered source: newest snapshot, last poll status, snapshot count, rows, caveat
        </caption>
        <thead>
          <tr class="border-b border-default text-left">
            <th scope="col" class="py-2 pr-4 font-medium text-muted">Source</th>
            <th scope="col" class="py-2 pr-4 font-medium text-muted">Newest snapshot</th>
            <th scope="col" class="py-2 pr-4 font-medium text-muted">Last poll</th>
            <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Snapshots</th>
            <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Rows</th>
            <th scope="col" class="py-2 font-medium text-muted">Caveat</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in coverage.sources"
            :key="s.source_id"
            class="border-b border-default align-top"
          >
            <th scope="row" class="py-2 pr-4 text-left font-normal">
              <a
                :href="s.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-highlighted underline underline-offset-2"
                >{{ s.label }}</a
              >
              <span class="block text-xs text-muted">
                {{ PROVIDER[s.provider] ?? s.provider }} · {{ s.axis }}
                <template v-if="roleNote(s)"> · {{ roleNote(s) }}</template>
              </span>
            </th>
            <td class="py-2 pr-4">
              <TerminalProvenanceTag
                v-if="s.newest_snapshot"
                stamp
                :source-url="s.newest_snapshot.source_url"
                :fetched-at="s.newest_snapshot.fetched_at"
              />
              <span v-else class="text-xs text-muted">never fetched</span>
            </td>
            <td class="py-2 pr-4">
              <template v-if="s.last_run">
                <UBadge
                  :color="STATUS[s.last_run.status].color"
                  :icon="STATUS[s.last_run.status].icon"
                  variant="subtle"
                  size="sm"
                >
                  {{ STATUS[s.last_run.status].label }}
                </UBadge>
                <TerminalCaveatMark
                  v-if="s.last_run.detail"
                  :name="`Detail of the last ${s.label} poll`"
                  :text="s.last_run.detail"
                />
              </template>
              <span v-else class="text-xs text-muted">no run</span>
            </td>
            <td class="py-2 pr-4 text-right font-mono">{{ s.snapshot_count }}</td>
            <td class="py-2 pr-4 text-right font-mono">{{ s.entity_count }}</td>
            <td class="py-2">
              <TerminalCaveatMark
                v-if="s.caveat"
                :name="`Caveat for ${s.label}`"
                :text="s.caveat"
              />
              <span v-else class="text-xs text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="coverage.cuts.length" class="space-y-2">
      <h3 class="text-lg text-highlighted">Not tracked, on purpose</h3>
      <ul class="space-y-1 text-sm">
        <li v-for="cut in coverage.cuts" :key="cut.id">
          <span class="font-mono text-default">{{ cut.id }}</span>
          <span class="text-muted"> — {{ cut.verdict }}. {{ cut.reason }}</span>
        </li>
      </ul>
    </div>

    <p class="text-xs text-muted">
      Every label links to the exact URL fetched; the age beside it carries the exact UTC timestamp.
      The info control on a row opens the audit’s caveat for that source, in its own words.
    </p>
  </div>
</template>
