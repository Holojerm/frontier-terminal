<script setup lang="ts">
// A judged claim: every verdict the rule reads, newest first. The judge picks
// the verdict and writes the rationale; every number in the facts was
// computed by the Worker, and the record it was computed from is linked.

import { companyName } from '../../../shared/utils/companies'
import { factRows } from '../../../shared/utils/thesis-format'
import type { ClaimView, VerdictView } from '../../../shared/utils/thesis-types'

const stamps = useStamps()

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
  <div class="space-y-3">
    <h3 class="text-sm text-highlighted">Verdicts, newest first</h3>

    <TerminalGap
      v-if="claim.verdicts.length === 0"
      title="No verdicts yet."
      reason="No event for this claim has been rated yet. The claim holds until one is."
    />

    <div v-else class="grid items-start gap-3 lg:grid-cols-2">
      <TerminalCard
        v-for="v in claim.verdicts"
        :id="`verdict-${v.change_id}-${v.subject}`"
        :key="`${v.change_id}-${v.subject}`"
        :level="4"
        :title="companyName(v.provider)"
        :sources="[v]"
      >
        <template #meta>
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
        </template>

        <p class="text-sm text-default">{{ v.rationale }}</p>

        <TerminalFacts
          v-if="factRows(v.facts, stamps.absolute).length"
          layout="list"
          :items="
            factRows(v.facts, stamps.absolute).map((row) => ({
              key: row.label,
              label: row.label,
              value: row.value,
              mono: true,
            }))
          "
        />

        <template #foot>
          <span>
            Detected <time :datetime="v.detected_at">{{ stamps.absolute(v.detected_at) }}</time
            >, rated <time :datetime="v.judged_at">{{ stamps.absolute(v.judged_at) }}</time>
          </span>
        </template>
      </TerminalCard>
    </div>
  </div>
</template>
