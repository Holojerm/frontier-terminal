# DESIGN.md

The visual design system for this app, in the portable [DESIGN.md](https://designmd.app/)
format that Claude Code, Codex, Cursor, and friends read directly.

**This file is the source of truth.** `app/assets/css/main.css` and `app/app.config.ts` are
*compiled from it* — run `/design-sync` after editing this file, never hand-edit the two
generated files and expect them to survive. `bun run design:check` enforces that app code uses
only the tokens declared here.

The brand mark works the same way one level out: `/logo-sync` writes
`app/components/Brand/Logo.vue` from the Brand mark section below, `bun run brand:generate`
derives the favicon, app icon, and share image from that component, and `bun run brand:check`
fails the build when they fall out of sync.

> **Scope note:** this file means *visual* design — color, type, space, motion, component
> behavior. Architectural rationale and stack decisions live in `CLAUDE.md`, not here.

---

## Identity

Frontier Terminal is an instrument, not a publication. Someone opens it to find out what a
lab's API costs this morning, how many people it is hiring, and what it told the SEC — and to
see where that number came from. The design serves that and nothing else.

- **Personality:** instrumented, dense, unsentimental
- **References:** a trading terminal's information density; EDGAR's refusal to decorate;
  flight-deck instrumentation, where every marking is a reading
- **Audience:** investors and operators who check it daily, know the domain, and want the
  number and its provenance rather than a narrative about them
- **Density:** dense in data, comfortable in prose. Tables and panels pack; the few pages of
  running text keep a reading rhythm.
- **Motion:** minimal. Motion confirms, it never decorates.
- **Iconography:** Lucide (`i-lucide-*`), bundled locally via `@iconify-json/lucide`. Line
  icons at default weight — never emoji, never a second icon family.
- **Color mode:** **dark-first.** Dark is the primary design target and the fallback when a
  visitor expresses no preference; light is a first-class equal, checked in the same axe sweep,
  never an afterthought. Every design decision here is made in dark and then verified in light.

### Never

- Gradients as decoration, glassmorphism, or drop shadows used for style rather than elevation
- More than one accent color visible in a single viewport
- Pure black (`#000`) or pure white (`#fff`) as a surface color
- Emoji as UI iconography
- A figure rendered without its source link and its fetch timestamp within reach — provenance
  is the product, so a design that hides it is a wrong design

---

## Brand mark

**A frontier, and the edge that has crossed it.** A dim rule runs the full width — the line
everything on this site is measured against — and above it a solid mass climbs in three steps
from left to right. Two elements, one flat fill, one opacity step.

Abstract rather than a letterform on purpose: `bun run rename` cannot rewrite a picture, so an
initial would still spell the template's name long after the app stopped being called that.

**The mark lives in `app/components/Brand/Logo.vue`, and nowhere else.** Every standalone
file is derived from that component by `bun run brand:generate`:

| Generated file | Size | What it is |
|---|---|---|
| `public/favicon.svg` | 32 grid | The browser tab. Carries its own ground — a transparent mark vanishes against a dark tab strip. |
| `public/apple-touch-icon.png` | 180×180 | iOS home screen. Full-bleed: iOS applies its own corner mask, so baking one in double-rounds it. |
| `public/icon-192.png` | 192×192 | Android/desktop "Add to Home Screen", via `manifest.webmanifest`. Maskable-safe: the mark's bounding square covers 56% of the icon — bounding a *square* inside Android's 80%-diameter safe-zone *circle* takes a smaller number than the circle itself, not the same one (`MASKABLE_COVERAGE` in `scripts/generate-brand-assets.ts`). |
| `public/icon-512.png` | 512×512 | Same treatment, larger — the splash-screen source in `manifest.webmanifest`. |
| `public/og.png` | 1200×630 | Every link preview of this site — mark, app name, one sentence. |
| `shared/utils/brand-colors.generated.ts` | — | `theme_color`/`background_color` for `manifest.webmanifest`, resolved from the Color roles table below — a manifest has no color mode either. |

`bun run brand:check` (part of `bun run ci`) fails the build when those files no longer match
the component. A favicon a redesign behind the app is the normal outcome otherwise; nothing
about it ever throws.

### Construction

- **Grid:** 32×32 viewBox, geometry on whole and half units only.
- **Optical box:** the glyph spans 3→29 across and 7→25 down, so it is centred with room to
  breathe once an icon square is drawn around it.
- **The rule:** full width, 2.5 units tall, at `opacity .5`, separated from the mass above it
  by a 2-unit gap. It is the reference line, so it never competes with the reading.
- **The mass:** one closed path, three treads of 8.5/8.5/9 units rising 4 → 9 → 13.5 units
  above the rule. Connected, not three bars — this is one edge, not a chart.
- **Corners:** square. The mark is drawn at instrument precision; `--ui-radius` softens
  controls, not readings.
- **Fill:** `currentColor`, one flat fill plus a single opacity step. No stroke, no gradient,
  no second hue.
- **Minimum size:** 16px. A mark that stops reading at favicon size is a different mark.
- **Clear space:** half the mark's height on every side. In the lockup that is the `gap-2`
  between glyph and wordmark.

### Color roles

A PNG has no color mode, so each role below resolves to a concrete ramp token rather than a
`--ui-*` alias — the aliases flip between light and dark, and a file has to pick one. This app
is dark-first, so the files that can only pick one pick dark.

| Role | Token | Where it lands | Measured |
|---|---|---|---|
| `icon-ink` | `--color-iris-400` | The glyph inside the app icon | 7.01 on the ground |
| `icon-ground` | `--color-zinc-950` | The square behind it | — |
| `og-mark` | `--color-iris-400` | The mark on the share image | 7.01 |
| `og-ground` | `--color-zinc-950` | Share image background | — |
| `og-ink` | `--color-zinc-50` | Share image title | 19.06 |
| `og-muted` | `--color-zinc-400` | Share image description and footer | 7.59 |
| `manifest-theme` | `--color-zinc-950` | `theme_color` in `manifest.webmanifest` — the browser UI tint once installed | — |
| `manifest-ground` | `--color-zinc-950` | `background_color` in `manifest.webmanifest` — the splash screen before the app paints | — |

`icon-ink` is the **400**, not the 600 the in-app accent resolves to in light mode: on a
zinc-950 ground the 600 measures 3.51:1 and the 400 measures 7.01:1. An icon is read at 16px
on someone else's dark dock, which is the hardest case this palette has.

In-app the mark takes `text-primary` and inherits the color mode for free. These eight exist
only for the files that can't.

### Never

- A second mark. If a surface seems to need a different logo, the logo is wrong.
- Effects: shadow, gradient, outline, rotation, or animation on the mark.
- The wordmark in anything but the display face at weight 500 (DESIGN.md › Typography).
- Hand-editing anything in `public/` — or `shared/utils/brand-colors.generated.ts` — that
  this pipeline generates.

---

## Color

### Primary ramp — `iris`

A cool blue-violet. The one accent, and deliberately not a status hue: this site spends green
on "up", red on "down", amber on "notable" and sky on "for information", so the brand cannot
have any of them without saying something it does not mean.

| Shade | Hex | Shade | Hex |
|---|---|---|---|
| 50 | `#f4f5ff` | 500 | `#7c5fff` |
| 100 | `#eaeaff` | 600 | `#6c3efa` |
| 200 | `#d7d7ff` | 700 | `#582dd4` |
| 300 | `#bab8ff` | 800 | `#4624aa` |
| 400 | `#978aff` | 900 | `#381f8a` |
| | | 950 | `#1f0f53` |

### Semantic assignments

| Role | Color | Use |
|---|---|---|
| `primary` | `iris` | CTAs, active nav, focus rings, links |
| `secondary` | `zinc` | Secondary actions — deliberately not a second hue |
| `neutral` | `zinc` | Text, borders, surfaces |
| `success` | `emerald` | Confirmations, a figure that moved up |
| `info` | `sky` | Neutral notices, ticker-grade changes |
| `warning` | `amber` | Reversible risk, notable changes |
| `error` | `rose` | Failure, destructive actions, critical alerts |

`zinc` rather than `slate` for the neutral: with a violet accent a blue-tinted grey makes the
whole page one hue, and the accent stops being an accent.

Semantic colors resolve one to three steps darker than NuxtUI's 500 default in light mode, and
to **400** in dark. This is not taste — NuxtUI's defaults fail WCAG AA in light mode in both
directions that matter, as text on their own 10% tint (`subtle` alerts and badges) and as white
text on the solid fill (`solid` buttons).

Light mode, measured against `bg-default` (white) and `bg-elevated` (zinc-100):

| Role | Light shade | Text on tint | White on solid | As text on elevated |
|---|---|---|---|---|
| `primary` | 600 | 4.90 ✓ | 5.66 ✓ | 5.15 ✓ |
| `secondary` | 600 | 6.66 ✓ | 7.72 ✓ | 7.02 ✓ |
| `success` | 700 | 4.67 ✓ | 5.36 ✓ | 4.88 ✓ |
| `info` | 700 | 5.06 ✓ | 5.86 ✓ | 5.33 ✓ |
| `warning` | 800 | 6.08 ✓ | 7.09 ✓ | 6.45 ✓ |
| `error` | 700 | 5.04 ✓ | 6.03 ✓ | 5.49 ✓ |

Dark mode, measured against `bg-default` (zinc-900) and `bg-elevated` (zinc-800):

| Role | Dark shade | Text on tint | Ground on solid | As text on elevated |
|---|---|---|---|---|
| `primary` | 400 | 5.42 ✓ | 6.24 ✓ | 5.25 ✓ |
| `secondary` | 400 | 5.75 ✓ | 6.75 ✓ | 5.68 ✓ |
| `success` | 400 | 7.69 ✓ | 9.14 ✓ | 7.68 ✓ |
| `info` | 400 | 6.96 ✓ | 8.13 ✓ | 6.84 ✓ |
| `warning` | 400 | 8.48 ✓ | 10.29 ✓ | 8.65 ✓ |
| `error` | 400 | 5.42 ✓ | 6.19 ✓ | 5.20 ✓ |

Warning needs 800 specifically in light; amber-700 reaches only 4.39:1 on its tint.

`iris-600` was chosen over `iris-500` for the light-mode primary precisely so the table above
has no exception in it: at 500 the accent measures 3.76:1 on its own tint and 4.25:1 on the
page, both under AA. The template this app was forked from shipped a primary that failed as
`variant="subtle"` and documented the failure as a rule to remember. A shade that passes is
cheaper than a rule.

### Surface and text rules

Use the semantic utility, never a numbered scale. `text-gray-900` is a build failure.

| Intent | Token |
|---|---|
| Page background | `bg-default` |
| Sectioned / subtle background | `bg-muted` |
| Cards, modals, popovers | `bg-elevated` |
| Hover state on a surface | `bg-accented` |
| Body copy | `text-default` |
| Headings | `text-highlighted` |
| Secondary / captions | `text-muted` |
| Placeholders, disabled | `text-dimmed` |
| Default border | `border-default` |
| Emphasized border | `border-accented` |

One pairing the token names do not warn you about, and it is a light-mode-only trap:
**secondary text on an elevated surface is `text-toned`, not `text-muted`.** zinc-500 on
zinc-100 is 4.39:1 — under AA — while it clears on the page ground (4.83). A panel or card that
carries its own `bg-elevated` uses `text-toned` (7.02) for captions and stamps. Dark mode has
no equivalent problem: `text-muted` resolves to zinc-400, which reads 6.75 on the page and 5.68
on an elevated surface.

---

## Typography

### Families

| Token | Family | Use |
|---|---|---|
| `font-display` | JetBrains Mono, 500 | `h1`–`h3`, the wordmark, numerals in stat tiles |
| `font-sans` | Inter | Body, UI, labels, everything else |
| `font-mono` | JetBrains Mono, 400 | Code, IDs, keyboard keys, tabular data |

Headings are set in the mono face at weight 500 with `-0.03em` tracking. Display and data are
the same family at two weights, which is the whole typographic argument of the site: a heading
here names a reading, so it is set in the face the readings are set in. Body copy is the one
thing that is not an instrument, so it gets a proportional face.

Two webfonts, not three. A mono display face costs nothing extra because `font-mono` was
already loading it.

### Scale

| Token | Size | Line height |
|---|---|---|
| `text-xs` | 0.75rem | 1.4 |
| `text-sm` | 0.875rem | 1.5 |
| `text-base` | 1rem | 1.65 |
| `text-lg` | 1.125rem | 1.6 |
| `text-xl` | 1.375rem | 1.4 |
| `text-2xl` | 1.75rem | 1.3 |
| `text-3xl` | 2.125rem | 1.2 |
| `text-4xl` | 2.5rem | 1.15 |
| `text-5xl` | 3.125rem | 1.05 |

The top three steps are shorter than the template's, because a monospaced face sets roughly 15%
wider per character: an `h1` of "Frontier Terminal" at 3rem mono overruns a phone before it
says anything. Body copy stays at `text-base` with a 1.65 line height — looser than Tailwind's
default, because the prose pages are for reading. Never set arbitrary sizes (`text-[13px]`).

---

## Space, shape, elevation

- **Spacing:** standard Tailwind scale only — 1, 2, 3, 4, 6, 8, 12, 16, 24. No invented values.
- **Container:** `72rem` max width (`--ui-container`), narrower than the 80rem default. Use
  `<UContainer>` for page shells — it reads this variable; a hardcoded `max-w-*` will not.
- **Radius:** `0.25rem` base (`--ui-radius`). Tight. Nothing is a pill except avatars and badges.
- **Borders:** 1px, `border-default`. Structure comes from borders and spacing, not shadows.
- **Elevation:** dark mode elevates with lighter surfaces (`bg-elevated`), never shadows.
  Light mode may use at most `shadow-sm` on genuinely floating elements (popover, dropdown).

---

## Motion

- Duration `150ms` for state changes, `200ms` for entrances. Nothing slower.
- Easing: `ease-out` entering, `ease-in` leaving.
- Respect `prefers-reduced-motion` — all non-essential motion drops to zero duration.
- No entrance animation on page content. Skeletons over spinners for loads above 300ms.

---

## Component behavior

- **Buttons:** NuxtUI defaults already carry `font-medium` and derive radius from `--ui-radius`
  — no override needed. Primary = solid iris, secondary = outline neutral, destructive = solid
  error. One primary button per view.
- **Cards:** NuxtUI `subtle` variant — elevated surface, hairline ring, no shadow. Padding
  stays on the component default (`p-4`, `p-6` from `sm`), which is already mobile-first.
- **Inputs:** 1px border, `bg-default`. Focus shows a 2px primary ring, never a glow.
- **Focus:** every interactive element has a visible focus-visible ring. Never `outline: none`
  without a replacement.
- **Navigation:** at most **five** things across the header, and they are grouped rather
  than listed. This site has ten pages; ten inline links put `Prices` at the same weight as
  `About` and made the reader scan instead of choose. The six reading pages sit under two
  `UNavigationMenu` triggers named for the questions they answer — **Economics** (prices,
  revenue, demand) and **Operations** (hiring, releases, incidents) — with a one-line
  description per child, because a name alone does not tell a first-time reader what
  "Demand" measures. `Overview` and `Alerts` stay top-level: they are the two entry points.
  Reference pages (`About`, `Data`) live in the footer, where a reader already looks for
  exports and the disclaimer.

  Inline from `md` up — not `sm`, which the grouped header overruns; below that everything
  collapses into a right-side `USlideover` behind an `i-lucide-menu` trigger. The drawer
  carries the *whole* site map including the footer's reference pages, because below `md`
  it is the only navigation affordance there is. Drawer rows are `size="lg"` and `block`,
  left-aligned — full-width rows are the easiest thing on a screen to hit — and each group
  is introduced by a real heading, not a styled `div`. The drawer closes on route change,
  not on click, so redirects close it too. Never let the header wrap to two lines or scroll
  sideways.
- **Links:** inline prose links are `text-primary` **and** underlined (see Accessibility ›
  Contrast). Standalone links in navigation or footers are colour-only by design.
- **Long-form content:** markdown renders through NuxtUI's `Prose*`
  components, which already read the token layer. Two of their defaults contradict this file
  and are overridden in `app.config.ts` under `ui.prose`: `h1`–`h3` drop `font-bold` in favour
  of the display face's own 500, and inline links get a real `underline` instead of a
  hover-only bottom border. Measure is `max-w-2xl` — a reading column, not the full container.
- **Empty states:** one line of `text-muted` explanation plus one action. No illustrations.
- **Alerts:** the description renders at full opacity. NuxtUI dims it to 90%, which takes
  info-700 on its own tint from 5.06:1 to 3.9:1 — below AA — for the one line of an alert that
  carries the actual content.
- **Tables:** `font-mono` for numeric columns, right-aligned. Row separators, not zebra striping.

---

## Accessibility

WCAG 2.2 AA is the floor, not the goal. Two gates enforce it, and they see different
things: `bun run design:check` reads source for patterns a regex can catch, and
`bun run test:a11y` runs axe in a real browser against every public route in **both** color
modes, which is the only way to check a rendered contrast ratio. What neither can judge —
whether a label actually describes its field, whether alt text is meaningful — is on review.

### Contrast

| Intent | Minimum |
|---|---|
| Body copy, labels, any text below `text-xl` | 4.5:1 |
| `text-xl` and up | 3:1 |
| Borders, focus rings, icons that carry meaning | 3:1 |
| Disabled text, decorative rules | none |

The semantic tokens in Color are vetted at both ends of the color-mode switch. A numbered
scale is a build failure precisely because `text-zinc-500` can pass in light mode and fail
in dark — the token layer *is* the contrast guarantee.

**Never convey state by color alone.** Every status pairs its color with an icon or a word.
`<UBadge color="error" icon="i-lucide-x">Failed</UBadge>`, never a bare red dot.

The same rule catches inline links: a link inside a paragraph is **underlined**
(`underline underline-offset-2`), because `text-primary` alone distinguishes it from the
surrounding prose by color only. Links that are already unmistakably links by position —
nav items, footer rows, buttons — don't need it.

### Keyboard and focus

- Every interactive element is reachable and operable by keyboard, in DOM order.
- A visible `focus-visible` ring on everything focusable: 2px, `primary`. Suppressing the
  outline without replacing it is a build failure.
- No positive `tabindex`. `tabindex="-1"` is for programmatic focus targets only.
- Handlers go on a `<button>`, an `<a>`, or a NuxtUI component — never a `<div @click>`.
  That is where roles and keyboard support come from for free.
- A skip link is the first focusable element on the page, pointing at `#main`.

### Structure and labels

- `<html lang>` is set (`nuxt.config.ts` → `app.head.htmlAttrs`).
- One `<h1>` per page. Heading levels never skip.
- Landmarks on every page: `header`, `nav`, `main` (id `main`), `footer`.
- Every image and avatar carries `alt`. Decorative images take `alt=""` — an empty string,
  not a missing attribute.
- Form fields get a visible label through `<UFormField>`. A placeholder is not a label.
- Icon-only buttons need `aria-label`. An icon with no accessible name is an unlabeled
  button to a screen reader.

### Viewport and touch

- **Height:** `min-h-dvh`, never `min-h-screen`. Mobile browser chrome makes `100vh` taller
  than the visible viewport, which hides the bottom of the page under the URL bar.
- **Safe areas:** anything pinned to a viewport edge uses the safe-area utilities
  (`bottom-safe`, `right-safe`) so it clears the iOS home bar and the notch in landscape.
  The `viewport-fit=cover` meta in `nuxt.config.ts` is what makes those insets non-zero.
- **Target size:** two floors, because one number can't serve both a mouse and a thumb.
  - **24x24px everywhere** (WCAG 2.5.8, AA). NuxtUI's `sm` and `md` sizes clear this on
    their own; `size="xs"` does not reliably, so it is desktop-dense-chrome only.
  - **44x44px on coarse pointers.** Apply the `min-touch` utility, which is scoped to
    `@media (pointer: coarse)` — it buys the thumb its target without inflating the
    mouse-driven UI, whose 29-33px controls are the density this system is for.

  Every icon-only control gets `min-touch`; `design:check` enforces that one, because an
  icon-only button is the case that ends up smallest and is hardest to spot by eye.
  Anything pinned to a viewport edge or acting as a primary mobile action gets it too.
- **Motion:** `prefers-reduced-motion` is honored globally in `main.css` (see Motion) — no
  component should re-implement it.

---

## Compiling to NuxtUI v4

`/design-sync` maps the sections above onto the two generated files:

| This file | Destination |
|---|---|
| Primary ramp | `main.css` → `@theme static` → `--color-iris-*` (all 11 shades required) |
| Semantic assignments | `app.config.ts` → `ui.colors` |
| Primary shade choice | `main.css` → `:root`/`.dark` → `--ui-primary` |
| Families + scale | `main.css` → `@theme static` → `--font-*`, `--text-*` |
| Base type rules | `main.css` → `@layer base` |
| Radius, container | `main.css` → `:root` → `--ui-radius`, `--ui-container` |
| Component behavior | `app.config.ts` → per-component `slots` / `defaultVariants` |
| Safe-area utilities | `main.css` → `@utility bottom-safe` / `right-safe` |
| Touch-target floor | `main.css` → `@utility min-touch` |
| Semantic shade choices | `main.css` → `:root`/`.dark` → `--ui-primary` … `--ui-error` |

The Brand mark section compiles through a second, smaller pipeline of its own:

| This file | Destination | Run by |
|---|---|---|
| Brand mark › Construction | `app/components/Brand/Logo.vue` | `/logo-sync` |
| Brand mark › Color roles | `public/favicon.svg`, `apple-touch-icon.png`, `og.png` | `bun run brand:generate` |

Four rules land outside the generated files, because no CSS variable can express them:
`<html lang>` and `viewport-fit=cover` live in `app.head` in `nuxt.config.ts`, the dark-first
fallback lives in `colorMode` there, and the skip link lives in `app/layouts/default.vue`.
`/design-sync` does not own those — leave them alone.

Verify the result at `/design-system` in dev — every token and component state on one page,
in both color modes.
