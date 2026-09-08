<script setup lang="ts">
// The app shell for every page. One layout: there is no signed-in state to
// adapt to, so the header is the mark and the color-mode toggle, and the footer
// is the copyright line. Split it the day the terminal needs a sidebar.

const config = useRuntimeConfig()

const appName = config.public.appName
const year = new Date().getFullYear()
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
               what every generated icon is derived from (DESIGN.md › Brand mark).
               Redesign it there and the tab, the home screen, and the share
               image follow on the next `bun run brand:generate`. -->
          <NuxtLink to="/" class="min-touch flex items-center" :aria-label="`${appName} — home`">
            <BrandLogo />
          </NuxtLink>

          <UColorModeButton class="min-touch" />
        </div>
      </UContainer>
    </header>

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
        <div class="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-sm text-muted">© {{ year }} {{ appName }}</p>
          <p class="text-sm text-muted">Not investment advice.</p>
        </div>
      </UContainer>
    </footer>
  </div>
</template>
