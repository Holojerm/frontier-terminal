<script setup lang="ts">
// What the terminal is, the one rule every number obeys, where the caveats
// live, and how stale a number can be. The coverage endpoint is read for
// the page's dateModified only.

import manifest from '~~/fleet.json'

import type { CoverageData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'monthly',
    priority: '0.5',
    title: 'About',
    summary:
      'What Frontier Terminal tracks, the provenance rule every number follows, per-source caveats, data latency, and where the code lives.',
  },
})

const config = useRuntimeConfig()
const repo = manifest.links.github
const mcpUrl = `${config.public.appUrl.replace(/\/+$/, '')}/mcp`

const { data: coverage } = await useFetch<CoverageData>('/api/coverage')

useSeo({
  title: 'About',
  description:
    'What Frontier Terminal tracks, the provenance rule behind every number, per-source caveats, data latency, and the open-source repo.',
  dateModified: coverage.value?.as_of,
})
</script>

<template>
  <TerminalPage title="About" :lede="config.public.appDescription" narrow>
    <TerminalPanel id="what" title="What this is">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          A free, public, read-only terminal for equity analysts covering AI infrastructure through
          the frontier-lab IPO wave. It tracks six frontier model providers — OpenAI, Anthropic,
          Google, xAI, Meta, Mistral — on seven axes: API prices, hiring (and the
          physical-infrastructure buildout within it), OpenRouter demand share and the spend share
          it implies at list price, status-page incidents, misalignment disclosures, SEC filings,
          and disclosed revenue. Until a lab lists, the private-company signals carry the weight.
          EDGAR is polled for the first public filing, and the revenue panel fills from it; until
          then it shows “no audited disclosure”, not a run-rate.
        </p>
        <p>
          Every source is polled on a schedule, snapshotted whole, parsed deterministically, and
          diffed against its previous state. Pages show the current state and the change log; an
          alert is a claim about change rows only.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="provenance" title="The provenance rule">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          <strong class="text-highlighted"
            >No number without a source URL and a fetch timestamp.</strong
          >
          Every figure links to the exact URL it was read from and carries the UTC instant it was
          fetched. A datum that cannot be re-fetched is a claim, not data, and is not stored.
        </p>
        <p>
          Where a source publishes no figure, the page says so: OpenAI’s catalog page prints no
          prices, Google has no public hiring feed, OpenRouter’s price list is a third-party
          restatement kept as a cross-check, and its usage rankings are one aggregator’s traffic,
          not market share. Timestamps under a day old read as relative; the exact value is in the
          hover text and the page markup.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="caveats" title="Caveats">
      <p class="max-w-2xl text-sm text-default">
        Each source carries the audit’s caveat in its own words; each deliberate cut carries its
        reason. Both are read from the source registry at request time and listed on the
        <NuxtLink to="/data#coverage" class="text-primary underline underline-offset-2"
          >coverage table</NuxtLink
        >, behind the info control on each row.
      </p>
    </TerminalPanel>

    <TerminalPanel id="latency" title="Data latency">
      <dl class="grid max-w-2xl gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt class="text-muted">SEC filings</dt>
        <dd class="text-default">
          The EDGAR feeds — the S-1 full-text tripwire, one submissions feed per whitelisted CIK,
          and XBRL company facts for each tagged revenue filer — are polled every 30 minutes, the
          one axis where latency matters.
        </dd>
        <dt class="text-muted">Pricing and hiring</dt>
        <dd class="text-default">
          Every source, EDGAR included, is polled every 6 hours. The overlap is deliberate: a
          stalled feed stays covered.
        </dd>
        <dt class="text-muted">Pages</dt>
        <dd class="text-default">
          Each payload is cached for five minutes, keyed by the newest poll tick, so a new poll
          invalidates the cache. Each page prints the tick it reflects.
        </dd>
        <dt class="text-muted">Confidential filings</dt>
        <dd class="text-default">
          A confidential draft registration does not appear on EDGAR until it is made public. The
          terminal reports the public filing when it appears; the draft itself is not visible.
        </dd>
      </dl>
    </TerminalPanel>

    <TerminalPanel id="disclaimer" title="Not investment advice">
      <p class="max-w-2xl text-sm text-default">
        This is a data terminal, not a recommendation. It reports what public sources say and when
        they said it. Nothing here is personalized or a solicitation. Judged alerts are a model’s
        reading of change rows and are labeled as such.
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
          <span class="text-muted"> — notable and critical alerts.</span>
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
          Point Claude, ChatGPT, or any MCP client at the endpoint below. Each tool returns the
          matching API payload with provenance intact, through the site’s cache and per-address rate
          limit.
        </p>
        <pre
          class="overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default"
        ><code>{{ mcpUrl }}</code></pre>
        <pre
          class="overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default"
        ><code>claude mcp add --transport http frontier-terminal {{ mcpUrl }}</code></pre>
        <p class="text-muted">
          Tools: describe, get_overview, get_prices, get_price_history, get_hiring,
          get_hiring_history, get_releases, get_incidents, get_rankings, get_alerts, get_alert,
          get_coverage, get_status. Start with <span class="font-mono">describe</span>.
        </p>
      </div>
    </TerminalPanel>
  </TerminalPage>
</template>
