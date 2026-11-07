<script setup lang="ts">
// The disclosed-revenue axis: what each lab, or the public parent that
// consolidates it, has reported to the SEC, and — for the labs that have
// reported nothing — exactly that. The one number an investor wants most
// has no primary source for most of these companies yet, and this page's
// job is to say so precisely and to be ready the day that changes.

import type { ProspectusData } from '../../shared/utils/terminal-prospectus'
import type { ReportedData, RevenueData } from '../../shared/utils/terminal-types'
import type { ParentsData } from '../../shared/utils/recipe-views'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Revenue',
    summary:
      'Disclosed revenue per frontier lab from SEC XBRL filings. Where a public parent files, we show its consolidated figure or the one segment it reports. Where none does, we say “no audited disclosure”. For a lab that files its own S-1, we show the full statement of operations, commitments, customer concentration, share counts, and risk-factor changes. Press reports of revenue, valuations and funding sit in their own section, never mixed with filed figures.',
  },
})

const [
  { data: revenue, error },
  { data: parents },
  { data: prospectus, error: prospectusError },
  { data: reported, error: reportedError },
] = await Promise.all([
  useFetch<RevenueData>('/api/revenue'),
  useFetch<ParentsData>('/api/parents'),
  useFetch<ProspectusData>('/api/prospectus'),
  useFetch<ReportedData>('/api/reported'),
])

const site = useSiteContext()

useSeo({
  title: 'AI lab revenue from SEC filings',
  description:
    'AI lab revenue disclosed to the SEC, per period with the filing linked, and the rest of a lab’s own S-1: costs, losses, commitments and risk factors.',
  dateModified: revenue.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Frontier AI lab revenue disclosed to the SEC',
      description:
        'Revenue per reporting period for each frontier AI lab, or the public parent that consolidates it, as tagged in its own SEC filings, with the filing behind every value. Press run-rates are excluded.',
      dateModified: revenue.value?.as_of,
      variableMeasured: ['val', 'start', 'end', 'form', 'accession_no'],
      distribution: exportDistribution(site, 'revenue_facts', { fullHistory: true }),
    }),
  ],
})
</script>

<template>
  <TerminalPage
    title="Revenue"
    lede="Revenue from XBRL (the SEC’s tagged financial data) on EDGAR, with each value linked to its filing. What the press reports sits in its own section below."
    :as-of="revenue?.as_of"
    :error="Boolean(error)"
    error-title="Revenue didn’t load"
    error-body="Try reloading in a minute."
  >
    <template v-if="revenue">
      <TerminalPanel
        id="disclosed"
        title="Disclosed revenue, per lab"
        note="Each period once, from the newest filing. Restated values are marked as superseded."
      >
        <TerminalRevenuePanel :revenue="revenue" />
      </TerminalPanel>

      <TerminalProspectusPanel
        v-for="issuer in prospectus?.issuers ?? []"
        :key="issuer.provider"
        :issuer="issuer"
      />
      <UAlert
        v-if="prospectusError"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Registration-statement detail could not be read"
        description="The prospectus endpoint failed to respond. Revenue above is unaffected."
      />

      <TerminalPanel
        v-if="parents?.parents.length"
        id="parents"
        title="What the parents disclose"
        note="Every fact Microsoft and Amazon tag with OpenAI or Anthropic in their newest 10-Q or 10-K. These are the parent’s own figures, never the lab’s revenue or valuation."
        :more="{ label: 'Every quarter, and hyperscaler capex', to: '/exposure' }"
      >
        <TerminalParentFacts :parents="parents" />
      </TerminalPanel>

      <TerminalPanel
        id="reported"
        title="Reported in the press"
        note="Revenue, valuations and funding as news headlines state them. Unaudited, and never mixed with the filed figures above."
      >
        <TerminalReportedPanel v-if="reported" :reported="reported" />
        <UAlert
          v-else-if="reportedError"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Press figures didn’t load"
          description="Try reloading in a minute. The filed revenue above is unaffected."
        />
      </TerminalPanel>

      <TerminalPanel
        id="how"
        title="How a lab gets a number here"
        note="What happens the day a lab files for itself."
      >
        <div class="max-w-2xl space-y-3 text-sm text-default">
          <p>
            We check EDGAR every 30 minutes. That covers the full-text search for new S-1s, the
            filings of each company we track (S-1, 424B4, 10-Q, 10-K, 20-F, and 8-K), and the XBRL
            company facts of each company whose total revenue we show. A new S-1, 424B4, 10-Q, 10-K,
            or 20-F from a company we track always raises an alert.
          </p>
          <p>
            When a lab files for itself, nobody has to do anything. Two full-text searches look for
            S-1s that mention Anthropic or OpenAI. When one comes from a company whose name matches
            the lab, we read its CIK (the SEC’s company ID) from the filing and raise a critical
            alert. From the next check on, we track that company’s filings and XBRL data. Its
            revenue then shows up above as an <em>issuer</em> filing, linked to the filing that
            identified it. A public parent that consolidates a lab is marked <em>parent</em>
            instead, and its numbers are labeled as the parent’s everywhere they appear.
          </p>
          <p>
            Some parents report the lab’s business inside one segment (Google inside Alphabet’s
            Google Cloud). There the numbers are that segment’s, read from the XBRL in each 10-Q and
            10-K on our 6-hour check, and labeled as the segment instead of the lab.
          </p>
        </div>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
