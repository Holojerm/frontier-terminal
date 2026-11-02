<script setup lang="ts">
// The provenance footer (DESIGN.md › Terminal primitives): one citation per
// source, then the caveats as controls that can actually be read, then
// anything the axis adds (a license line). One layout everywhere, so a reader
// learns once where a number's source is.

import type { CaveatRef, Citation } from '~/types/terminal-ui'

withDefaults(defineProps<{ sources?: Citation[]; caveats?: CaveatRef[] }>(), {
  sources: () => [],
  caveats: () => [],
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-toned">
    <TerminalProvenanceTag
      v-for="s in sources"
      :key="s.source_id ?? s.source_url"
      :label="s.label"
      :source-url="s.source_url"
      :fetched-at="s.fetched_at"
    />
    <TerminalCaveatMark
      v-for="c in caveats"
      :key="c.text"
      :label="c.label"
      :name="c.name"
      :text="c.text"
    />
    <slot />
  </div>
</template>
