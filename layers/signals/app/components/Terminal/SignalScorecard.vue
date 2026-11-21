<script setup lang="ts">
// The scorecard, in reading order: the counts, then every series with a
// held-out result (those that clear the bar first), then the series still
// waiting on history, closed by default. The waiting rows stay in the document,
// so an alert's link to one (/signals#<series id>) opens the group and lands on it.

import type { SignalsData } from '../../../shared/utils/signals'

const props = defineProps<{ data: SignalsData }>()

const card = computed(() => signalScorecard(props.data))

const figures = computed(() => {
  const c = card.value.counts
  return [
    { label: 'Tested', value: grouped(c.tested), sub: `of ${grouped(c.total)} series` },
    { label: 'Clear the bar held out', value: grouped(c.clears) },
    { label: 'Tested, don’t clear the bar', value: grouped(c.fails) },
    {
      label: 'Waiting on history',
      value: grouped(c.waiting),
      sub: c.unread ? `${grouped(c.unread)} couldn’t be read` : undefined,
    },
  ]
})

const waitingOpen = ref(false)
const route = useRoute()

/** Open the waiting group when the hash names one of its series, then bring the row into view. */
async function followHash() {
  const id = decodeURIComponent(route.hash.slice(1))
  if (!id || !card.value.waiting.some((r) => r.id === id)) return
  waitingOpen.value = true
  await nextTick()
  // A frame later, once the group has its height: the row has nowhere to scroll to before.
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView())
}

onMounted(followHash)
watch(() => route.hash, followHash)
</script>

<template>
  <div>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-default p-3 sm:grid-cols-4">
      <TerminalFigure
        v-for="f in figures"
        :key="f.label"
        :label="f.label"
        :value="f.value"
        :sub="f.sub"
      />
    </dl>

    <TerminalSignalRows
      v-if="card.tested.length"
      :data="data"
      :rows="card.tested"
      caption="Every tested series and its best held-out result"
    />
    <div v-else class="p-3">
      <TerminalGap title="No series has enough history yet." />
    </div>

    <UCollapsible
      v-if="card.waiting.length"
      v-model:open="waitingOpen"
      :unmount-on-hide="false"
      class="border-t border-default"
      :ui="{ content: 'data-[state=open]:animate-none data-[state=closed]:animate-none' }"
    >
      <UButton
        variant="ghost"
        color="neutral"
        block
        trailing-icon="i-lucide-chevron-down"
        class="group justify-start gap-x-3 rounded-none px-3 py-2 text-left"
        :ui="{
          trailingIcon: 'ms-auto transition-transform group-data-[state=open]:rotate-180',
        }"
      >
        <span class="flex flex-wrap items-baseline gap-x-3">
          <span class="text-sm text-highlighted">Waiting on history</span>
          <span class="text-xs text-muted">{{ grouped(card.counts.waiting) }} series</span>
        </span>
      </UButton>
      <template #content>
        <div class="border-t border-default">
          <TerminalSignalRows
            :data="data"
            :rows="card.waiting"
            caption="Every series waiting on history and what it still needs"
            waiting
          />
        </div>
      </template>
    </UCollapsible>
  </div>
</template>
