<script setup lang="ts">
// The app shell for every page. One layout: there is no signed-in state to
// adapt to, so the header is the mark, the six section links, and the
// color-mode toggle; the footer is the disclaimer and the machine-readable
// exits (feed, exports, repo).
//
// Navigation follows DESIGN.md › Component behavior: inline links from `sm`
// up, a right-side slideover behind a menu button below that. The drawer
// closes on route change, not on click, so a redirect closes it too.

import manifest from '~~/fleet.json'

const config = useRuntimeConfig()
const route = useRoute()

const appName = config.public.appName
const year = new Date().getFullYear()
const repo = manifest.links.github

const links = [
  { label: 'Overview', to: '/' },
  { label: 'Prices', to: '/prices' },
  { label: 'Demand', to: '/rankings' },
  { label: 'Alerts', to: '/alerts' },
  { label: 'Incidents', to: '/incidents' },
  { label: 'Data', to: '/data' },
  { label: 'About', to: '/about' },
]

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
    <!-- Skip link — WCAG 2.4.1. First focusable element on every page, so a
         keyboard or screen-reader user can jump the nav instead of tabbing it on
         each navigation. Visually hidden until focused. -->
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-elevated focus:px-4 focus:py-2 focus:text-highlighted focus:ring-2 focus:ring-primary"
    >
      Skip to content
    </a>

    <header class="border-b border-default">
      <UContainer>
        <div class="flex h-16 items-center justify-between gap-4">
          <!-- The mark and the wordmark both come from BrandLogo, which is also
               what every generated icon is derived from (DESIGN.md › Brand mark). -->
          <NuxtLink to="/" class="min-touch flex items-center" :aria-label="`${appName} — home`">
            <BrandLogo />
          </NuxtLink>

          <nav aria-label="Primary" class="hidden sm:block">
            <UNavigationMenu :items="links" />
          </nav>

          <div class="flex items-center gap-2">
            <UColorModeButton class="min-touch" />
            <UButton
              class="min-touch sm:hidden"
              icon="i-lucide-menu"
              color="neutral"
              variant="ghost"
              aria-label="Open navigation"
              @click="drawer = true"
            />
          </div>
        </div>
      </UContainer>
    </header>

    <USlideover v-model:open="drawer" title="Navigation" description="Sections of the terminal">
      <template #body>
        <nav aria-label="Primary, drawer">
          <ul class="space-y-1">
            <li v-for="link in links" :key="link.to">
              <UButton
                :to="link.to"
                variant="ghost"
                color="neutral"
                size="lg"
                block
                class="justify-start"
              >
                {{ link.label }}
              </UButton>
            </li>
          </ul>
        </nav>
      </template>
    </USlideover>

    <!-- tabindex="-1" so the skip link moves focus here, not just the scroll
         position — without it the next Tab lands back at the top of the nav.
         The focus-visible rule protects elements a user can Tab to; `main` is only
         ever focused programmatically by the skip link, and a ring around the whole
         page region reads as a rendering bug. design-check-ignore -->
    <UContainer id="main" as="main" tabindex="-1" class="flex-1 py-8 focus:outline-none">
      <slot />
    </UContainer>

    <footer class="mt-16 border-t border-default">
      <UContainer>
        <div
          class="flex flex-col gap-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between"
        >
          <p>© {{ year }} {{ appName }} · Not investment advice.</p>
          <ul class="flex flex-wrap gap-4">
            <li><NuxtLink to="/alerts.xml" external>Atom feed</NuxtLink></li>
            <li><NuxtLink to="/data">Exports</NuxtLink></li>
            <li><a :href="repo" target="_blank" rel="noopener noreferrer">Source on GitHub</a></li>
          </ul>
        </div>
      </UContainer>
    </footer>
  </div>
</template>
