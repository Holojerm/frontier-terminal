<script setup lang="ts">
// The app shell for every page (no signed-in state, so one layout). DESIGN.md › Component
// behavior › Navigation. Below `lg` the axis bar becomes a right-side drawer carrying the
// whole site map. The drawer closes on route change, not on click, so a redirect closes it.

import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

import manifest from '~~/fleet.json'

const config = useRuntimeConfig()
const route = useRoute()

const appName = config.public.appName
const year = new Date().getFullYear()
const repo = manifest.links.github

interface NavLink {
  label: string
  to: string
}

interface NavGroup {
  label: string
  links: (NavLink & { description: string })[]
}

// The axes group under the two questions they answer: what the labs' business costs and
// earns (Economics) and what the labs are doing (Operations). Entry points stay one click.
const OVERVIEW: NavLink = { label: 'Overview', to: '/' }
const ALERTS: NavLink = { label: 'Alerts', to: '/alerts' }
const THESES: NavLink = { label: 'Theses', to: '/theses' }

const GROUPS: NavGroup[] = [
  {
    label: 'Economics',
    links: [
      { label: 'Prices', to: '/prices', description: 'List price per SKU, like for like.' },
      {
        label: 'Revenue',
        to: '/revenue',
        description: 'SEC filings, and what investors disclose.',
      },
      {
        label: 'Ground truth',
        to: '/ground-truth',
        description: 'Press reports scored against later filings.',
      },
      {
        label: 'Signals',
        to: '/signals',
        description: 'Each series tested against the stocks it should lead.',
      },
      {
        label: 'Exposure',
        to: '/exposure',
        description: 'Hyperscaler capex, backlog and lab stakes.',
      },
      {
        label: 'Dependencies',
        to: '/dependencies',
        description: 'Who buys from and funds whom, as a graph.',
      },
      { label: 'Demand', to: '/rankings', description: 'OpenRouter, Ramp, downloads, agents.' },
      { label: 'Compute', to: '/compute', description: 'GPU rental prices and utilization.' },
      {
        label: 'Hardware',
        to: '/hardware',
        description: 'Taiwan monthly revenue, Korea chip exports, suppliers.',
      },
      { label: 'Power', to: '/power', description: 'Data-center power, site ties, grid load.' },
    ],
  },
  {
    label: 'Operations',
    links: [
      { label: 'Hiring', to: '/hiring', description: 'Open roles, buildout and posted pay.' },
      { label: 'Releases', to: '/releases', description: 'Every SKU first listed.' },
      {
        label: 'Incidents',
        to: '/incidents',
        description: 'Status pages and published rate limits.',
      },
      {
        label: 'Disclosures',
        to: '/disclosures',
        description: 'Misalignment reports the labs publish.',
      },
    ],
  },
]

const LAB_LINKS: NavLink[] = LABS.map((lab) => ({ label: LAB_DISPLAY[lab], to: labPath(lab) }))

const REFERENCE: NavLink[] = [
  { label: 'About', to: '/about' },
  { label: 'Data', to: '/data' },
  { label: 'License', to: '/license' },
  { label: 'Contact', to: '/contact' },
  { label: 'Privacy', to: '/about#privacy' },
]

// A child page keeps its axis lit: /prices/<sku> under Prices, /alerts/<id>
// under Alerts. The routes are siblings in the router, not nested, so the
// link's own active state would not.
const isActive = (to: string) =>
  to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`)

const axisItems = computed<NavigationMenuItem[]>(() => [
  { ...OVERVIEW, active: isActive(OVERVIEW.to) },
  ...GROUPS.map((g) => ({
    label: g.label,
    active: g.links.some((l) => isActive(l.to)),
    children: g.links.map((l) => ({ ...l, active: isActive(l.to) })),
  })),
  { ...ALERTS, active: isActive(ALERTS.to) },
  { ...THESES, active: isActive(THESES.to) },
])

const currentLab = computed(() => {
  const param = String(route.params.lab ?? '')
  return route.path.startsWith('/labs/') && isLab(param) ? LAB_DISPLAY[param] : null
})
// The reader's starred labs lead both lab lists, marked with a star.
const watchlist = useWatchlist()
const labLinks = computed(() => watchlist.first(LAB_LINKS, (l) => l.to.slice('/labs/'.length)))
const starred = (l: NavLink) => watchlist.has(l.to.slice('/labs/'.length))
const labItems = computed<DropdownMenuItem[][]>(() => [
  labLinks.value.map((l) => ({
    label: l.label,
    to: l.to,
    trailingIcon: starred(l) ? 'i-lucide-star' : undefined,
  })),
])

const drawerSections = computed<{ label: string; links: NavLink[] }[]>(() => [
  { label: 'Terminal', links: [OVERVIEW, ALERTS, THESES] },
  ...GROUPS,
  { label: 'Labs', links: labLinks.value },
  { label: 'Reference', links: REFERENCE },
])

const drawer = ref(false)
watch(
  () => route.path,
  () => {
    drawer.value = false
  },
)
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-default">
    <!-- Skip link (WCAG 2.4.1): the first focusable element, visually hidden until focused. -->
    <a
      href="#main"
      class="sr-only print:hidden focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-4 focus:py-2 focus:text-highlighted focus:ring-2 focus:ring-primary"
    >
      Skip to content
    </a>

    <!-- Sticky so the nav stays one reach away on long pages. main.css derives
         --header-offset from these row heights; anything else pinned below the
         header should use top-(--header-offset). -->
    <header
      class="sticky top-0 z-40 border-b print:hidden border-default bg-default/75 backdrop-blur"
    >
      <UContainer>
        <div class="flex h-(--ui-header-height) items-center justify-between gap-4">
          <div class="flex min-w-0 items-center gap-4">
            <NuxtLink to="/" class="min-touch flex items-center" :aria-label="`${appName} — home`">
              <BrandLogo />
            </NuxtLink>
            <UDropdownMenu :items="labItems" :content="{ align: 'start' }">
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                trailing-icon="i-lucide-chevron-down"
                class="min-touch hidden sm:inline-flex"
                :label="currentLab ?? 'Labs'"
              />
            </UDropdownMenu>
          </div>

          <div class="flex items-center gap-2">
            <TerminalSettings />
            <UButton
              class="min-touch lg:hidden"
              icon="i-lucide-menu"
              color="neutral"
              variant="ghost"
              aria-label="Open navigation"
              @click="drawer = true"
            />
          </div>
        </div>
      </UContainer>

      <div class="hidden border-t border-default lg:block">
        <UContainer>
          <nav aria-label="Primary" class="flex h-12 items-center">
            <UNavigationMenu :items="axisItems" variant="link" highlight class="-mx-2.5" />
          </nav>
        </UContainer>
      </div>
    </header>

    <USlideover v-model:open="drawer" title="Navigation" description="Sections of the terminal">
      <template #body>
        <nav aria-label="Primary, drawer">
          <div class="space-y-6">
            <div v-for="section in drawerSections" :key="section.label">
              <!-- A real heading so a screen reader can jump between lists (DESIGN.md ›
                   Accessibility › Structure and labels). `text-toned`, not `text-dimmed`:
                   dimmed is the placeholder token and sits under AA. -->
              <h3 class="mb-1 px-2.5 text-xs uppercase tracking-wide text-toned">
                {{ section.label }}
              </h3>
              <ul class="space-y-1">
                <li v-for="link in section.links" :key="link.to">
                  <UButton
                    :to="link.to"
                    variant="ghost"
                    :color="isActive(link.to) ? 'primary' : 'neutral'"
                    size="lg"
                    block
                    class="justify-start"
                  >
                    {{ link.label }}
                  </UButton>
                </li>
              </ul>
            </div>
          </div>
        </nav>
      </template>
    </USlideover>

    <!-- On paper the header and footer are hidden, so a printed tear sheet is the content alone. -->
    <!-- tabindex="-1" so the skip link moves focus, not just the scroll position. `main` is
         only focused programmatically, and a ring around the page reads as a bug. design-check-ignore -->
    <UContainer id="main" as="main" tabindex="-1" class="flex-1 py-6 focus:outline-none print:py-0">
      <slot />
    </UContainer>

    <footer class="mt-12 border-t border-default print:hidden">
      <UContainer>
        <div
          class="flex flex-col gap-4 py-6 text-sm text-muted sm:flex-row sm:items-center sm:justify-between"
        >
          <p>© {{ year }} {{ appName }} · Not investment advice.</p>
          <ul class="flex flex-wrap gap-x-4 [&_a]:inline-block [&_a]:py-1">
            <li v-for="link in REFERENCE" :key="link.to">
              <NuxtLink :to="link.to">{{ link.label }}</NuxtLink>
            </li>
            <li><NuxtLink to="/alerts.xml" external>Atom feed</NuxtLink></li>
            <li><a :href="repo" target="_blank" rel="noopener noreferrer">Source on GitHub</a></li>
          </ul>
        </div>
      </UContainer>
    </footer>
  </div>
</template>
