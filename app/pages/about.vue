<script setup lang="ts">
// What the terminal is, the one rule every number obeys, the caveats in the
// audit's own words, and how stale a number can be. The caveats are read
// from the coverage endpoint so this page and sources.yaml cannot disagree.

import manifest from '~~/fleet.json'

import type { CoverageData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'monthly',
    priority: '0.5',
    title: 'About',
    summary:
      'What Frontier Terminal tracks, the provenance rule every number obeys, the disclosed caveats per source, data latency, and where the code lives.',
  },
})

useSeo({
  title: 'About',
  description:
    'What Frontier Terminal is, the provenance rule behind every number, each source’s disclosed caveat, how stale a figure can be, and the open-source repo.',
})

const config = useRuntimeConfig()
const repo = manifest.links.github
const mcpUrl = `${config.public.appUrl.replace(/\/+$/, '')}/mcp`

const { data: coverage } = await useFetch<CoverageData>('/api/coverage')

const caveats = computed(() => (coverage.value?.sources ?? []).filter((s) => s.caveat))
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">About</h1>
      <p class="max-w-2xl text-muted">{{ config.public.appDescription }}</p>
    </header>

    <TerminalPanel id="what" title="What this is">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          A free, public, read-only terminal for an equity analyst covering the AI-infrastructure
          complex into the frontier-lab IPO wave. It watches the four frontier model providers —
          OpenAI, Anthropic, Google, xAI — on three axes: the API price list, the hiring board, and
          SEC filings. The first two are the private-company signals that carry the weight before
          any lab trades; EDGAR is the tripwire for the moment one does.
        </p>
        <p>
          Every source is polled on a schedule, snapshotted whole, parsed deterministically, and
          diffed against its previous state. What you read here is the current state plus the change
          log; an alert is a claim about change rows and nothing else.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="provenance" title="The provenance rule">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          <strong class="text-highlighted"
            >No number without a source URL and a fetch timestamp.</strong
          >
          Every figure on every page links to the exact URL it was read from and carries the UTC
          instant it was fetched. A datum you cannot re-fetch is a claim, not data, and the store
          refuses to hold one.
        </p>
        <p>
          Where a source does not publish a figure, the terminal says so instead of guessing:
          OpenAI’s catalog page prints no prices, Google has no public hiring feed, and OpenRouter
          is a third-party restatement held out as a cross-check. Timestamps read relative inside a
          day; the exact value is one hover away and in the page markup.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel
      id="caveats"
      title="Caveats"
      note="In the audit’s own words, read from the source registry at request time."
    >
      <ul v-if="caveats.length" class="max-w-2xl space-y-3">
        <li v-for="s in caveats" :key="s.source_id" class="space-y-1 text-sm">
          <a
            :href="s.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-highlighted underline underline-offset-2"
            >{{ s.label }}</a
          >
          <p class="text-default">{{ s.caveat }}</p>
        </li>
        <li v-for="cut in coverage?.cuts ?? []" :key="cut.id" class="space-y-1 text-sm">
          <span class="font-mono text-highlighted">{{ cut.id }}</span>
          <p class="text-default">{{ cut.verdict }}. {{ cut.reason }}</p>
        </li>
      </ul>
      <p v-else class="text-sm text-muted">The source registry could not be read.</p>
    </TerminalPanel>

    <TerminalPanel id="latency" title="Data latency">
      <dl class="grid max-w-2xl gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt class="text-muted">SEC filings</dt>
        <dd class="text-default">
          The two EDGAR feeds are polled every 30 minutes — the tripwire, the one axis where latency
          is worth polling for.
        </dd>
        <dt class="text-muted">Pricing and hiring</dt>
        <dd class="text-default">
          Every source, EDGAR included, is surveyed every 6 hours. The overlap is deliberate: a
          stalled tripwire goes covered, not blind.
        </dd>
        <dt class="text-muted">Pages</dt>
        <dd class="text-default">
          Each payload is cached for five minutes, keyed by the newest poll tick, so a poll
          invalidates the cache by construction. The tick a page reflects is printed on it.
        </dd>
        <dt class="text-muted">Confidential filings</dt>
        <dd class="text-default">
          A confidential draft registration is structurally invisible on EDGAR until it flips
          public. The terminal catches the flip and says so; it cannot see the draft.
        </dd>
      </dl>
    </TerminalPanel>

    <TerminalPanel id="disclaimer" title="Not investment advice">
      <p class="max-w-2xl text-sm text-default">
        This is a data terminal, not a recommendation. It reports what public sources say and when
        they said it. Nothing here is personalised, nothing here is a solicitation, and the judged
        alerts are a model’s reading of change rows, labelled as such.
      </p>
    </TerminalPanel>

    <TerminalPanel id="code" title="Code and data">
      <ul class="space-y-1 text-sm">
        <li>
          <a
            :href="repo"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary underline underline-offset-2"
          >
            Source on GitHub
          </a>
          <span class="text-muted">
            — MIT licensed; the source registry and every parser are in the repo.</span
          >
        </li>
        <li>
          <NuxtLink to="/data" class="text-primary underline underline-offset-2"
            >Bulk exports</NuxtLink
          >
          <span class="text-muted"> — every table as CSV or JSON.</span>
        </li>
        <li>
          <NuxtLink to="/alerts.xml" external class="text-primary underline underline-offset-2">
            Atom feed
          </NuxtLink>
          <span class="text-muted"> — alerts, for a reader that wants to be told.</span>
        </li>
      </ul>
    </TerminalPanel>

    <TerminalPanel
      id="agents"
      title="Connect an agent"
      note="The same queries the pages run, as MCP tools. Read-only, no account, no key."
    >
      <div class="max-w-2xl space-y-3 text-sm">
        <p class="text-default">
          Point Claude, ChatGPT or any MCP client at the endpoint below. Each tool returns the
          matching API payload with its provenance intact, through the same cache and the same
          per-address rate limit as the site.
        </p>
        <pre
          class="overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default"
        ><code>{{ mcpUrl }}</code></pre>
        <pre
          class="overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default"
        ><code>claude mcp add --transport http frontier-terminal {{ mcpUrl }}</code></pre>
        <p class="text-muted">
          Tools: describe, get_overview, get_prices, get_hiring, get_alerts, get_alert,
          get_coverage, get_status. Start with <span class="font-mono">describe</span>.
        </p>
      </div>
    </TerminalPanel>
  </div>
</template>
