<script setup lang="ts">
// One claim of a thesis: its number and text, where it stands and since when,
// the reason the status rule gave, the kill condition, and the evidence.

import { absoluteStamp } from '#shared/utils/terminal-format'
import type { ClaimView } from '#shared/utils/thesis-types'

defineProps<{ claim: ClaimView }>()
</script>

<template>
  <article
    :id="`claim-${claim.n}`"
    :aria-labelledby="`claim-${claim.n}-heading`"
    class="space-y-4 rounded border border-default p-4 sm:p-6"
  >
    <header class="space-y-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ThesisStatusBadge :status="claim.status" />
        <span v-if="claim.status_since" class="text-sm text-muted">
          since
          <time :datetime="claim.status_since">{{ absoluteStamp(claim.status_since) }}</time>
        </span>
      </div>
      <h2 :id="`claim-${claim.n}-heading`" class="text-xl text-highlighted">
        <span class="text-toned">{{ claim.n }}.</span> {{ claim.text }}
      </h2>
      <p class="text-sm text-default">{{ claim.reason }}</p>
    </header>

    <dl class="grid gap-3 text-sm sm:grid-cols-2">
      <div class="space-y-0.5">
        <dt class="text-toned">Kill condition</dt>
        <dd class="text-default">{{ claim.kill_condition }}</dd>
      </div>
      <div class="space-y-0.5">
        <dt class="text-toned">Signal</dt>
        <dd class="text-default">{{ claim.signal_label }}</dd>
      </div>
    </dl>

    <ThesisClaimMeasured v-if="claim.signal_kind === 'measured'" :claim="claim" />
    <ThesisClaimJudged v-else :claim="claim" />
  </article>
</template>
