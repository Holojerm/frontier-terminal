<script setup lang="ts">
// A judged claim: every verdict the rule reads, newest first. The judge picks
// the verdict and writes the rationale; every number in the facts was
// computed by the Worker, and the record it was computed from is linked.
//
// Verdicts that count against the claim (or wait on a ruling) are cards. The
// rest are one line each behind a toggle: as cards of the same size, one
// material event was lost among ten that changed nothing.

import type { ClaimView } from '../../../shared/utils/thesis-types'

const stamps = useStamps()

const props = defineProps<{ claim: ClaimView }>()

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

const anchor = (v: VerdictView) => `verdict-${v.change_id}-${v.subject}`
const counts = (v: VerdictView) => THREATENS.has(v.verdict) || ruling(v) !== null
const weighed = computed(() => props.claim.verdicts.filter(counts))
const rest = computed(() => props.claim.verdicts.filter((v) => !counts(v)))

const REST_COLUMNS: TableColumn[] = [
  { key: 'company', label: 'Company', class: 'whitespace-nowrap' },
  { key: 'verdict', label: 'Verdict', class: 'whitespace-nowrap text-muted', stack: 'inline' },
  { key: 'detected', label: 'Detected', class: 'whitespace-nowrap text-muted', stack: 'inline' },
  // Inline on a phone: the rationale is the row's body, and a "Why" label
  // column left it a third of the width and 5,000px of page.
  { key: 'rationale', label: 'Why', stack: 'inline' },
]
</script>

<template>
  <div class="space-y-3">
    <h3 class="text-sm text-highlighted">Verdicts, newest first</h3>

    <TerminalGap
      v-if="claim.verdicts.length === 0"
      title="No verdicts yet."
      reason="No event for this claim has been rated yet. The claim holds until one is."
    />

    <template v-else>
      <p v-if="weighed.length === 0" class="text-sm text-muted">
        None of the {{ rest.length }} rated events counts against the claim.
      </p>

      <div v-else class="grid items-start gap-3 lg:grid-cols-2">
        <TerminalCard
          v-for="v in weighed"
          :id="anchor(v)"
          :key="anchor(v)"
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
              Detected <time :datetime="v.detected_at">{{ stamps.absolute(v.detected_at) }}</time>,
              rated <time :datetime="v.judged_at">{{ stamps.absolute(v.judged_at) }}</time>
            </span>
          </template>
        </TerminalCard>
      </div>

      <TerminalExpand
        v-if="rest.length"
        :show="`Show the ${rest.length} that don’t count against it`"
        hide="Hide them"
      >
        <TerminalTable
          :caption="`${claim.signal_label}: rated events that don’t count against the claim, newest first`"
          :columns="REST_COLUMNS"
          :rows="rest"
          :row-key="anchor"
          :row-id="anchor"
          align="top"
          nested
          stack
        >
          <template #cell-company="{ row: v }">{{ companyName(v.provider) }}</template>
          <template #cell-detected="{ row: v }">
            <time :datetime="v.detected_at" :title="stamps.absolute(v.detected_at)">{{
              stamps.day(v.detected_at)
            }}</time>
          </template>
          <template #cell-rationale="{ row: v }">
            <span class="text-xs text-default">{{ v.rationale }}</span>
            <TerminalSources :sources="[v]" class="mt-1" />
          </template>
        </TerminalTable>
      </TerminalExpand>
    </template>
  </div>
</template>
