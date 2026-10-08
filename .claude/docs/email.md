# Email

How an email is written (Maizzle templates, compiled at build time, filled in with Mustache). This app sends one email — the ops alert digest (`server/utils/ops-digest.ts`, mailed from `server/utils/ops-mail.ts` through the `send_email` binding) — so the pipeline is the template's, trimmed to that one template.

> **Load this when:** touching `emails/`, `server/utils/ops-digest.ts`, or adding a second outbound email.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Writing an email

Markup lives in [`emails/`](../../emails), written in [Maizzle 6](https://maizzle.com/docs)
(Vue single-file templates, Tailwind 4). **Maizzle runs at build time only** — it needs Node, Vite
and a CSS toolchain, so it is a devDependency and nothing from it reaches the Worker.
`bun run email:build` compiles every template to `server/emails/generated.ts`, a committed
module of `{ [name]: { html, text } }` strings that still contain `{{mustache}}` tags.
At send time `renderEmail(name, data)` in
[`server/utils/render-email.ts`](../../server/utils/render-email.ts) fills them in.

```
emails/
  templates/ops-digest.vue  the HTML — content only
  templates/ops-digest.txt  the plain-text alternative, same tags
  components/Email*.vue     the chrome: EmailLayout, EmailParagraph, EmailButton
  samples.ts                sample data per template — previews and tests
  theme.generated.css       GENERATED from DESIGN.md — see Branding
  maizzle.config.ts
server/emails/generated.ts  GENERATED — commit it
```

**To add an email:**

1. `emails/templates/<name>.vue` — wrap content in `<EmailLayout heading="…">`; paragraphs in
   `<EmailParagraph>`, a call to action in `<EmailButton href="{{appUrl}}/…">`, small print in
   `<template #footnote>`. Every `{{tag}}` in the body goes inside `<Raw>…</Raw>` (see below).
2. `emails/templates/<name>.txt` — the plain-text part, same tags, written by hand. Links read
   `Label: url`; the file ends with `{{appUrl}}`.
3. `emails/samples.ts` — an entry named `<name>` with realistic data.
4. `bun run email:build`, then `bun run email:dev` and look at it.
5. A function that returns `{ subject, html, text }` by calling `renderEmail('<name>', data)`
   (`server/utils/render-email.ts`) — the subject, and turning a `Date` or an enum into the
   strings the template reads, stay in TypeScript (see `server/utils/ops-digest.ts`). Add its
   action URL to `ACTION_URL` in `test/emails.test.ts`, plus a test for anything specific to it.
   That file already proves a template renders, leaves no `{{` behind, escapes hostile data,
   and that the text carries the action URL.

`bun run email:check` (in `bun run ci`) rebuilds in memory and fails if the committed module
differs; it needs no browser, so it runs in the Workers Builds image. It also fails the build when:
a `.vue` has no `.txt` (or the reverse); the HTML and the text read different fields (a field
only the HTML needs — a tone flag, a link target — is declared in the `.txt` as
`{{! html-only: a, b }}`); or Vue warned while rendering.

### Mustache rules

- **`{{name}}` escapes, `{{{name}}}` does not.** Mustache never sees an untrusted *template* —
  they are ours, compiled in CI. It only sees untrusted *data* (an OAuth display name, a feedback
  message, an error string), and the escaping is what makes that safe. `renderEmail` escapes
  only `& < > " '` — Mustache's stock escape also encodes `/` and `=`, which mangles every href.
- **Triple braces only for markup this code built itself**, never a value that began outside
  it, and each use needs a comment naming where the value comes from. There are none today.
- **Text renders with escaping off** — there is no markup to break out of, and `&amp;` in a
  plain-text inbox is a bug.
- **Wrap every tag in `<Raw>` in templates** — `Hi <Raw>{{name}}</Raw>` — or Vue evaluates it and
  renders it blank (the build fails on the warning). Tags inside an *attribute*
  (`href="{{url}}"`, `heading="…"`) are literal strings and need no wrapper. Always write
  `<Raw>…</Raw>`, never self-closed `<Raw :content="x" />`: Maizzle's pass matches up to the
  next `</Raw>` and a self-closed one swallows the rest of the file.
- **Sections** are `{{#list}}…{{/list}}` (loop, or "if truthy") and `{{^x}}…{{/x}}` ("if not").
  A value is truthy when it is non-empty and not `0`/`null`/`false`. A color that depends on
  runtime data cannot be inlined at build time, so the template carries one copy per choice —
  see the tone bar in `emails/templates/ops-digest.vue`.
- **Don't hand-format `emails/**/*.vue`** — it is excluded from `oxfmt`, which splits
  `</Raw>` across lines and breaks Maizzle's extraction.

### Plain text

Each email has a hand-written `.txt`, not Maizzle's `plaintext` feature. Its output is derived
from the HTML after CSS inlining and merges adjacent paragraphs onto one line, renders links as
`label\n\nurl`, and — the deciding case — turns a `{{#rows}}` loop into one run-on line, because
section tags are text to it and not the standalone lines Mustache needs to remove them. A `.txt`
is the format the ops digest's bullets and `…and N more` line need, and it is the one thing a
reviewer can read without compiling anything.

### Branding

Email clients support neither CSS variables nor `oklch`, so the email's Tailwind theme is
**generated** from DESIGN.md, not hand-written: `bun run brand:generate` resolves the `email-*`
roles in DESIGN.md › Brand mark › Color roles to hex (using the Chromium it already drives for
the icons) and writes `emails/theme.generated.css` (colors and font stacks) and
`public/email-logo.png` (cut from `Logo.vue` — PNG because Gmail drops SVG). `brand:check`
fingerprints the inputs. Emails reference the logo as `{{appUrl}}/email-logo.png`, `alt` = the
app name. **A rebrand runs `bun run brand:generate` then `bun run email:build`** and
gets on-brand email with no template change; `design:check` scans `app/` only, so hex in emails is
fine. Colors come from the theme (`text-ink`, `bg-accent`, `border-rule`); never type a hex.

### Preview

- `bun run email:dev` — Maizzle's dev server (it prints its URL). Lists every template, filled
  from `emails/samples.ts`, live-reloading as you edit.
- `bun run email:preview [dir]` — writes every email as the Worker would send it (compiled
  module + Mustache, HTML and text) to `dir` (default `.email-preview/`).

### Ops digest

`server/utils/ops-digest.ts` renders `emails/templates/ops-digest.*` and imports nothing from
the transactional stack except `render-email.ts` — a deployment with no transactional email keeps their alerts, so keep it that way.

### Bun workspaces

A root with `workspaces` makes bun install packages in an isolated layout, and `email:build`
then cannot resolve Maizzle's own `@maizzle/tailwindcss` from `emails/`. This repo has no
workspaces; if one is added, add `@maizzle/tailwindcss` as a direct devDependency of the root.

