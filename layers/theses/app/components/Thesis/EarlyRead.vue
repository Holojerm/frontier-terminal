<script setup lang="ts">
// What the press says about revenue the company hasn't filed yet, beside a
// claim that reads filed revenue. Unconfirmed, and it says so before any
// number: nothing here enters a reading or sets the claim's status.

import { earlyReadLines } from '../../../shared/utils/thesis-format'
import type { PressEarlyRead } from '../../../shared/utils/thesis-types'

const props = defineProps<{ read: PressEarlyRead }>()

const lines = computed(() => earlyReadLines(props.read))
</script>

<template>
  <section class="space-y-2 border-t border-default pt-3">
    <h3 class="text-sm text-highlighted">Press early read, unconfirmed</h3>
    <p class="text-sm text-muted">
      These are press reports, not filings. They never set this claim’s status. Only a filing does.
    </p>
    <ul v-if="read.periods.length" class="space-y-2 text-sm text-default">
      <li v-for="(p, i) in read.periods" :key="p.start + p.end">
        {{ lines.periods[i] }}
        <TerminalProvenanceTag
          :source-url="p.latest.source_url"
          :fetched-at="p.latest.fetched_at"
          compact
        />
      </li>
    </ul>
    <p v-else class="text-sm text-default">No press report names a period that isn’t filed yet.</p>
    <p v-if="lines.unplaced" class="text-sm text-default">{{ lines.unplaced }}</p>
    <p class="text-sm text-default">
      {{ lines.record }}
      <NuxtLink to="/ground-truth" class="underline">How we score press reports</NuxtLink>
    </p>
  </section>
</template>
