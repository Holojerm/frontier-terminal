<script setup lang="ts">
// A judged claim: every verdict the rule reads, newest first. The judge picks
// the verdict and writes the rationale; every number in the facts was
// computed by the Worker, and the record it was computed from is linked.

import { companyName } from '#shared/utils/companies'
import { absoluteStamp } from '#shared/utils/terminal-format'
import { factRows } from '#shared/utils/thesis-format'
import type { ClaimView, VerdictView } from '#shared/utils/thesis-types'

defineProps<{ claim: ClaimView }>()

/** The verdicts that move a claim toward broken. */
const THREATENS = new Set(['competitive', 'material'])

function ruling(v: VerdictView) {
  if (v.confirmation === 'confirmed') {
    return { label: 'Confirmed', color: 'error', icon: 'i-lucide-gavel' } as const
  }
  if (v.confirmation === 'rejected') {
    return { label: 'Rejected', color: 'neutral', icon: 'i-lucide-gavel' } as const
  }
  if (v.verdict === 'material') {
    return { label: 'Awaiting confirmation', color: 'warning', icon: 'i-lucide-hourglass' } as const
  }
  return null
}
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-sm text-toned">Verdicts, newest first</h3>

    <TerminalEmptyState
      v-if="claim.verdicts.length === 0"
      title="No verdicts yet."
      body="The judge rates each candidate event this claim watches. Until one is rated, the claim holds by default."
    />

    <ul v-else class="space-y-3">
      <li
        v-for="v in claim.verdicts"
        :key="`${v.change_id}-${v.subject}`"
        class="space-y-3 rounded border border-default bg-elevated p-4"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-highlighted">{{ companyName(v.provider) }}</span>
          <UBadge
            :color="THREATENS.has(v.verdict) ? 'warning' : 'neutral'"
            variant="subtle"
            size="sm"
            icon="i-lucide-scale"
          >
            {{ v.verdict }}
          </UBadge>
          <UBadge
            v-if="ruling(v)"
            :color="ruling(v)!.color"
            variant="subtle"
            size="sm"
            :icon="ruling(v)!.icon"
          >
            {{ ruling(v)!.label }}
          </UBadge>
        </div>

        <p class="text-sm text-default">{{ v.rationale }}</p>

        <dl v-if="factRows(v.facts).length" class="space-y-0.5 text-sm">
          <div v-for="row in factRows(v.facts)" :key="row.label" class="flex flex-wrap gap-x-2">
            <dt class="text-toned">{{ row.label }}</dt>
            <dd class="font-mono text-default">{{ row.value }}</dd>
          </div>
        </dl>

        <p class="text-xs text-toned">
          Detected <time :datetime="v.detected_at">{{ absoluteStamp(v.detected_at) }}</time
          >, rated <time :datetime="v.judged_at">{{ absoluteStamp(v.judged_at) }}</time
          >. Source:
          <TerminalProvenanceTag :source-url="v.source_url" :fetched-at="v.fetched_at" />
        </p>
      </li>
    </ul>
  </div>
</template>
