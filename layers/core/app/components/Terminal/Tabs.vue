<script setup lang="ts">
// Tabs over a page's sections (DESIGN.md › Terminal primitives); each tab's
// content is a named slot, `#<value>`. Every tab renders on the server and
// stays in the document, hidden, so crawlers, find-in-page and axe see it all.
// The open tab is `?tab=` (absent for the first), and an anchor in a closed tab
// opens it.

export interface TerminalTab {
  value: string
  label: string
  /** A count beside the label. */
  badge?: string | number
}

const props = defineProps<{ tabs: TerminalTab[] }>()

const route = useRoute()
const router = useRouter()

const first = computed(() => props.tabs[0]?.value ?? '')
const isTab = (v: unknown): v is string =>
  typeof v === 'string' && props.tabs.some((t) => t.value === v)

const active = computed({
  get: () => (isTab(route.query.tab) ? route.query.tab : first.value),
  set: (v: string) => {
    void router.replace({
      query: { ...route.query, tab: v === first.value ? undefined : v },
      hash: route.hash,
    })
  },
})

const items = computed(() =>
  props.tabs.map((t) => ({
    label: t.label,
    value: t.value,
    badge:
      t.badge === undefined
        ? undefined
        : { label: String(t.badge), variant: 'subtle' as const, color: 'neutral' as const },
    slot: 'panel' as const,
  })),
)

/** Open the tab that holds the hash's target, then bring the target into view. */
async function followHash() {
  const id = decodeURIComponent(route.hash.slice(1))
  if (!id) return
  const el = document.getElementById(id)
  const owner = el?.closest<HTMLElement>('[data-terminal-tab]')?.dataset.terminalTab
  if (!el || !owner || owner === active.value) return
  active.value = owner
  await nextTick()
  el.scrollIntoView()
}

onMounted(followHash)
watch(() => route.hash, followHash)
</script>

<template>
  <UTabs
    v-model="active"
    :items="items"
    :unmount-on-hide="false"
    variant="link"
    :ui="{ root: 'gap-6', list: 'overflow-x-auto', trigger: 'shrink-0' }"
  >
    <template #panel="{ item }">
      <div :data-terminal-tab="item.value" class="space-y-6">
        <slot :name="item.value" />
      </div>
    </template>
  </UTabs>
</template>
