<script setup lang="ts">
// The data dictionary on /data: one collapsible section per export table,
// each column with its type, nullability, role, unit and meaning. Closed by
// default and kept in the document, so find-in-page and crawlers reach every
// entry. `#dictionary-<table>` (the link on each download row) opens its
// section; `open` is the list of open tables, so the page can open one too.

import type { DataDictionary, DictionaryColumn } from '../../../shared/utils/terminal-types'
import type { Fact, TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ dictionary: DataDictionary }>()
const open = defineModel<string[]>('open', { default: () => [] })

const PREFIX = 'dictionary-'

const TYPE_LABEL: Record<DictionaryColumn['type'], string> = {
  text: 'text',
  integer: 'integer',
  number: 'number',
  timestamp: 'ISO-8601 timestamp',
  date: 'date',
  json: 'JSON',
  boolean: 'boolean',
}

const MODE_LABEL = { cut: 'cut at T', rebuilt: 'rebuilt at T', refused: 'answers 400' } as const

const HISTORY_LABEL = { windowed: 'last 90 days', whole: 'whole table' } as const

const types = computed<Fact[]>(() =>
  Object.entries(props.dictionary.types).map(([type, meaning]) => ({
    key: type,
    label: TYPE_LABEL[type as DictionaryColumn['type']],
    value: meaning,
  })),
)

const COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Column' },
  { key: 'meaning', label: 'Meaning' },
]

/** The type and flags under a column's name: "number · nullable · key". */
const flags = (c: DictionaryColumn) =>
  [
    TYPE_LABEL[c.type],
    c.nullable ? 'nullable' : undefined,
    c.role ?? undefined,
    c.as_of_only ? 'as_of only' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

const isOpen = (name: string) => open.value.includes(name)
const setOpen = (name: string, value: boolean) => {
  open.value = value ? [...new Set([...open.value, name])] : open.value.filter((n) => n !== name)
}

const route = useRoute()

/** Open the section the hash names, then bring it into view. */
async function followHash() {
  const id = decodeURIComponent(route.hash.slice(1))
  if (!id.startsWith(PREFIX)) return
  const name = id.slice(PREFIX.length)
  if (!props.dictionary.tables.some((t) => t.name === name)) return
  setOpen(name, true)
  await nextTick()
  document.getElementById(id)?.scrollIntoView()
}

onMounted(followHash)
watch(() => route.hash, followHash)
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="max-w-3xl text-sm text-default">{{ dictionary.provenance }}</p>
    <p class="max-w-3xl text-sm text-default">{{ dictionary.license }}</p>
    <TerminalFacts :items="types" :cols="3" />

    <ul class="flex flex-col border-t border-default">
      <li
        v-for="t in dictionary.tables"
        :id="`${PREFIX}${t.name}`"
        :key="t.name"
        class="scroll-mt-24 border-b border-default"
      >
        <UCollapsible
          :open="isOpen(t.name)"
          :unmount-on-hide="false"
          @update:open="(v: boolean) => setOpen(t.name, v)"
        >
          <UButton
            variant="ghost"
            color="neutral"
            block
            trailing-icon="i-lucide-chevron-down"
            class="group justify-start gap-x-3 rounded-none px-0 py-2 text-left"
            :ui="{
              trailingIcon: 'ms-auto transition-transform group-data-[state=open]:rotate-180',
            }"
          >
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="font-mono text-sm text-highlighted">{{ t.name }}</span>
              <span class="text-xs text-muted">{{ t.columns.length }} columns</span>
              <UBadge
                variant="subtle"
                color="neutral"
                size="sm"
                :label="`as_of: ${MODE_LABEL[t.as_of.mode]}`"
              />
              <UBadge
                variant="subtle"
                color="neutral"
                size="sm"
                :label="`download: ${HISTORY_LABEL[t.history.mode]}`"
              />
            </span>
          </UButton>
          <template #content>
            <div class="flex flex-col gap-3 pb-4">
              <dl class="grid max-w-3xl gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
                <dt class="text-xs text-muted">Key</dt>
                <dd class="font-mono text-default">{{ t.key.join(', ') }}</dd>
                <dt class="text-xs text-muted">as_of</dt>
                <dd class="text-default">{{ t.as_of.note }}</dd>
                <dt class="text-xs text-muted">Download</dt>
                <dd class="text-default">{{ t.history.note }}</dd>
              </dl>
              <TerminalTable
                :caption="`Columns of ${t.name}`"
                :columns="COLUMNS"
                :rows="t.columns"
                :row-key="(c) => c.name"
                :edge="false"
                align="top"
                flow
              >
                <template #cell-name="{ row: c }">
                  <span class="block font-mono">{{ c.name }}</span>
                  <span class="block text-xs text-muted">{{ flags(c) }}</span>
                </template>
                <template #cell-meaning="{ row: c }">
                  <span class="block max-w-2xl">{{ c.meaning }}</span>
                  <span v-if="c.unit" class="block text-xs text-muted">Unit: {{ c.unit }}</span>
                </template>
              </TerminalTable>
            </div>
          </template>
        </UCollapsible>
      </li>
    </ul>
  </div>
</template>
