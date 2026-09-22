<script setup lang="ts">
// The disclosed-revenue axis: what each lab, or the public parent that
// consolidates it, has reported to the SEC, and — for the labs that have
// reported nothing — exactly that. The one number an investor wants most
// has no primary source for most of these companies yet, and this page's
// job is to say so precisely and to be ready the day that changes.

import type { RevenueData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Revenue',
    summary:
      'Disclosed revenue per frontier lab from SEC XBRL company facts — the parent’s consolidated figure where a public parent files, and an explicit “no audited disclosure” where none does. Press run-rates are deliberately not shown.',
  },
})

const { data: revenue, error } = await useFetch<RevenueData>('/api/revenue')

useSeo({
  title: 'Revenue',
  description:
    'Revenue the frontier AI labs have actually disclosed to the SEC, per reported period with the filing linked, and an honest blank where no audited figure exists.',
  dateModified: revenue.value?.as_of,
})
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Revenue</h1>
      <p class="max-w-2xl text-muted">
        What the labs have disclosed, read from EDGAR’s XBRL company facts and linked to the filing
        that reported each value. Where no lab or parent has filed, the panel says so — a
        press-reported run-rate is a claim about a number, not the number, and is deliberately not
        shown.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Revenue could not be read"
      description="The revenue endpoint failed to respond. Nothing is shown rather than a stale or inferred number."
    />

    <template v-else-if="revenue">
      <TerminalPanel
        id="disclosed"
        title="Disclosed revenue, per lab"
        note="Each reported period once, from the newest filing that reported it; a value a later filing restated is listed as superseded, never silently overwritten."
      >
        <TerminalRevenuePanel :revenue="revenue" />
      </TerminalPanel>

      <TerminalPanel
        id="how"
        title="How a lab gets a number here"
        note="The pipeline is wired for the public-flip moment; the tag is the only thing missing."
      >
        <div class="max-w-2xl space-y-3 text-sm text-default">
          <p>
            The EDGAR poll runs every 30 minutes over the full-text S-1 tripwire, one submissions
            feed per whitelisted CIK (S-1, 424B4, 10-Q, 10-K and 8-K forms), and XBRL company facts
            for every tagged revenue filer. A new S-1/424B4 or 10-Q/10-K on a whitelisted CIK alerts
            deterministically, with no model in the loop.
          </p>
          <p>
            When a lab files for itself, nothing has to be typed. Two full-text queries watch for
            S-1s mentioning Anthropic and OpenAI; the moment one is filed by an entity whose name
            matches the lab’s pattern in the source registry, the CIK is read off that filing, a
            critical alert fires, the CIK joins the whitelist, and the filer’s submissions and XBRL
            company-facts feeds are derived and polled from the next tick. Its reported revenue then
            appears above as an <em>issuer</em> filing, with the resolving filing linked. A public
            parent that consolidates a lab is tagged as a <em>parent</em> in the registry instead,
            and its series is labelled as the parent’s wherever it is shown.
          </p>
        </div>
      </TerminalPanel>
    </template>
  </div>
</template>
