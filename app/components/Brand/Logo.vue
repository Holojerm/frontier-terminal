<script setup lang="ts">
// The brand mark, and the only place it is drawn.
//
// DESIGN.md › Brand mark is the contract; this file is what it compiles to, the
// same way main.css and app.config.ts are what the rest of DESIGN.md compiles
// to. `bun run brand:generate` extracts the <svg data-brand-mark> element below
// and derives every standalone asset from it — favicon.svg, the apple-touch
// icon, the two manifest icons, the OG share image. That is the whole reason
// the mark lives in a component instead of five hand-drawn files: a logo that
// exists in five places gets redesigned in one of them.
//
// Two consequences worth knowing before editing:
//
//   1. The geometry must stay static. No interpolation, no bindings, no
//      directives inside the <svg> — a .png cannot evaluate them, and the
//      generator refuses rather than silently shipping a mark that differs
//      between the header and the browser tab.
//   2. It paints with `currentColor`, so in-app it inherits whatever text token
//      its container sets, and the generated files get the resolved DESIGN.md
//      color substituted in. Never put a hex in here — design:check fails on it.
//
// After changing the mark, run `bun run brand:generate` and commit what it
// writes. `bun run brand:check` (part of `bun run ci`) fails the build if you
// forget.

interface Props {
  /** `lockup` pairs the mark with the app name; `mark` is the glyph alone. */
  variant?: 'mark' | 'lockup'
  /** Utilities for the glyph itself — size *and* color. Kept off the root so
   *  the lockup's text size stays independent of it, and passed rather than
   *  merged so a caller can actually recolor the mark: two competing color
   *  utilities on one element are settled by stylesheet order, not by argument
   *  order, so `text-primary` baked in here would quietly beat a `text-inverted`
   *  from outside. Override it and you own both halves. */
  markClass?: string
}

withDefaults(defineProps<Props>(), {
  variant: 'lockup',
  markClass: 'size-6 text-primary',
})

const appName = useRuntimeConfig().public.appName
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <svg
      data-brand-mark
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      :class="['shrink-0', markClass]"
    >
      <!-- A frontier, and the edge that has crossed it — DESIGN.md › Brand mark.
           One closed path of three rising treads over a dim full-width rule;
           square corners, because `--ui-radius` softens controls, not readings. -->
      <path d="M3 20.5V16.5h8.5V11.5h8.5V7H29v13.5Z" />
      <rect x="3" y="22.5" width="26" height="2.5" opacity=".5" />
    </svg>

    <!-- Two rules from DESIGN.md › Component behavior › Navigation, both about
         the same fact — the display face is monospaced, so "Frontier Terminal"
         sets about 15% wider than it would proportionally. `whitespace-nowrap`
         stops the header wrapping to two lines when the nav squeezes the
         lockup, and the smaller step below `sm` keeps the menu and color-mode
         buttons on a 375px header instead of pushing them off it. -->
    <span
      v-if="variant === 'lockup'"
      class="whitespace-nowrap font-display text-base tracking-tight text-highlighted sm:text-lg"
      >{{ appName }}</span
    >
  </span>
</template>
