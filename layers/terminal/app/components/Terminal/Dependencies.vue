<script setup lang="ts">
// The dependency graph on /dependencies: companies as circles sized by a
// figure from their own filing, and each figure one company's filing puts on
// another as a line. The drawing is the overview. The tables under it carry
// every figure with its period and filing, so nothing is only in the picture.

import { count } from '../../../shared/utils/terminal-format'
import {
  figurePeriod,
  layoutDependencies,
  type DependenciesData,
  type DependencyEdge,
  type DependencyFigure,
  type DependencyMeasure,
} from '../../../shared/utils/terminal-dependencies'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ graph: DependenciesData }>()

const figures = useFigures()
const uid = useId()
const width = useChartWidth('box')

const MEASURES: { id: DependencyMeasure; label: string }[] = [
  { id: 'contracts', label: 'Contracts on the books' },
  { id: 'capex', label: 'Capex, newest quarter' },
]
const measure = ref<DependencyMeasure>('contracts')
/** The circle under the pointer: its lines stay, the rest fade. */
const active = ref<string | null>(null)

const fmt = (f: DependencyFigure) => {
  const text =
    f.unit === 'USD'
      ? figures.usd(f.value)
      : f.unit === 'pure'
        ? `${Math.round(f.value * 1000) / 10}%`
        : `${count(f.value)}${f.unit === 'shares' ? ' shares' : ''}`
  return f.approximate ? `about ${text}` : text
}

const nameOf = (id: string) => props.graph.nodes.find((n) => n.id === id)?.name ?? id
const lineName = (e: DependencyEdge) =>
  `${nameOf(e.from)} ${e.kind === 'buys' ? 'buys from' : 'funds'} ${nameOf(e.to)}`

const layout = computed(() => layoutDependencies(props.graph, measure.value, width.value))
/** Under this width a line's label is its figure alone. */
const compact = computed(() => width.value < 560)

const nodeViews = computed(() =>
  layout.value.nodes.map((p) => {
    const n = props.graph.nodes.find((x) => x.id === p.id)!
    const f = n[measure.value]
    return { ...p, kind: n.kind, name: n.name, value: f ? fmt(f) : 'not filed' }
  }),
)

const edgeViews = computed(() =>
  layout.value.edges.map((p) => {
    const e = props.graph.edges.find((x) => x.id === p.id)!
    const f = e.weight ?? e.facts[0]
    const label = f ? (compact.value ? fmt(f) : `${fmt(f)} ${f.short}`) : ''
    return {
      ...p,
      kind: e.kind,
      label,
      // Mono at 12px runs about 7.3px a character.
      plate: Math.round(label.length * 7.3 + 8),
      faded: active.value !== null && e.from !== active.value && e.to !== active.value,
    }
  }),
)

const summary = computed(
  () =>
    `Dependency graph: ${props.graph.nodes.length} companies and ${props.graph.edges.length} lines between them. Every figure is in the tables below.`,
)

const filingOf = (f: DependencyFigure) => ({
  url: f.filing_url,
  text: `${f.form} ${f.filed}`,
})

const lineColumns: TableColumn[] = [
  { key: 'line', label: 'Line' },
  { key: 'label', label: 'Figure' },
  { key: 'period', label: 'Period', class: 'whitespace-nowrap' },
  { key: 'value', label: 'As filed', numeric: true },
  { key: 'filing', label: 'Filing', class: 'whitespace-nowrap text-muted' },
]
const lineRows = computed(() =>
  props.graph.edges.flatMap((e) =>
    e.facts.map((f) => ({
      key: `${e.id}|${f.series_id}`,
      line: lineName(e),
      label: f.label,
      note: f.note,
      period: figurePeriod(f),
      derived: f.derived,
      value: fmt(f),
      sets: f === e.weight,
      filer: nameOf(e.reporter),
      filing: filingOf(f),
    })),
  ),
)

const sizeColumns: TableColumn[] = [
  { key: 'name', label: 'Company' },
  { key: 'contracts', label: 'Contracts on the books', numeric: true },
  { key: 'contractsFiling', label: 'Filing', class: 'whitespace-nowrap text-muted' },
  { key: 'capex', label: 'Capex, newest quarter', numeric: true },
  { key: 'capexFiling', label: 'Filing', class: 'whitespace-nowrap text-muted' },
]
const sizeRows = computed(() =>
  props.graph.nodes.map((n) => ({
    key: n.id,
    name: n.name,
    to: n.lab ? `/labs/${n.lab}` : null,
    contracts: n.contracts && {
      value: fmt(n.contracts),
      what: n.contracts.label,
      period: figurePeriod(n.contracts),
      note: n.contracts.note,
      filing: filingOf(n.contracts),
    },
    capex: n.capex && {
      value: fmt(n.capex),
      period: figurePeriod(n.capex),
      filing: filingOf(n.capex),
    },
  })),
)
</script>

<template>
  <TerminalPanel
    id="graph"
    title="Who buys from whom, and who funds whom"
    :note="graph.rule"
    :more="{ label: 'Every series behind these figures', to: '/exposure' }"
  >
    <TerminalGap
      v-if="!graph.edges.length"
      title="Nothing read yet"
      reason="We read these companies’ filings every 30 minutes. The lines show up after the next read."
    />
    <template v-else>
      <div role="group" aria-label="Circle size" class="flex flex-wrap items-center gap-2 text-xs">
        <span class="text-muted">Circle size</span>
        <UButton
          v-for="m in MEASURES"
          :key="m.id"
          size="xs"
          color="neutral"
          :variant="measure === m.id ? 'solid' : 'outline'"
          :aria-pressed="measure === m.id"
          @click="measure = m.id"
        >
          {{ m.label }}
        </UButton>
      </div>

      <div ref="box">
        <svg
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          :height="layout.height"
          preserveAspectRatio="xMinYMid meet"
          class="block w-full"
          role="img"
          :aria-label="summary"
        >
          <defs>
            <marker
              v-for="kind in ['buys', 'funds'] as const"
              :id="`${uid}-${kind}`"
              :key="kind"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              markerHeight="12"
              refX="0"
              refY="6"
              orient="auto"
              :class="kind === 'buys' ? 'text-primary' : 'text-highlighted'"
            >
              <path d="M0,0 L9,6 L0,12 z" fill="currentColor" />
            </marker>
          </defs>

          <g fill="none" stroke="currentColor">
            <path
              v-for="e in edgeViews"
              :key="e.id"
              :d="e.d"
              :stroke-width="e.width"
              :stroke-dasharray="e.kind === 'funds' ? '6 4' : undefined"
              :marker-end="`url(#${uid}-${e.kind})`"
              :class="[
                e.kind === 'buys' ? 'text-primary' : 'text-highlighted',
                e.faded ? 'opacity-20' : undefined,
              ]"
            />
          </g>

          <g
            v-for="n in nodeViews"
            :key="n.id"
            @pointerenter="active = n.id"
            @pointerleave="active = null"
          >
            <circle
              :cx="n.x"
              :cy="n.y"
              :r="n.r"
              stroke-width="1.5"
              :stroke-dasharray="n.hollow ? '3 3' : undefined"
              :class="
                n.hollow
                  ? 'fill-(--ui-bg) stroke-(--ui-text-dimmed)'
                  : n.kind === 'filer'
                    ? 'fill-(--ui-bg-accented) stroke-(--ui-text-muted)'
                    : 'fill-(--ui-primary)/20 stroke-(--ui-primary)'
              "
            />
            <g text-anchor="middle" font-size="12">
              <text :x="n.x" :y="n.y + n.r + 16" class="fill-(--ui-text-highlighted)">
                {{ n.name }}
              </text>
              <text
                :x="n.x"
                :y="n.y + n.r + 31"
                class="fill-(--ui-text-muted) font-mono tabular-nums"
              >
                {{ n.value }}
              </text>
            </g>
          </g>

          <!-- Over the lines, each on a plate of the page color so a crossing never cuts a figure. -->
          <g
            v-for="e in edgeViews"
            :key="e.id"
            :class="e.faded ? 'opacity-20' : undefined"
            text-anchor="middle"
            font-size="12"
          >
            <rect
              :x="e.lx - e.plate / 2"
              :y="e.ly - 9"
              :width="e.plate"
              height="18"
              rx="2"
              class="fill-(--ui-bg)"
            />
            <text
              :x="e.lx"
              :y="e.ly + 4"
              class="fill-(--ui-text-highlighted) font-mono tabular-nums"
            >
              {{ e.label }}
            </text>
          </g>
        </svg>
      </div>

      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-toned">
        <li class="inline-flex items-center gap-1.5">
          <svg width="20" height="6" viewBox="0 0 20 6" class="text-primary" aria-hidden="true">
            <line x1="0" y1="3" x2="20" y2="3" stroke="currentColor" stroke-width="2" />
          </svg>
          Buys from. The arrow points at the supplier.
        </li>
        <li class="inline-flex items-center gap-1.5">
          <svg width="20" height="6" viewBox="0 0 20 6" class="text-highlighted" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="20"
              y2="3"
              stroke="currentColor"
              stroke-width="2"
              stroke-dasharray="6 4"
            />
          </svg>
          Funds. The arrow points at the lab.
        </li>
        <li class="inline-flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <circle
              cx="6"
              cy="6"
              r="5"
              stroke-dasharray="3 3"
              class="fill-(--ui-bg) stroke-(--ui-text-dimmed)"
            />
          </svg>
          No filed figure for this size.
        </li>
      </ul>
      <p class="text-xs text-muted">
        A circle’s area follows the figure under its name. For a cloud company the contracts are its
        backlog, what customers have signed to pay it. For a lab they are its obligations, what it
        has signed to pay. A line’s width follows the figure printed on it. Lines carry different
        kinds of figure, so compare widths only between lines with the same words.
      </p>
    </template>
  </TerminalPanel>

  <TerminalPanel
    v-if="graph.edges.length"
    id="lines"
    title="Every line"
    note="Each figure a company’s filing puts on the other end of a line. The first figure of a line sets its width."
    flush
  >
    <TerminalTable
      caption="Every figure on every line, with its filing"
      :columns="lineColumns"
      :rows="lineRows"
      :row-key="(r) => r.key"
    >
      <template #cell-label="{ row: r }">
        {{ r.label
        }}<TerminalCaveatMark
          v-if="r.note"
          :name="`Note: ${r.label}`"
          :text="r.note"
          class="ml-1 align-middle"
        /><span v-if="r.sets" class="text-muted"> · sets the width</span>
      </template>
      <template #cell-period="{ row: r }">
        {{ r.period }}<span v-if="r.derived" class="text-muted"> · derived</span>
      </template>
      <template #cell-filing="{ row: r }">
        <a
          :href="r.filing.url"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ r.filer }} {{ r.filing.text }}</a
        >
      </template>
    </TerminalTable>
  </TerminalPanel>

  <TerminalPanel
    id="sizes"
    title="Circle sizes"
    note="The figure from each company’s own filing. A cloud company’s contracts are its backlog. A lab’s are its obligations."
    flush
  >
    <TerminalTable
      caption="Each company’s filed contracts and capex, with the filing"
      :columns="sizeColumns"
      :rows="sizeRows"
      :row-key="(r) => r.key"
    >
      <template #cell-name="{ row: r }">
        <NuxtLink v-if="r.to" :to="r.to" class="underline underline-offset-2">{{
          r.name
        }}</NuxtLink>
        <template v-else>{{ r.name }}</template>
      </template>
      <template #cell-contracts="{ row: r }">
        <template v-if="r.contracts">
          {{ r.contracts.value }}
          <span class="block font-sans text-xs text-muted">
            {{ r.contracts.what }}{{ r.contracts.period ? `, ${r.contracts.period}` : ''
            }}<TerminalCaveatMark
              v-if="r.contracts.note"
              :name="`Note: ${r.name} contracts`"
              :text="r.contracts.note"
              class="ml-1 align-middle"
            />
          </span>
        </template>
        <TerminalGap v-else inline title="Not filed" />
      </template>
      <template #cell-contractsFiling="{ row: r }">
        <a
          v-if="r.contracts"
          :href="r.contracts.filing.url"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ r.contracts.filing.text }}</a
        >
      </template>
      <template #cell-capex="{ row: r }">
        <template v-if="r.capex">
          {{ r.capex.value }}
          <span class="block font-sans text-xs text-muted">{{ r.capex.period }}</span>
        </template>
        <TerminalGap v-else inline title="Not filed" />
      </template>
      <template #cell-capexFiling="{ row: r }">
        <a
          v-if="r.capex"
          :href="r.capex.filing.url"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ r.capex.filing.text }}</a
        >
      </template>
    </TerminalTable>
  </TerminalPanel>

  <slot name="suppliers" />

  <TerminalPanel
    id="not-drawn"
    title="What isn’t drawn"
    note="A line needs a filing that names the other company. These are the lines and sizes you might look for that no filing we read gives."
  >
    <TerminalGap v-for="g in graph.gaps" :key="g.id" :title="g.title" :reason="g.reason" />
    <p v-if="graph.unplaced.length" class="text-xs text-muted">
      {{ graph.unplaced.length }} more
      {{ graph.unplaced.length === 1 ? 'figure is' : 'figures are' }} tagged on a lab and not placed
      on a line yet: {{ graph.unplaced.map((u) => u.label).join(', ') }}.
      <NuxtLink to="/exposure" class="underline underline-offset-2">See them on Exposure</NuxtLink>.
    </p>
  </TerminalPanel>
</template>
