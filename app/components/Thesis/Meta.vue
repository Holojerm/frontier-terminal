<script setup lang="ts">
// The facts that frame a thesis, shared by its index card and its page.

import { POSITION_LABEL } from '#shared/utils/thesis-format'
import type { ThesisView } from '#shared/utils/thesis-types'
import type { Fact } from '~/types/terminal-ui'

const props = defineProps<{ thesis: ThesisView }>()

const items = computed<Fact[]>(() => [
  {
    key: 'stance',
    label: 'Stance',
    value: props.thesis.stance === 'bullish' ? 'Bullish' : 'Bearish',
  },
  { key: 'position', label: 'Position', value: POSITION_LABEL[props.thesis.position] },
  { key: 'opened', label: 'Opened', value: props.thesis.opened },
  { key: 'horizon', label: 'Horizon', value: props.thesis.horizon, wide: true },
])
</script>

<template>
  <TerminalFacts :items="items">
    <template #stance>
      <span class="inline-flex items-center gap-1">
        <UIcon
          :name="thesis.stance === 'bullish' ? 'i-lucide-trending-up' : 'i-lucide-trending-down'"
          class="size-4"
          aria-hidden="true"
        />
        {{ items[0]!.value }}
      </span>
    </template>
    <template #opened>
      <time :datetime="thesis.opened">{{ thesis.opened }}</time>
    </template>
  </TerminalFacts>
</template>
