<script setup lang="ts">
// How far each lab's price history reaches: the Internet Archive backfill
// (captures read and skipped, and the stretches with no readable capture),
// then the first fetch of the lab's live pricing page. A lab with no
// archived history says why instead of showing an empty span.

import { labName } from '../../../shared/utils/terminal-labs'
import type { PriceReach } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

defineProps<{ reach: PriceReach[] }>()

const COLUMNS: TableColumn[] = [
  { key: 'provider', label: 'Lab' },
  { key: 'from', label: 'History from', class: 'whitespace-nowrap' },
  { key: 'archived', label: 'Internet Archive', hint: 'copies read · skipped' },
  { key: 'live', label: 'We check it since', class: 'whitespace-nowrap' },
  { key: 'gaps', label: 'Gaps before that', class: 'text-muted' },
]

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')
const from = (r: PriceReach) => r.archived_from ?? r.live_from
</script>

<template>
  <TerminalTable
    caption="How far back each lab’s price history reaches"
    :columns="COLUMNS"
    :rows="reach"
    :row-key="(r) => r.provider"
    align="top"
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
          <span class="font-mono">{{ g.from }} – {{ g.until }}</span
          >: {{ g.reason }}
        </li>
      </ul>
      <span v-else>—</span>
    </template>
  </TerminalTable>
</template>
