<script setup lang="ts">
// How far each lab's history reaches on one axis, prices or hiring: the
// Internet Archive backfill (captures read and skipped, and the stretches
// with no readable capture), then the first fetch of the lab's own live page
// or board. A lab with no archived history says why instead of showing an
// empty span.

import { labName } from '#layers/core/shared/utils/lab-names'
import type { ArchiveReach } from '../../../shared/types/common'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const watchlist = useWatchlist()

withDefaults(
  defineProps<{
    reach: ArchiveReach[]
    caption?: string
    /** Runs with the page: nine labs and their gap lists outgrow a 70svh box. */
    flow?: boolean
  }>(),
  { caption: 'How far back each lab’s price history reaches' },
)

const COLUMNS: TableColumn[] = [
  { key: 'provider', label: 'Lab' },
  { key: 'from', label: 'History from', class: 'whitespace-nowrap' },
  { key: 'archived', label: 'Internet Archive', hint: 'copies read · skipped' },
  { key: 'live', label: 'We check it since', class: 'whitespace-nowrap' },
  { key: 'gaps', label: 'Gaps before that', class: 'text-muted' },
]

const stamps = useStamps()
const day = (iso: string | null) => (iso ? stamps.date(iso) : '—')
const from = (r: ArchiveReach) => r.archived_from ?? r.live_from
</script>

<template>
  <TerminalTable
    :caption="caption"
    :columns="COLUMNS"
    :rows="watchlist.first(reach, (r) => r.provider)"
    :row-key="(r) => r.provider"
    align="top"
    :flow="flow"
    stack
  >
    <template #cell-provider="{ row: r }">{{ labName(r.provider) }}</template>
    <template #cell-from="{ row: r }">
      <time v-if="from(r)" class="font-mono" :datetime="from(r)!">{{ day(from(r)) }}</time>
      <span v-else class="text-muted">no history yet</span>
    </template>
    <template #cell-archived="{ row: r }">
      <template v-if="r.archived_parsed || r.archived_skipped">
        <span class="font-mono">{{ day(r.archived_from) }} – {{ day(r.archived_until) }}</span>
        <span class="text-muted">
          · {{ r.archived_parsed }} read · {{ r.archived_skipped }} skipped</span
        >
      </template>
      <span v-else class="text-muted">{{ r.not_covered ?? 'Not loaded yet.' }}</span>
    </template>
    <template #cell-live="{ row: r }">
      <time v-if="r.live_from" class="font-mono" :datetime="r.live_from">{{
        day(r.live_from)
      }}</time>
      <span v-else class="text-muted">—</span>
    </template>
    <template #cell-gaps="{ row: r }">
      <ul v-if="r.gaps.length" class="space-y-1">
        <li v-for="g in r.gaps" :key="g.from">
          <span class="font-mono">{{ stamps.date(g.from) }} – {{ stamps.date(g.until) }}</span>:
          {{ g.reason }}
        </li>
      </ul>
      <span v-else>—</span>
    </template>
  </TerminalTable>
</template>
