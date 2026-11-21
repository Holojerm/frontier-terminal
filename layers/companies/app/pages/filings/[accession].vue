<script setup lang="ts">
// One revenue-bearing SEC filing at a citable URL: every period it reported, the value,
// the tag or statement row it came from, and whether a later filing restated it, with the
// EDGAR link on every line. Regrouped from the cached /api/revenue payload
// (layers/companies/shared/utils/terminal-filings.ts).

const figures = useFigures()

// Inert for a dynamic route (server/routes/sitemap.xml.get.ts enumerates the filings from
// the revenue payload), but the seo gate checks every page.
definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.6',
    title: 'Filing',
    summary:
      'One SEC filing that reports a lab’s revenue, or its parent’s: every period, the value, the XBRL tag or statement row, and the EDGAR link.',
  },
})

const route = useRoute()
const accession = String(route.params.accession ?? '')
if (!ACCESSION_RE.test(accession)) {
  throw createError({ statusCode: 404, statusMessage: 'No such filing', fatal: true })
}

const { data, error } = await useFetch('/api/revenue', {
  key: `filing:${accession}`,
  transform: (d: RevenueData) => {
    const all = revenueFilings(d)
    const filing = all.find((f) => f.accession_no === accession) ?? null
    return {
      as_of: d.as_of,
      rule: d.rule,
      filing,
      others: filing
        ? all
            .filter((f) => f.provider === filing.provider && f.accession_no !== accession)
            .map((f) => ({ accession_no: f.accession_no, title: filingTitle(f), filed: f.filed }))
        : [],
    }
  },
})

if (!data.value?.filing) {
  const upstream = error.value?.statusCode
  if (!error.value) {
    throw createError({ statusCode: 404, statusMessage: 'No such filing', fatal: true })
  }
  if (upstream === 429) {
    throw createError({ statusCode: 429, statusMessage: 'Too many requests', fatal: true })
  }
  throw createError({
    statusCode: 503,
    statusMessage: `Filing could not be read (upstream ${upstream ?? 'unknown'})`,
    fatal: true,
  })
}

const filing = data.value.filing
const others = data.value.others
const title = filingTitle(filing)
const filer = filerName(filing.filer) ?? filing.display
const heading = `${filer} ${filing.form}, filed ${filing.filed}`

const relation =
  filing.filer.relation === 'issuer'
    ? `${filing.display}’s own filing.`
    : filing.filer.segment_label
      ? `${filer} reports ${filing.filer.segment_label} as a segment. These are the parent’s segment figures, not ${filing.display}’s revenue.`
      : `${filer} consolidates ${filing.display}. This is the parent’s revenue, not ${filing.display}’s.`

const fromProspectus = filing.periods.some((p) => p.basis === 'prospectus')

const facts: Fact[] = [
  { key: 'form', label: 'Form', value: filing.form, mono: true },
  { key: 'filed', label: 'Filed', value: filing.filed, mono: true },
  {
    key: 'filer',
    label: 'Filer',
    value: `${filing.filer.entity_name ?? filer} (${filing.filer.ticker ?? `CIK ${filing.filer.cik}`})`,
  },
  { key: 'accession', label: 'Accession', value: filing.accession_no, mono: true },
]

const columns: TableColumn[] = [
  { key: 'period', label: 'Period', class: 'whitespace-nowrap text-default' },
  { key: 'dates', label: 'Dates', class: 'whitespace-nowrap text-muted' },
  { key: 'val', label: 'Revenue', numeric: true, class: 'text-highlighted' },
  { key: 'tag', label: fromProspectus ? 'Statement row' : 'XBRL tag', class: 'text-xs' },
  { key: 'status', label: 'Status', class: 'text-xs text-muted' },
]

const description = `${title}, from the ${filing.form} ${filer} filed ${filing.filed}: each period, its tag, and the EDGAR link.`

useSeo({
  title,
  description,
  ogType: 'article',
  about: labOrganizationSchema({ name: filing.display, url: LAB_SITE[filing.provider] }),
  breadcrumb: [
    { name: 'Revenue', path: '/revenue' },
    { name: heading, path: filingPath(filing.accession_no) },
  ],
  // A filing is fixed once filed; its date is when everything here became true.
  dateModified: filing.filed,
  schema: [
    articleSchema(useSiteContext(), {
      url: usePageUrl(),
      headline: title,
      description,
      datePublished: filing.filed,
      citation: [filing.filing_url],
    }),
  ],
})

const rowKey = (r: FilingPeriod) => r.entity_key
const stamps = useStamps()
</script>

<template>
  <TerminalPage
    :title="heading"
    :lede="relation"
    :as-of="data?.as_of"
    :back="{ label: 'Revenue', to: '/revenue' }"
  >
    <template #header>
      <TerminalFacts :items="facts">
        <template #accession>
          <a
            :href="filing.filing_url"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-default underline underline-offset-2 hover:text-highlighted"
            >{{ filing.accession_no }}</a
          >
        </template>
      </TerminalFacts>
    </template>

    <TerminalPanel
      id="periods"
      title="Reported revenue"
      :note="`Every period this ${filing.form} reported, newest first. Restated figures are marked.`"
      :more="{ label: `Everything on ${filing.display}`, to: labPath(filing.provider) }"
      flush
    >
      <TerminalTable
        :caption="`Revenue periods reported in ${heading}`"
        :columns="columns"
        :rows="filing.periods"
        :row-key="rowKey"
      >
        <template #cell-period="{ row: r }">
          {{ periodName(r) }}
          <span v-if="r.unaudited" class="text-muted"> · unaudited</span>
        </template>
        <template #cell-dates="{ row: r }">
          <time :datetime="r.start">{{ stamps.date(r.start) }}</time> →
          <time :datetime="r.end">{{ stamps.date(r.end) }}</time>
          <span class="sr-only"> ({{ periodLabel(r.days) }})</span>
        </template>
        <template #cell-val="{ row: r }">
          <span :title="`USD ${count(r.val)}`">{{ figures.usd(r.val) }}</span>
        </template>
        <template #cell-tag="{ row: r }">
          <code class="break-all text-default">{{ r.tag }}</code>
        </template>
        <template #cell-status="{ row: r }">
          <template v-if="r.restated_by">
            restated in
            <NuxtLink
              :to="filingPath(r.restated_by.accession_no)"
              class="underline underline-offset-2 hover:text-default"
              >{{ r.restated_by.form }} of {{ stamps.date(r.restated_by.filed) }}</NuxtLink
            >
          </template>
          <template v-else>current</template>
        </template>
      </TerminalTable>
      <template #foot>
        <TerminalSources
          :sources="filing.sources"
          :caveats="
            filing.filer.caveat
              ? [{ label: `Caveat for ${filing.display} revenue`, text: filing.filer.caveat }]
              : []
          "
        >
          <a
            :href="filing.filing_url"
            target="_blank"
            rel="noopener noreferrer"
            class="underline underline-offset-2 hover:text-default"
            >EDGAR filing index</a
          >
        </TerminalSources>
      </template>
    </TerminalPanel>

    <div class="space-y-1 text-xs text-muted">
      <p v-if="fromProspectus">
        From the filing’s printed statement of operations, which has no XBRL. The revenue page has
        <NuxtLink
          :to="`/revenue#prospectus-${filing.provider}`"
          class="underline underline-offset-2 hover:text-default"
          >the rest of the statement, commitments, customer concentration, and risk
          factors</NuxtLink
        >.
      </p>
    </div>

    <TerminalPanel
      v-if="others.length"
      id="other-filings"
      title="Other filings"
      :note="`Every other filing with revenue we’ve read for ${filing.display}, newest first.`"
    >
      <ul class="space-y-1 text-sm">
        <li v-for="o in others" :key="o.accession_no">
          <NuxtLink
            :to="filingPath(o.accession_no)"
            class="text-default underline underline-offset-2 hover:text-highlighted"
            >{{ o.title }}</NuxtLink
          >
          <span class="text-muted">
            · filed <time :datetime="o.filed">{{ stamps.date(o.filed) }}</time></span
          >
        </li>
      </ul>
    </TerminalPanel>
  </TerminalPage>
</template>
