<script setup lang="ts">
// The brand mark, and the only place it is drawn (DESIGN.md › Brand mark).
// `bun run brand:generate` extracts the <svg data-brand-mark> element below and derives
// every standalone asset from it (favicon.svg, apple-touch icon, manifest icons, OG image).
//
//   1. The geometry must stay static: no interpolation, bindings or directives inside the
//      <svg>. A .png cannot evaluate them, so the generator refuses.
//   2. It paints with `currentColor`; the generated files get the resolved DESIGN.md color
//      substituted in. Never put a hex here (design:check fails on it).
//
// After changing the mark, run `bun run brand:generate` and commit what it writes;
// `bun run brand:check` fails the build otherwise.

interface Props {
  /** `lockup` pairs the mark with the app name; `mark` is the glyph alone. */
  variant?: 'mark' | 'lockup'
  /** Utilities for the glyph: size and color. Passed rather than merged so a caller can
   *  recolor it (two color utilities on one element resolve by stylesheet order, so a
   *  baked-in `text-primary` would beat a caller's `text-inverted`). Override it and you
   *  own both. */
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

    <!-- DESIGN.md › Component behavior › Navigation: the display face is monospaced, so the
         name sets about 15% wider. `whitespace-nowrap` keeps the header on one line, and the
         smaller step below `sm` keeps the menu buttons on a 375px header. -->
    <span
      v-if="variant === 'lockup'"
      class="whitespace-nowrap font-display text-base tracking-tight text-highlighted sm:text-lg"
      >{{ appName }}</span
    >
  </span>
</template>
