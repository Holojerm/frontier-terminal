<script setup lang="ts">
// Like-for-like: one row per provider, one column per question an analyst
// actually asks ("what does their flagship cost?"). The class mapping is
// editorial and labelled as such; every cell carries the vendor sentence
// behind it, and a cell with nothing to show explains itself rather than
// printing a dash.
//
// It runs with the page (`flow`): nine labs at two lines each were taller
// than a 70svh box, which hid the last four. Each cell is one line, and the
// panel's foot lists every pricing page the cells cite, with its age.

import { exactStamp, hostOf } from '#layers/core/shared/utils/terminal-format'
import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'
import type { LabId } from '#layers/core/shared/types/common'
import type { MatrixCell, PriceMatrix } from '../../../shared/types/prices'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const watchlist = useWatchlist()
const stamps = useStamps()

const props = defineProps<{
  matrix: PriceMatrix
  /** Which rows to draw; every provider by default. A lab page draws its own alone. */
  providers?: LabId[]
}>()

const rows = computed(() =>
  watchlist
    .first(
      props.providers
        ? props.matrix.providers.filter((p) => props.providers!.includes(p))
        : props.matrix.providers,
      (p) => p,
    )
    .map((p) => ({
      provider: p,
      display: LAB_DISPLAY[p] ?? p,
      cells: Object.fromEntries(
        props.matrix.classes.map((k) => [
          k.id,
          props.matrix.cells.find((c) => c.provider === p && c.class === k.id),
        ]),
      ) as Record<string, MatrixCell | undefined>,
    })),
)

/**
 * Every host the drawn cells cite, once, at its latest read: each cell links
 * to its own pricing page by the model name, and this line shows the host
 * and the age a one-line cell has no room for. A host with two pages (a
 * pricing page and a models page) lists both URLs in its tooltip.
 */
const sources = computed(() => {
  const byHost = new Map<string, { url: string; urls: Set<string>; at: string; checked: boolean }>()
  for (const r of rows.value)
    for (const cell of Object.values(r.cells)) {
      const row = cell?.row
      if (!row) continue
      const host = hostOf(row.source_url)
      const at = row.checked_at ?? row.fetched_at
      const seen = byHost.get(host)
      if (!seen)
        byHost.set(host, {
          url: row.source_url,
          urls: new Set([row.source_url]),
          at,
          checked: !!row.checked_at,
        })
      else {
        seen.urls.add(row.source_url)
        if (at > seen.at)
          Object.assign(seen, { url: row.source_url, at, checked: !!row.checked_at })
      }
    }
  return [...byHost].map(([host, s]) => ({
    host,
    url: s.url,
    at: s.at,
    checked: s.checked,
    title: `${[...s.urls].join('\n')}\n${s.checked ? 'checked' : 'fetched'} ${exactStamp(s.at)}`,
  }))
})

const columns = computed<TableColumn[]>(() => [
  { key: 'display', label: 'Lab' },
  ...props.matrix.classes.map((k) => ({ key: k.id, label: k.label, hint: k.question })),
])
</script>

<template>
  <TerminalTable
    caption="Like-for-like API pricing in dollars per million tokens, by lab and class"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.provider"
    flow
    stack
  >
    <template v-for="k in matrix.classes" :key="k.id" #[`cell-${k.id}`]="{ row }">
      <TerminalPriceCell
        v-if="row.cells[k.id]"
        :cell="row.cells[k.id]!"
        :label="k.label"
        :lab="row.display"
      />
    </template>
  </TerminalTable>
  <p
    v-if="sources.length"
    class="flex flex-wrap gap-x-4 border-t border-default px-3 py-1 text-xs text-toned"
  >
    <span v-for="src in sources" :key="src.host" class="whitespace-nowrap">
      <a
        :href="src.url"
        target="_blank"
        rel="noopener noreferrer"
        :title="src.title"
        class="inline-block leading-6 underline underline-offset-2 hover:text-default"
        >{{ src.host }}</a
      >
      <time :datetime="src.at" :title="exactStamp(src.at)" class="ml-1"
        >{{ src.checked ? 'checked ' : '' }}{{ stamps.relative(src.at) }}</time
      >
    </span>
  </p>
</template>
