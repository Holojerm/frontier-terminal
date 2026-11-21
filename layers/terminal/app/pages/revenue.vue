<script setup lang="ts">
// The disclosed-revenue axis: what each lab, or the public parent that
// consolidates it, has reported to the SEC, and — for the labs that have
// reported nothing — exactly that. The one number an investor wants most
// has no primary source for most of these companies yet, and this page's
// job is to say so precisely and to be ready the day that changes.

const watchlist = useWatchlist()

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Revenue',
    summary:
      'Disclosed revenue per frontier lab from SEC XBRL filings. Where a public parent files, we show its consolidated figure or the one segment it reports. Where none does, we say “no audited disclosure”. For a lab that files its own S-1, we show the full statement of operations, commitments, customer concentration, share counts, and risk-factor changes. Press reports of revenue, valuations and funding sit in their own tab, never mixed with filed figures.',
  },
})

const [
  { data: revenue, error },
  { data: prospectus, error: prospectusError },
  { data: reported, error: reportedError },
] = await Promise.all([
  useFetch<RevenueData>('/api/revenue'),
  useFetch<ProspectusData>('/api/prospectus'),
  useFetch<ReportedData>('/api/reported'),
])

// The press tab is apart so its unaudited figures never sit beside a filed
// one. What a parent tags about its lab is on /exposure, every quarter of it.
const tabs = computed(() => [
  { value: 'filed', label: 'Filed' },
  { value: 'press', label: 'Press', badge: reported.value?.series.length || undefined },
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
    lede="Revenue from XBRL (the SEC’s tagged financial data) on EDGAR, with each value linked to its filing. What the press reports has a tab of its own."
    :as-of="revenue?.as_of"
    :error="Boolean(error)"
    error-title="Revenue didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalTabs v-if="revenue" :tabs="tabs">
      <template #filed>
        <TerminalPanel
          id="disclosed"
          title="Disclosed revenue, per lab"
          note="Each period once, from the newest filing. Restated values are marked as superseded."
          :more="{
            label: 'What Microsoft and Amazon tag on OpenAI and Anthropic',
            to: '/exposure',
          }"
        >
          <TerminalRevenuePanel :revenue="revenue" />
        </TerminalPanel>

        <TerminalProspectusPanel
          v-for="issuer in watchlist.first(prospectus?.issuers ?? [], (i) => i.provider)"
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
      </template>

      <template #press>
        <TerminalPanel
          id="reported"
          title="Reported in the press"
          note="Revenue, valuations and funding as news headlines state them. Unaudited, and never mixed with the filed figures."
          :more="{ label: 'How these reports compare with filings', to: '/ground-truth' }"
        >
          <TerminalReportedPanel v-if="reported" :reported="reported" />
          <UAlert
            v-else-if="reportedError"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Press figures didn’t load"
            description="Try reloading in a minute. The filed revenue is unaffected."
          />
        </TerminalPanel>
      </template>
    </TerminalTabs>
  </TerminalPage>
</template>
