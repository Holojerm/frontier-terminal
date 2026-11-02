<script setup lang="ts">
// Coverage reference, not a finding: which sources back this terminal, when
// each was last fetched, how its last poll ended, and what caveat the audit
// attached to it. An analyst reads it to decide whether a number can be
// trusted, not every visit — which is why it sits last.

import { LAB_DISPLAY } from '#shared/utils/terminal-labs'
import type { CoverageData, SourceCoverage } from '#shared/utils/terminal-types'
import type { TableColumn } from '~/types/terminal-ui'

defineProps<{ coverage: CoverageData }>()

const STATUS = {
  ok: { color: 'success', icon: 'i-lucide-check', label: 'ok' },
  unchanged: { color: 'neutral', icon: 'i-lucide-minus', label: 'unchanged' },
  baseline: { color: 'info', icon: 'i-lucide-flag', label: 'baseline' },
  failed: { color: 'error', icon: 'i-lucide-x', label: 'failed' },
  // Not attempted: the source needs a secret this deploy does not have.
  skipped: { color: 'warning', icon: 'i-lucide-key-round', label: 'not configured' },
  // Attempted, and there is nothing at the other end: a derived url that 404s.
  // Its own row rather than a failure, because for a priced SKU with no model
  // page the absence IS the fact worth showing a reader.
  absent: { color: 'neutral', icon: 'i-lucide-file-question', label: 'no page' },
} as const

const PROVIDER: Record<string, string> = { ...LAB_DISPLAY, all: 'market-wide', other: 'other' }

const roleNote = (s: SourceCoverage) =>
  s.derived_from
    ? `derived from the ${s.derived_from} template: a stored key filled into an audited URL`
    : s.role === 'join'
      ? 'join table: enriches another source, no rows of its own'
      : s.role === 'cross-check'
        ? 'cross-check only — never a source of record'
        : null

const columns: TableColumn[] = [
  { key: 'label', label: 'Source' },
  { key: 'snapshot', label: 'Newest snapshot' },
  { key: 'run', label: 'Last poll', class: 'whitespace-nowrap' },
  { key: 'snapshot_count', label: 'Snapshots', numeric: true },
  { key: 'entity_count', label: 'Rows', numeric: true },
  { key: 'caveat', label: 'Caveat' },
]
</script>

<template>
  <div>
    <TerminalTable
      caption="Every registered source: newest snapshot, last poll status, snapshot count, rows, caveat"
      :columns="columns"
      :rows="coverage.sources"
      :row-key="(s) => s.source_id"
      sticky
      align="top"
    >
      <template #cell-label="{ row: s }">
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
      </template>
      <template #cell-snapshot="{ row: s }">
        <TerminalProvenanceTag
          v-if="s.newest_snapshot"
          stamp
          :source-url="s.newest_snapshot.source_url"
          :fetched-at="s.newest_snapshot.fetched_at"
        />
        <TerminalGap v-else inline title="Never fetched" />
      </template>
      <template #cell-run="{ row: s }">
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
      </template>
      <template #cell-caveat="{ row: s }">
        <TerminalCaveatMark v-if="s.caveat" :name="`Caveat for ${s.label}`" :text="s.caveat" />
        <span v-else class="text-xs text-muted">—</span>
      </template>
    </TerminalTable>

    <div v-if="coverage.cuts.length" class="space-y-2 border-t border-default p-3">
      <h3 class="text-sm text-highlighted">Excluded sources</h3>
      <ul class="space-y-1 text-sm">
        <li v-for="cut in coverage.cuts" :key="cut.id" class="flex flex-wrap items-center gap-x-2">
          <span class="font-mono text-default">{{ cut.id }}</span>
          <span class="text-muted">{{ cut.verdict }}</span>
          <TerminalCaveatMark :name="`Why ${cut.id} is not tracked`" :text="cut.reason" />
        </li>
      </ul>
    </div>
  </div>
</template>
