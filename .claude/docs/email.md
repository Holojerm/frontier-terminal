# Email

How an email is written (Maizzle templates, compiled at build time, filled in with Mustache). This app sends two email templates: the weekly thesis digest (`layers/terminal/server/theses/digest.ts`) and the subscription confirmation. The owner's digest and the plain press brief go through the `OWNER_EMAIL` `send_email` binding (`layers/terminal/server/utils/owner-mail.ts`). Subscribers' mail goes through Resend (see Subscribers below). It sends no alerts: the fleet dashboard is the only alert sender. The pipeline is the template's, trimmed to the thesis digest.

> **Load this when:** touching `emails/`, `layers/terminal/server/theses/digest.ts`, or adding a second outbound email.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## Writing an email

Markup lives in [`emails/`](../../emails), written in [Maizzle 6](https://maizzle.com/docs)
(Vue single-file templates, Tailwind 4). **Maizzle runs at build time only** — it needs Node, Vite
and a CSS toolchain, so it is a devDependency and nothing from it reaches the Worker.
`bun run email:build` compiles every template to `server/emails/generated.ts`, a gitignored
module of `{ [name]: { html, text } }` strings that still contain `{{mustache}}` tags.
At send time `renderEmail(name, data)` in
[`server/utils/render-email.ts`](../../server/utils/render-email.ts) fills them in.

```
emails/
  templates/thesis-digest.vue  the weekly thesis digest HTML — content only
  templates/thesis-digest.txt  the plain-text alternative, same tags
  components/Email*.vue     the chrome: EmailLayout, EmailParagraph, EmailButton
  samples.ts                sample data per template — previews and tests
  theme.generated.css       GENERATED from DESIGN.md — see Branding
  maizzle.config.ts
server/emails/generated.ts  GENERATED at install — never commit it
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
   strings the template reads, stay in TypeScript (see `layers/terminal/server/theses/digest.ts`). Add its
   action URL to `ACTION_URL` in `test/emails.test.ts`, plus a test for anything specific to it.
   That file already proves a template renders, leaves no `{{` behind, escapes hostile data,
   and that the text carries the action URL.

`postinstall` and `bun run ci` both run `email:build`, so the module is always rebuilt from the
templates on the machine that builds the Worker — there is no committed copy to go stale (one
used to fail every Maizzle or Tailwind Dependabot bump). The build fails when:
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
  see the tone bar in `emails/templates/thesis-digest.vue`.
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

### Bun workspaces

A root with `workspaces` makes bun install packages in an isolated layout, and `email:build`
then cannot resolve Maizzle's own `@maizzle/tailwindcss` from `emails/`. This repo has no
workspaces; if one is added, add `@maizzle/tailwindcss` as a direct devDependency of the root.

---

## Subscribers

Public digest subscriptions, off until `NUXT_RESEND_API_KEY` (secret) and
`NUXT_SUBSCRIBE_EMAIL_FROM` (var, an address on a domain verified in Resend) are both set.
Unset, there is no form, `/api/subscribe/*` and `/digest` answer 404, and the Monday task skips
the fan-out. The owner's digest never depends on it.

- **Table.** `subscribers` (`layers/terminal/server/db/schema.ts`): pending, confirmed or
  unsubscribed. The confirm token is stored hashed; the unsubscribe token is an HMAC of the row
  id under the instance salt, so it is not stored and never expires. Pending rows that never
  confirm are deleted after 30 days by the digest task. Unsubscribed rows stay, marked.
- **Flow.** `POST /api/subscribe` (honeypot, 5 per 10 min per IP, 300 per hour overall, the
  same answer for any address) mails `/subscribe/confirm?t=…`, a page that POSTs the token on
  load, so a link scanner that only fetches pages confirms nobody. Each digest carries
  `/subscribe/unsubscribe?u=…` in the body and `List-Unsubscribe` plus
  `List-Unsubscribe-Post` headers pointing at `POST /api/subscribe/unsubscribe?u=…`. No route
  changes state on GET, and none uses DELETE.
- **Digest copy.** `buildThesisDigest({ audience: 'public' })` drops the owner's confirmation
  queue and cron footnote. The subscriber copy is rendered once with a placeholder for the
  unsubscribe link, then filled per recipient. `/digest` renders the same copy with no link.
- **Fan-out.** `sendSubscriberDigest` (`layers/terminal/server/utils/subscriber-mail.ts`): up to 2,500
  recipients a run, 50 per Resend batch call. A row is marked (`last_digest_at`) only after its
  batch is accepted and is skipped for 6 days, so re-running `theses:digest` mails only the ones
  that missed. A failed batch throws, which spools `task_failed` for the fleet dashboard.
