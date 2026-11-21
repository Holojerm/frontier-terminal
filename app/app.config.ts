// GENERATED FROM /DESIGN.md: edit that file, then run `/design-sync`. Hand-edits are
// overwritten on the next sync. Raw values (palette, type scale, radius) belong in
// app/assets/css/main.css.
//
// Before adding a component override, read the resolved theme at .nuxt/ui/<component>.ts:
// most of it is already NuxtUI's default, and a `slots` override loses to any `variants`
// entry that touches the same property.

export default defineAppConfig({
  ui: {
    // DESIGN.md › Color › Semantic assignments. `iris` is the custom ramp in main.css; the
    // rest are Tailwind built-ins. Every color named here needs all 11 shades.
    //
    // `zinc` rather than `slate`: a blue-tinted neutral beside the violet accent makes the
    // page one hue and the accent stops reading as an accent.
    colors: {
      primary: 'iris',
      secondary: 'zinc',
      neutral: 'zinc',
      success: 'emerald',
      info: 'sky',
      warning: 'amber',
      error: 'rose',
    },

    // DESIGN.md › Component behavior › Cards. NuxtUI's `subtle` variant is already elevated
    // surface, hairline ring and no shadow; a variant default keeps tailwind-merge out of it.
    card: {
      defaultVariants: {
        variant: 'subtle',
      },
    },

    // DESIGN.md › Component behavior › Alerts. The resolved theme sets the
    // description slot to `text-sm opacity-90`; tailwind-merge keeps the size
    // and replaces the opacity.
    alert: {
      slots: {
        description: 'opacity-100',
      },
    },

    // DESIGN.md › Typography › Scale: nothing sets below text-xs. NuxtUI's
    // `sm` and `xs` badges set 10px and 8px.
    badge: {
      variants: {
        size: {
          xs: { base: 'text-xs' },
          sm: { base: 'text-xs' },
        },
      },
    },

    // DESIGN.md › Component behavior › Long-form content. With @nuxt/content installed,
    // <ContentRenderer> maps every markdown node onto NuxtUI's Prose* components; these are
    // the only two defaults that contradict DESIGN.md.
    prose: {
      // The display face carries its own weight (500, in main.css's base layer); NuxtUI's
      // `font-bold` would contradict DESIGN.md › Typography and lose the base rule's tracking.
      h1: { slots: { base: 'font-normal' } },
      h2: { slots: { base: 'font-normal' } },
      h3: { slots: { base: 'font-normal' } },
      // DESIGN.md › Accessibility › Contrast: inline prose links are underlined, since color
      // alone is no distinction (WCAG 1.4.1). NuxtUI's default border shows only on hover,
      // which axe's link-in-text-block rule fails.
      a: { base: 'border-b-0 underline underline-offset-2 hover:decoration-2' },
    },
  },
})
