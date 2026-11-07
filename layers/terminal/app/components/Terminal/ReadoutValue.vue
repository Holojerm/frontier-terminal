<script setup lang="ts">
// One readout cell inline, for a table: the figure (linked to the lab page
// section that carries it in full), its delta, and a sub-line — or the
// stated gap. The figure's title names the source host and fetch instant, so
// it is one hover from where it came from; the lab page cites it in full.

import { hostOf } from '../../../shared/utils/terminal-format'
import type { ReadoutCell } from '../../utils/readout'

const stamps = useStamps()

const props = defineProps<{ cell: ReadoutCell }>()

const title = computed(() =>
  props.cell.source
    ? `${hostOf(props.cell.source.source_url)} · fetched ${stamps.absolute(props.cell.source.fetched_at)}`
    : undefined,
)
</script>

<template>
  <span v-if="cell.gap" class="block">
    <TerminalGap inline :title="cell.gap.title" :reason="cell.gap.reason" :name="cell.gap.name" />
  </span>
  <span v-else class="block whitespace-nowrap">
    <!-- The delta rides inside the link: a link beside plain text in the
         same line has to be distinguishable without color, and this one is
         not underlined until hover. -->
    <NuxtLink :to="cell.to" :title="title" class="group">
      <span class="text-highlighted group-hover:underline group-hover:underline-offset-2">{{
        cell.value
      }}</span>
      <span v-if="cell.delta" class="ml-1 text-xs text-muted">{{ cell.delta }}</span>
    </NuxtLink>
    <span v-if="cell.sub" class="block font-sans text-xs text-muted">{{ cell.sub }}</span>
  </span>
</template>
