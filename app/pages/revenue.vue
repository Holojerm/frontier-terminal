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
      'Disclosed revenue per frontier lab from SEC XBRL filings: the parent’s consolidated figure or the one segment it reports where a public parent files, and “no audited disclosure” where none does. Press run-rates are excluded.',
  },
})

const { data: revenue, error } = await useFetch<RevenueData>('/api/revenue')

const site = useSiteContext()

useSeo({
  title: 'AI lab revenue from SEC filings',
  description:
    'Revenue OpenAI, Anthropic, Google, xAI, Meta, and Mistral have disclosed to the SEC, per period with the filing linked, and a stated gap where none is audited.',
  dateModified: revenue.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Frontier AI lab revenue disclosed to the SEC',
      description:
        'Revenue per reporting period for each frontier AI lab, or the public parent that consolidates it, as tagged in its own SEC filings, with the filing behind every value. Press run-rates are excluded.',
      dateModified: revenue.value?.as_of,
      variableMeasured: ['val', 'start', 'end', 'form', 'accession_no'],
      distribution: exportDistribution(site, 'revenue_facts'),
    }),
  ],
})
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Revenue</h1>
      <p class="max-w-2xl text-muted">
        Revenue read from EDGAR’s XBRL data, each value linked to its filing. Press run-rates are
        not shown.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Revenue could not be read"
      description="The revenue endpoint failed to respond."
    />

    <template v-else-if="revenue">
      <TerminalPanel
        id="disclosed"
        title="Disclosed revenue, per lab"
        note="Each period once, from the newest filing; restated values are listed as superseded."
      >
        <TerminalRevenuePanel :revenue="revenue" />
      </TerminalPanel>

      <TerminalPanel
        id="how"
        title="How a lab gets a number here"
        note="What happens the day a lab files for itself."
      >
        <div class="max-w-2xl space-y-3 text-sm text-default">
          <p>
            EDGAR is polled every 30 minutes: the S-1 full-text tripwire, one submissions feed per
            whitelisted CIK (S-1, 424B4, 10-Q, 10-K, and 8-K), and XBRL company facts for every
            tagged revenue filer. A new S-1/424B4 or 10-Q/10-K on a whitelisted CIK raises an alert
            by rule.
          </p>
          <p>
            When a lab files for itself, no manual step is needed. Two full-text queries search for
            S-1s mentioning Anthropic and OpenAI. When one is filed by an entity whose name matches
            the lab’s pattern in the source registry, the CIK is read from that filing, a critical
            alert is raised, the CIK joins the whitelist, and the filer’s submissions and XBRL
            company-facts feeds are polled from the next tick. Its reported revenue then appears
            above as an <em>issuer</em> filing, with the resolving filing linked. A public parent
            that consolidates a lab is tagged <em>parent</em> in the registry instead, and its
            series is labeled as the parent’s wherever it appears. Where the parent reports the
            lab’s business inside one segment — Google inside Alphabet’s Google Cloud — the series
            is that segment’s, read from each 10-Q and 10-K’s own XBRL on the six-hourly poll, and
            labeled as the segment, not the lab.
          </p>
        </div>
      </TerminalPanel>
    </template>
  </div>
</template>
