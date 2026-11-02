<script setup lang="ts">
// One thesis, claim by claim: status against the kill condition, the reason,
// and the evidence — a series for a measured claim, a verdict list for a
// judged one. The id is a route parameter; one the registry does not hold is
// a 404.

import manifest from '~~/fleet.json'

import { journalUrl, thesisPath } from '../../../shared/utils/thesis-format'
import type { ThesesData } from '../../../shared/utils/thesis-types'

// Inert for a dynamic route: the collecting hook skips paths with a
// parameter, and sitemap.xml / llms.txt append one page per thesis from the
// registry. Declared anyway — the seo gate's invariant is per-page.
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Thesis',
    summary:
      'One thesis claim by claim: each status against its kill condition, the reason, and the readings or verdicts behind it.',
  },
})

const id = String(useRoute().params.id ?? '')

const { data, error } = await useFetch<ThesesData>('/api/theses')

const thesis = computed(() => data.value?.theses.find((t) => t.id === id) ?? null)
if (data.value && !thesis.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such thesis', fatal: true })
}

const name = thesis.value?.title ?? 'Thesis'

useSeo({
  title: `${name} thesis`,
  description: `The ${name} thesis checked claim by claim: each status against its kill condition, with the readings or verdicts and sources behind it.`,
  dateModified: data.value?.as_of,
  breadcrumb: [
    { name: 'Theses', path: '/theses' },
    { name: `${name} thesis`, path: thesisPath(id) },
  ],
})
</script>

<template>
  <TerminalPage
    :back="{ label: 'All theses', to: '/theses' }"
    :as-of="data?.as_of"
    :error="Boolean(error) || !data"
    error-title="This thesis could not be read"
    error-body="The theses endpoint failed to respond. No stale or inferred status is shown in its place."
  >
    <template #title>
      {{ thesis?.title ?? 'Thesis' }}
      <span v-if="thesis?.ticker" class="ml-2 font-mono text-lg text-muted">{{
        thesis.ticker
      }}</span>
    </template>
    <template v-if="thesis" #lede>{{ thesis.statement }}</template>
    <template v-if="thesis" #header>
      <ThesisMeta :thesis="thesis" />
      <p v-if="thesis.comparison_names.length" class="text-sm text-muted">
        Compared with {{ thesis.comparison_names.join(', ') }}.
      </p>
      <UButton
        :href="journalUrl(manifest.links.github, thesis.doc_path)"
        target="_blank"
        rel="noopener noreferrer"
        variant="link"
        color="primary"
        size="sm"
        trailing-icon="i-lucide-external-link"
        class="px-0 underline underline-offset-2"
      >
        Read the journal page on GitHub
      </UButton>
    </template>

    <template v-if="thesis && data">
      <section aria-label="Claims" class="space-y-6">
        <ThesisClaim v-for="claim in thesis.claims" :key="claim.id" :claim="claim" />
      </section>

      <ThesisFooter :caveat="data.caveat" />
    </template>
  </TerminalPage>
</template>
