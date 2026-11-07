<script setup lang="ts">
// One claim of a thesis: its number and text, where it stands and since when,
// the reason the status rule gave, the kill condition, and the evidence.

import type { ClaimView } from '../../../shared/utils/thesis-types'

const stamps = useStamps()

defineProps<{ claim: ClaimView }>()
</script>

<template>
  <TerminalCard :id="`claim-${claim.n}`" :level="2">
    <template #title>
      <span class="text-base"
        ><span class="text-muted">{{ claim.n }}.</span> {{ claim.text }}</span
      >
    </template>
    <template #meta>
      <ThesisStatusBadge :status="claim.status" />
      <span v-if="claim.status_since">
        since
        <time :datetime="claim.status_since">{{ stamps.absolute(claim.status_since) }}</time>
      </span>
    </template>

    <p class="text-sm text-default">{{ claim.reason }}</p>

    <TerminalFacts
      :items="[
        { key: 'kill', label: 'Kill condition', value: claim.kill_condition },
        { key: 'signal', label: 'Evidence', value: claim.signal_label },
      ]"
      :cols="2"
    />

    <ThesisClaimMeasured v-if="claim.signal_kind === 'measured'" :claim="claim" />
    <ThesisClaimJudged v-else :claim="claim" />
  </TerminalCard>
</template>
