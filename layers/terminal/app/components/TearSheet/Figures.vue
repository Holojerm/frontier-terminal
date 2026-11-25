<script setup lang="ts">
// Single figures on the sheet, label left and value right, each with its change,
// footnote and the lines under it. A figure with no value prints its gap's reason,
// because paper can't open a popover.

defineProps<{ figures: SheetFigure[]; wide?: boolean }>()
</script>

<template>
  <dl :class="wide ? 'grid gap-x-6 gap-y-2 sm:grid-cols-2 print:grid-cols-2' : 'space-y-2'">
    <div
      v-for="f in figures"
      :key="f.label"
      class="flex flex-wrap items-baseline justify-between gap-x-3"
    >
      <!-- A gap can still rest on a read (sites at 0 MW), so its footnote sits on the label. -->
      <dt class="text-xs text-muted">
        {{ f.label }}<TearSheetRef v-if="f.value === null" :n="f.ref" />
      </dt>
      <dd v-if="f.value !== null" class="text-right">
        <span v-if="f.delta" class="mr-2 text-xs text-muted">{{ f.delta }}</span>
        <span class="font-mono text-highlighted">{{ f.value }}</span><TearSheetRef :n="f.ref" />
      </dd>
      <dd v-else-if="f.gap" class="w-full">
        <TearSheetGap :title="f.gap.title" :reason="f.gap.reason" />
      </dd>
      <dd v-for="line in f.lines" :key="line" class="w-full text-xs text-muted">
        {{ line }}
      </dd>
    </div>
  </dl>
</template>
