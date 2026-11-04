<script setup lang="ts">
// What the terminal is, the one rule every number obeys, where the caveats
// live, and how stale a number can be. The coverage endpoint is read for
// the page's dateModified only.

import manifest from '~~/fleet.json'

import { CORRECTIONS } from '../../shared/utils/corrections'
import type { CoverageData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'monthly',
    priority: '0.5',
    title: 'About',
    summary:
      'What Frontier Terminal tracks, who runs it, the provenance rule every number follows, per-source caveats, data latency, the corrections log, the data license, and where the code lives.',
  },
})

const config = useRuntimeConfig()
const repo = manifest.links.github
const mcpUrl = `${config.public.appUrl.replace(/\/+$/, '')}/mcp`

const { data: coverage } = await useFetch<CoverageData>('/api/coverage')

useSeo({
  title: 'About',
  description:
    'What Frontier Terminal tracks, who runs it, the provenance rule behind every number, per-source caveats, data latency, and every correction made.',
  dateModified: coverage.value?.as_of,
})
</script>

<template>
  <TerminalPage title="About" :lede="config.public.appDescription" narrow>
    <TerminalPanel id="what" title="What this is">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          A free, public, read-only terminal for equity analysts who cover AI infrastructure through
          the frontier-lab IPO wave. We track nine frontier model providers (OpenAI, Anthropic,
          Google, xAI, Meta, Mistral, DeepSeek, Alibaba’s Qwen, and Moonshot AI’s Kimi). For each
          one we follow API prices, hiring (including the roles that build data centers and power),
          OpenRouter demand share and the spend share it implies at list price, status-page
          incidents, misalignment disclosures, SEC filings, and disclosed revenue.
        </p>
        <p>
          Most of these labs are still private. Until one files to go public, hiring, prices, and
          usage are the best data there is. We check EDGAR for the first public filing, and the
          revenue panel fills in from it. Until then the panel says “no audited disclosure” instead
          of showing a run-rate.
        </p>
        <p>
          We check every source on a schedule, keep a copy of each page we read, and record what
          changed since the last check. Pages show what each source says now and what has changed.
          An alert only ever describes those recorded changes.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="author" title="Who runs it">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          Built and run by
          <a
            href="https://linkedin.com/in/jeremy-ettlinger"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary underline underline-offset-2"
            >Jeremy Ettlinger</a
          >, a software engineer in New York who builds data platforms for institutional finance,
          previously at FactSet. Frontier Terminal is an independent project. It isn’t affiliated
          with any lab, bank, or employer, and no one pays for it.
        </p>
        <p class="text-sm text-muted">
          Jeremy follows a written trading policy. Each thesis shows his position. He doesn’t trade
          a covered company within 48 hours after a notable or critical alert on it, holds positions
          at least 30 days, doesn’t trade against a published thesis before revising it, and doesn’t
          take IPO allocations in a covered company. The full policy is available on request. Write
          to
          <a
            href="mailto:contact@frontierterm.com"
            class="text-primary underline underline-offset-2"
            >contact@frontierterm.com</a
          >.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="provenance" title="The provenance rule">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          Every number links to the page we read it from and shows when we read it (UTC). If we
          can’t fetch it again, we don’t store it.
        </p>
        <p>
          When a source publishes no figure, the page says so. OpenAI’s catalog page doesn’t list
          prices. Meta has no public hiring feed. OpenRouter’s price list is a third party’s copy of
          vendor prices, so we only use it as a cross-check. Its usage rankings are one aggregator’s
          traffic, so we don’t treat them as market share. Timestamps under a day old show as
          relative times. The full timestamp is in the hover text and the page markup.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="caveats" title="Caveats">
      <p class="max-w-2xl text-sm text-default">
        Each source shows the caveat from our audit, in the audit’s own words. Each source we chose
        not to use shows why. Both are in the
        <NuxtLink to="/data#coverage" class="text-primary underline underline-offset-2"
          >coverage table</NuxtLink
        >, behind the info button on each row.
      </p>
    </TerminalPanel>

    <TerminalPanel id="latency" title="Data latency">
      <dl class="grid max-w-2xl gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt class="text-muted">SEC filings</dt>
        <dd class="text-default">
          We check EDGAR every 30 minutes. That covers the full-text search for new S-1s, the
          filings of each company we track, and XBRL (the SEC’s tagged financial data) for each
          company that reports revenue. Filings are where minutes matter.
        </dd>
        <dt class="text-muted">Pricing and hiring</dt>
        <dd class="text-default">
          We also check every source, EDGAR included, every 6 hours. That way a stuck feed still
          gets picked up.
        </dd>
        <dt class="text-muted">Pages</dt>
        <dd class="text-default">
          Pages refresh within five minutes of a new check. Each page shows the time of the check it
          reflects.
        </dd>
        <dt class="text-muted">Against the press</dt>
        <dd class="text-default">
          The
          <NuxtLink to="/alerts?tab=track-record" class="text-primary underline underline-offset-2"
            >track record</NuxtLink
          >
          times each notable or critical alert against the first press report and the lab’s own
          post. It shows the alerts where the press was first too.
        </dd>
        <dt class="text-muted">Confidential filings</dt>
        <dd class="text-default">
          A confidential draft registration doesn’t appear on EDGAR until the company makes it
          public. We report the public filing when it appears. We can’t see the draft.
        </dd>
      </dl>
    </TerminalPanel>

    <TerminalPanel
      id="corrections"
      title="Corrections"
      note="Every fix that changed or restored a published number. History is never rewritten."
    >
      <ul class="max-w-2xl space-y-3 text-sm">
        <li v-for="c in CORRECTIONS" :key="c.on + c.area">
          <p class="text-muted">
            <span class="font-mono">{{ c.on }}</span> · {{ c.area }}
          </p>
          <p class="text-default">
            {{ c.what }}
            <a
              :href="c.fix"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary underline underline-offset-2"
              >The fix</a
            >
          </p>
        </li>
      </ul>
    </TerminalPanel>

    <TerminalPanel id="disclaimer" title="Not investment advice">
      <p class="max-w-2xl text-sm text-default">
        This isn’t investment advice. We report what public sources say and when they said it.
        Nothing here is personalized or a solicitation. Judged alerts are a model’s reading of the
        changes we record, and they’re labeled that way.
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
          <span class="text-muted"> (MIT). Every source and parser is in the repo.</span>
        </li>
        <li>
          <NuxtLink to="/data" class="text-primary underline underline-offset-2"
            >Bulk exports</NuxtLink
          >
          <span class="text-muted"> of every table, as CSV or JSON.</span>
        </li>
        <li>
          <NuxtLink to="/license" class="text-primary underline underline-offset-2"
            >License</NuxtLink
          >
          <span class="text-muted">
            for our data. The last 90 days are CC BY 4.0. Older data is CC BY-NC 4.0, except what we
            published before 2026-11-04.</span
          >
        </li>
        <li>
          <NuxtLink to="/contact" class="text-primary underline underline-offset-2"
            >Commercial licensing</NuxtLink
          >
          <span class="text-muted">
            for commercial use of the full history, your own terms, a dependable feed, or new
            coverage.</span
          >
        </li>
        <li>
          <NuxtLink to="/alerts.xml" external class="text-primary underline underline-offset-2">
            Atom feed
          </NuxtLink>
          <span class="text-muted"> of notable and critical alerts.</span>
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
          Point Claude, ChatGPT, or any MCP client at the endpoint below. Each tool returns the same
          data as the matching API route, with every source URL and fetch time. It shares the site’s
          cache and the same rate limit per IP address.
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
