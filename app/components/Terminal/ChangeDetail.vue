<script setup lang="ts">
// One cited change row, read in full: what the entity was and what it is
// now, field by field, with the fields that moved marked. An alert is a claim
// about these rows and may cite nothing else, so the permalink shows the
// whole record rather than the diff alone — a reader checking the claim
// needs the fields the headline did not mention as much as the ones it did.

import type { ChangeDetailView } from '#shared/utils/terminal-types'

defineProps<{ change: ChangeDetailView }>()

const EMPTY = '∅'
</script>

<template>
  <article :id="change.id" class="space-y-3 rounded border border-default bg-elevated p-4">
    <header class="flex flex-wrap items-center gap-2">
      <UBadge
        :color="CHANGE_BADGE[change.change_type].color"
        :icon="CHANGE_BADGE[change.change_type].icon"
        variant="subtle"
        size="sm"
      >
        {{ change.change_type }} {{ change.entity_type }}
      </UBadge>
      <span class="text-sm text-default">{{ change.summary }}</span>
    </header>

    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs">
        <caption class="sr-only">
          Fields of the record before and after the change
        </caption>
        <thead>
          <tr class="border-b border-default text-toned">
            <th scope="col" class="py-1 pr-3 font-medium">field</th>
            <th scope="col" class="py-1 pr-3 font-medium">before</th>
            <th scope="col" class="py-1 font-medium">after</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in change.fields"
            :key="f.field"
            class="border-b border-default last:border-0"
            :class="f.before !== f.after ? 'text-highlighted' : 'text-toned'"
          >
            <th scope="row" class="py-1 pr-3 align-top font-mono font-normal">
              {{ f.field }}
              <UIcon
                v-if="f.before !== f.after"
                name="i-lucide-arrow-right"
                class="ml-1 inline size-3 align-middle"
                aria-label="changed"
              />
            </th>
            <td class="py-1 pr-3 align-top font-mono break-words">{{ f.before ?? EMPTY }}</td>
            <td class="py-1 align-top font-mono break-words">{{ f.after ?? EMPTY }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="flex flex-wrap items-baseline gap-x-3 text-xs text-toned">
      <span class="font-mono break-all">{{ change.entity_key }}</span>
      <span>
        detected <time :datetime="change.detected_at">{{ change.detected_at }}</time>
      </span>
      <TerminalProvenanceTag :source-url="change.source_url" :fetched-at="change.fetched_at" />
    </footer>
  </article>
</template>
