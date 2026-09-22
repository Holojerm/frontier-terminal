<script setup lang="ts">
// The app shell for every page. One layout: there is no signed-in state to
// adapt to, so the header is the mark, the section links, and the
// color-mode toggle; the footer is the disclaimer, the reference pages, and
// the machine-readable exits (feed, repo).
//
// Navigation follows DESIGN.md › Component behavior: inline links from `md`
// up, a right-side slideover behind a menu button below that. The drawer
// closes on route change, not on click, so a redirect closes it too.

import type { NavigationMenuItem } from '@nuxt/ui'

import { LABS, labPath } from '#shared/utils/terminal-lab-summary'
import { LAB_DISPLAY } from '#shared/utils/terminal-labs'
import manifest from '~~/fleet.json'

const config = useRuntimeConfig()
const route = useRoute()

const appName = config.public.appName
const year = new Date().getFullYear()
const repo = manifest.links.github

/**
 * Every link in the shell, declared once.
 *
 * Ten flat entries across the header was a list, not a navigation: it put
 * `Prices` and `Incidents` at the same weight as `About`, and nothing in it
 * said which pages answer "what does this cost" and which answer "what is this
 * lab doing". The six reading pages now group under those two questions.
 *
 * `Overview` and `Alerts` stay top-level because they are the two entry points
 * — the state of things, and what changed in it. `Labs` is the third way in:
 * one lab across every axis. `Data` and `About` drop to the footer, which is
 * already where a reader looks for exports and the disclaimer.
 */
interface NavLink {
  label: string
  to: string
  /** One line, shown in the header dropdown. Reading pages only. */
  description?: string
}

interface NavSection {
  /** Omitted for the ungrouped entry points at the top of the drawer. */
  label?: string
  links: NavLink[]
}

const OVERVIEW: NavLink = { label: 'Overview', to: '/' }
const ALERTS: NavLink = { label: 'Alerts', to: '/alerts' }

const SECTIONS: NavSection[] = [
  {
    label: 'Labs',
    // No description: the label is the whole meaning, and four lines saying
    // "on every axis" under four lab names is a menu repeating itself.
    links: LABS.map((lab) => ({ label: LAB_DISPLAY[lab], to: labPath(lab) })),
  },
  {
    label: 'Economics',
    links: [
      {
        label: 'Prices',
        to: '/prices',
        description: 'List price per SKU, like for like, with the delta.',
      },
      {
        label: 'Revenue',
        to: '/revenue',
        description: 'What each lab has actually disclosed to the SEC.',
      },
      {
        label: 'Demand',
        to: '/rankings',
        description: 'OpenRouter token share, and the spend it implies.',
      },
    ],
  },
  {
    label: 'Operations',
    links: [
      {
        label: 'Hiring',
        to: '/hiring',
        description: 'Open roles by department, and the buildout behind them.',
      },
      {
        label: 'Releases',
        to: '/releases',
        description: 'Every SKU first seen since watching began.',
      },
      {
        label: 'Incidents',
        to: '/incidents',
        description: 'Status-page history and current API strain.',
      },
    ],
  },
]

const REFERENCE: NavLink[] = [
  { label: 'About', to: '/about' },
  { label: 'Data', to: '/data' },
  { label: 'License', to: '/license' },
]

// A section with `children` renders as a dropdown; one with `to` renders as a
// plain link. Both come from the same objects the drawer and footer read.
const headerItems: NavigationMenuItem[] = [
  OVERVIEW,
  ...SECTIONS.map((section) => ({ label: section.label, children: section.links })),
  ALERTS,
]

// The drawer is the whole site map rather than a copy of the header: below
// `md` it is the only navigation affordance there is, so the reference pages
// belong in it even though the header hands them to the footer.
const drawerSections: NavSection[] = [
  { links: [OVERVIEW, ALERTS] },
  ...SECTIONS,
  { label: 'Reference', links: REFERENCE },
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

          <nav aria-label="Primary" class="hidden md:block">
            <!-- Vertical content because each child carries a description: the
                 default horizontal panel spreads three of those across the
                 viewport, which is a menu pretending to be a landing page. -->
            <UNavigationMenu :items="headerItems" content-orientation="vertical" />
          </nav>

          <div class="flex items-center gap-2">
            <UColorModeButton class="min-touch" />
            <UButton
              class="min-touch md:hidden"
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
          <div class="space-y-6">
            <div v-for="(section, index) in drawerSections" :key="section.label ?? index">
              <!-- A real heading, not a styled div: the drawer is a list of
                   lists, and a screen reader should be able to jump between
                   them (DESIGN.md › Accessibility › Structure and labels).
                   `text-toned`, not `text-dimmed`: dimmed is the disabled and
                   placeholder token and is legitimately under AA, which is the
                   wrong thing for 12px type that carries the structure. -->
              <h3
                v-if="section.label"
                class="mb-1 px-2.5 text-xs uppercase tracking-wide text-toned"
              >
                {{ section.label }}
              </h3>
              <ul class="space-y-1">
                <li v-for="link in section.links" :key="link.to">
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
            </div>
          </div>
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
