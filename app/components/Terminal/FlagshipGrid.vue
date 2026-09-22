<script setup lang="ts">
// The flagship column of the like-for-like matrix, turned on its side: one
// cell per lab across the page instead of one row per lab down it. The
// front page asks one question of pricing — what does each lab's "start
// here" model cost — and four cells answer it in one line of height.

import { money } from '#shared/utils/terminal-format'
import { LAB_DISPLAY } from '#shared/utils/terminal-labs'
import type { MatrixCell, PriceMatrix } from '#shared/utils/terminal-types'

const props = defineProps<{ matrix: PriceMatrix }>()

const column = computed(() => props.matrix.classes.find((k) => k.id === 'flagship'))
const cells = computed(() =>
  props.matrix.providers
    .map((p) => props.matrix.cells.find((c) => c.provider === p && c.class === 'flagship'))
    .filter((c): c is MatrixCell => c !== undefined),
)
</script>

<template>
  <dl class="grid grid-cols-2 gap-4 md:grid-cols-4">
    <div
      v-for="c in cells"
      :key="c.provider"
      class="space-y-1 rounded border border-default bg-elevated p-3"
    >
      <dt class="text-sm text-highlighted">{{ LAB_DISPLAY[c.provider] }}</dt>
      <dd v-if="c.priced" class="space-y-1">
        <div class="flex items-center gap-1 font-mono text-xs text-default">
          <span class="truncate">{{ c.row!.model_slug }}</span>
          <TerminalCaveatMark
            v-if="c.basis"
            :name="`Why ${c.row!.model_slug} is the ${column?.label ?? 'flagship'}`"
            :text="basisText(c, column?.label ?? 'flagship')"
          />
        </div>
        <div class="font-mono">
          <span class="text-highlighted">{{ money(c.row!.input_per_mtok) }}</span>
          <span class="text-xs text-muted"> in </span>
          <span class="text-default">{{ money(c.row!.output_per_mtok) }}</span>
          <span class="text-xs text-muted"> out</span>
          <span v-if="cellDelta(c)" class="ml-2 text-xs text-muted">{{ cellDelta(c) }}</span>
        </div>
        <p v-if="c.basis_current === false" class="text-xs text-warning">Mapping under review</p>
        <TerminalProvenanceTag :source-url="c.row!.source_url" :fetched-at="c.row!.fetched_at" />
      </dd>
      <dd v-else class="space-y-1 text-muted">
        <div v-if="c.row" class="truncate font-mono text-xs">{{ c.row.model_slug }}</div>
        <div class="flex items-center gap-1 text-xs">
          <span>{{ c.row ? 'no published price' : 'not mapped' }}</span>
          <TerminalCaveatMark
            :name="`Why ${LAB_DISPLAY[c.provider]} has no flagship price`"
            :text="c.gap ?? ''"
          />
        </div>
        <TerminalProvenanceTag
          v-if="c.row"
          :source-url="c.row.source_url"
          :fetched-at="c.row.fetched_at"
        />
      </dd>
    </div>
  </dl>
</template>
