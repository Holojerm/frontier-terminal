<script setup lang="ts">
// The reader's settings, behind one header button: color mode, how times and
// figures read, table density, and the starred labs. Everything saves to this
// browser as it changes (composables/useReaderPrefs.ts), so there is no save
// button. The popover's content renders only while it is open, so the header
// hydrates one button and never the zone list.

import { LABS } from '../../../shared/utils/terminal-lab-summary'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import { DEFAULTS, browserZone, type ReaderPrefs } from '../../composables/useReaderPrefs'

const colorMode = useColorMode()
const { prefs, set, reset } = useReaderPrefs()
const stamps = useStamps()
const figures = useFigures()
const watchlist = useWatchlist()

const open = ref(false)

type Option<V> = { label: string; value: V }

const COLOR: Option<string>[] = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
]
const CLOCK: Option<ReaderPrefs['clock']>[] = [
  { label: 'Auto', value: 'auto' },
  { label: '24-hour', value: '24h' },
  { label: '12-hour', value: '12h' },
]
const DATES: Option<ReaderPrefs['dates']>[] = [
  { label: 'Nov 7', value: 'short' },
  { label: '2026-11-07', value: 'iso' },
]
const NUMBERS: Option<ReaderPrefs['numbers']>[] = [
  { label: '$7.81B', value: 'compact' },
  { label: '$7,810,000,000', value: 'full' },
]
const DENSITY: Option<ReaderPrefs['density']>[] = [
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Compact', value: 'compact' },
]

// Built on first open: about 400 zones, which the header never needs otherwise.
const zones = computed<Option<string>[]>(() => {
  if (!open.value) return []
  const named = Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')
  return [
    { label: `Local (${browserZone().replaceAll('_', ' ')})`, value: 'local' },
    { label: 'UTC', value: 'UTC' },
    ...named.map((z) => ({ label: z.replaceAll('_', ' '), value: z })),
  ]
})

// One writable computed per setting, so every control is a plain v-model.
// An inline `@update:model-value="f(key)"` would only call f, never the
// setter it returns, and the control would silently do nothing.
// Spelled out per field: a generic `bind(key)` over the readonly `prefs`
// failed `computed`'s overloads in Workers Builds' typecheck.
const zone = computed({
  get: () => prefs.value.zone,
  set: (v: ReaderPrefs['zone']) => set({ zone: v }),
})
const clock = computed({
  get: () => prefs.value.clock,
  set: (v: ReaderPrefs['clock']) => set({ clock: v }),
})
const dates = computed({
  get: () => prefs.value.dates,
  set: (v: ReaderPrefs['dates']) => set({ dates: v }),
})
const relative = computed({
  get: () => prefs.value.relative,
  set: (v: boolean) => set({ relative: v }),
})
const numbers = computed({
  get: () => prefs.value.numbers,
  set: (v: ReaderPrefs['numbers']) => set({ numbers: v }),
})
const density = computed({
  get: () => prefs.value.density,
  set: (v: ReaderPrefs['density']) => set({ density: v }),
})
const mode = computed({
  get: () => colorMode.preference,
  set: (value: string) => (colorMode.preference = value),
})

const sample = computed(() =>
  stamps.absolute(new Date(stamps.now.value ?? Date.now()).toISOString()),
)
const changed = computed(
  () =>
    JSON.stringify(prefs.value) !== JSON.stringify(DEFAULTS) || colorMode.preference !== 'system',
)

function resetAll() {
  reset()
  colorMode.preference = 'system'
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'end' }">
    <UButton
      class="min-touch"
      icon="i-lucide-settings-2"
      color="neutral"
      variant="ghost"
      aria-label="Settings"
    />

    <template #content>
      <div
        class="max-h-[80svh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-4 text-sm"
        role="group"
        aria-label="Settings"
      >
        <div class="space-y-4">
          <UFormField label="Color mode">
            <USelect v-model="mode" :items="COLOR" class="w-full" />
          </UFormField>

          <fieldset class="space-y-3">
            <legend class="mb-2 text-xs text-toned">Times</legend>
            <UFormField label="Time zone">
              <USelectMenu
                v-model="zone"
                aria-label="Time zone"
                :items="zones"
                value-key="value"
                virtualize
                class="w-full"
              />
            </UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField label="Clock">
                <USelect v-model="clock" :items="CLOCK" class="w-full" />
              </UFormField>
              <UFormField label="Dates">
                <USelect v-model="dates" :items="DATES" class="w-full" />
              </UFormField>
            </div>
            <USwitch v-model="relative" label="Show recent times as ages (3h ago)" />
            <p class="text-xs text-muted">
              Now reads as <span class="font-mono text-default">{{ sample }}</span
              >. Hover over a time for the exact UTC value we stored.
            </p>
          </fieldset>

          <fieldset class="space-y-3">
            <legend class="mb-2 text-xs text-toned">Tables and figures</legend>
            <div class="grid grid-cols-2 gap-3">
              <UFormField label="Dollar figures">
                <USelect v-model="numbers" :items="NUMBERS" class="w-full" />
              </UFormField>
              <UFormField label="Row spacing">
                <USelect v-model="density" :items="DENSITY" class="w-full" />
              </UFormField>
            </div>
            <p class="text-xs text-muted">
              Token counts follow too ({{ figures.tokens(2.4e12) }}). Chart axes stay short.
            </p>
          </fieldset>

          <fieldset>
            <legend class="mb-2 text-xs text-toned">Watchlist</legend>
            <p class="mb-2 text-xs text-muted">Starred labs come first in menus and lab lists.</p>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1">
              <UCheckbox
                v-for="lab in LABS"
                :key="lab"
                :model-value="watchlist.has(lab)"
                :label="LAB_DISPLAY[lab]"
                class="min-h-6"
                @update:model-value="watchlist.toggle(lab)"
              />
            </div>
          </fieldset>

          <div class="flex items-center justify-between gap-2 border-t border-default pt-3">
            <p class="text-xs text-muted">Saved in this browser only.</p>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              label="Reset"
              :disabled="!changed"
              @click="resetAll"
            />
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
