<script setup lang="ts">
// The facts that frame a thesis, shared by its index card and its page.

import { POSITION_LABEL } from '#shared/utils/thesis-format'
import type { ThesisView } from '#shared/utils/thesis-types'

defineProps<{ thesis: ThesisView }>()
</script>

<template>
  <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
    <div class="space-y-0.5">
      <dt class="text-toned">Stance</dt>
      <dd class="flex items-center gap-1.5 text-highlighted">
        <UIcon
          :name="thesis.stance === 'bullish' ? 'i-lucide-trending-up' : 'i-lucide-trending-down'"
          class="size-4"
          aria-hidden="true"
        />
        {{ thesis.stance === 'bullish' ? 'Bullish' : 'Bearish' }}
      </dd>
    </div>
    <div class="space-y-0.5">
      <dt class="text-toned">Position</dt>
      <dd class="text-highlighted">{{ POSITION_LABEL[thesis.position] }}</dd>
    </div>
    <div class="space-y-0.5">
      <dt class="text-toned">Opened</dt>
      <dd class="text-highlighted">
        <time :datetime="thesis.opened">{{ thesis.opened }}</time>
      </dd>
    </div>
    <div class="col-span-full space-y-0.5">
      <dt class="text-toned">Horizon</dt>
      <dd class="text-highlighted">{{ thesis.horizon }}</dd>
    </div>
  </dl>
</template>
