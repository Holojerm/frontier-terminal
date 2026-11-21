<script setup lang="ts">
// Implied load: Alphabet's stated tokens per minute, turned into the
// H100-equivalents that volume would keep busy at each benchmark model's
// speed, as a share of Epoch AI's range for Google's running fleet. Always
// a pair of bounds per model, with the sentence the volume came from and the
// footnote MLCommons requires beside a figure it has not verified.

import {
  compactCount,
  compactTokens,
  count,
  sharePct,
  splitInstants,
} from '#layers/core/shared/utils/terminal-format'
import type { Bounds, UtilizationData } from '../../../shared/utils/compute-views'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

type Implied = NonNullable<UtilizationData['implied']>

const props = defineProps<{
  implied: Implied
  shape: UtilizationData['demand_shape']
}>()

const pct = (n: number) => (n >= 10 ? `${count(Math.round(n * 100))}%` : sharePct(n))
const h100e = compactCount
const stamps = useStamps()
// OpenRouter's citation is its license's own wording: only the instant in it
// is read as a stamp, the rest prints as given.
const citation = computed(() => (props.shape?.citation ? splitInstants(props.shape.citation) : []))
const speed = (n: number) => count(Math.round(n))
const range = (b: Bounds, f: (n: number) => string) =>
  f(b.low) === f(b.high) ? f(b.low) : `${f(b.low)}–${f(b.high)}`

const columns: TableColumn[] = [
  { key: 'model', label: 'If every token ran like', class: 'font-mono' },
  { key: 'share', label: 'Share of fleet', numeric: true },
  { key: 'busy', label: 'H100e kept busy', numeric: true },
  { key: 'speed', label: 'Tokens/s per H100e', numeric: true, hint: 'slowest–fastest result' },
  { key: 'results', label: 'Results', numeric: true },
]

const rows = computed(() =>
  props.implied.models.map((m) => ({
    key: m.model,
    model: m.model,
    speed: range({ low: m.slowest.per_h100e, high: m.fastest.per_h100e }, speed),
    busy: range(m.h100e_busy, h100e),
    share: range(m.share, pct),
    over: m.share.low > 1,
    results: `${m.results} (${[...new Set([m.slowest.result_id, m.fastest.result_id])].join(', ')})`,
  })),
)

const historyColumns: TableColumn[] = [
  { key: 'quarter', label: 'Quarter' },
  { key: 'stated', label: 'Tokens per minute, as stated', numeric: true },
]
const history = computed(() =>
  props.implied.history.toReversed().map((h) => ({
    key: h.period_end,
    quarter: h.quarter,
    stated: `${h.qualifier ? `${h.qualifier} ` : ''}${compactTokens(h.per_minute)}`,
  })),
)

const fleet = computed(() => props.implied.fleet)
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-muted">
      Alphabet, {{ implied.tokens.quarter }}:
      <span class="font-mono text-highlighted">
        {{ implied.tokens.qualifier ? `${implied.tokens.qualifier} ` : ''
        }}{{ compactTokens(implied.tokens.per_minute) }}
      </span>
      tokens per minute through its own model APIs. Epoch AI’s estimate of Google’s running fleet at
      {{ stamps.date(fleet.date) }}:
      <span class="font-mono text-highlighted">
        {{ h100e(fleet.h100e.p5) }}–{{ h100e(fleet.h100e.p95) }}
      </span>
      H100-equivalents (5th to 95th percentile).
    </p>
    <blockquote class="border-l-2 border-default pl-3 text-sm text-toned">
      “{{ implied.tokens.sentence }}”
    </blockquote>

    <TerminalTable
      caption="H100-equivalents Alphabet’s stated token volume would keep busy at each benchmark model’s speed, as a share of Epoch AI’s range for Google’s running fleet"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.key"
      nested
    >
      <template #cell-share="{ row: r }">
        <span
          class="whitespace-nowrap font-mono"
          :class="r.over ? 'text-muted' : 'text-highlighted'"
        >
          {{ r.share }}
        </span>
      </template>
    </TerminalTable>

    <p class="text-xs text-muted">
      Bounds per benchmark model, not a utilization estimate. Above 100%, Google’s average token
      can’t be running at that model’s size.
      <template v-if="implied.unrated_results">
        {{ implied.unrated_results }} results left out: Epoch rates no H100-equivalent for their
        accelerator.
      </template>
    </p>

    <p v-if="shape" class="text-xs text-muted">
      Demand shape: OpenRouter’s average day was
      <span class="font-mono text-highlighted">{{ sharePct(shape.ratio) }}</span>
      of its busiest day ({{ stamps.date(shape.peak_date) }},
      {{ compactTokens(shape.peak_tokens) }} tokens) over {{ stamps.date(shape.window.from) }} →
      {{ stamps.date(shape.window.to) }}.
      <TerminalCaveatMark name="How to read the demand shape" :text="shape.caveat" />
    </p>

    <TerminalExpand
      show="Show each quarter’s stated volume"
      hide="Hide each quarter’s stated volume"
    >
      <TerminalTable
        caption="Tokens per minute through Alphabet’s first-party model APIs, as each earnings release states it"
        :columns="historyColumns"
        :rows="history"
        :row-key="(r) => r.key"
        nested
      />
    </TerminalExpand>

    <TerminalSources
      :sources="[
        implied.tokens.source,
        fleet.source,
        implied.benchmark.source,
        implied.chip_ratings,
      ]"
      :caveats="[{ text: implied.caveat, label: 'why it’s a range' }]"
    >
      <span>CC BY 4.0, Epoch AI</span>
    </TerminalSources>
    <p v-if="citation.length" class="text-xs text-toned">
      <template v-for="(part, i) in citation" :key="i"
        ><time v-if="'iso' in part" :datetime="part.iso" :title="part.iso">{{
          stamps.absolute(part.iso)
        }}</time
        ><template v-else>{{ part.text }}</template></template
      >
    </p>
    <p class="text-xs text-toned">{{ implied.benchmark.footnote }}</p>
  </div>
</template>
