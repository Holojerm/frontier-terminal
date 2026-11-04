<script setup lang="ts">
// How to reach the people behind the terminal — above all, how to pay for the
// data. The public site stays free and CC BY; this page is where someone who
// needs more than that finds out what can be bought and who to ask.
//
// What a paid licence can cover is not ours to decide for every row: an
// upstream CC BY dataset keeps its attribution condition whatever we sign,
// and a source with no licence or a scraping bar cannot be sold at all. The
// three lists below are read from each source's `rights:` in sources.yaml
// (via /api/coverage), so the offer cannot drift from the audit.

import { DATA_LICENSE } from '#shared/utils/license'
import { CONTACT_EMAIL, mailto } from '../../shared/utils/contact'
import type { CoverageData, SourceRights } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.5',
    title: 'Contact',
    summary:
      'Commercial data licensing — a signed licence for the compilation and derived numbers that are ours, a dependable feed, full history and source payloads, custom coverage — with upstream CC BY data passed on under its own terms, plus corrections and press. Write to contact@frontierterm.com.',
  },
})

const { data: coverage, error } = await useFetch<CoverageData>('/api/coverage')

useSeo({
  title: 'Contact',
  description:
    'License Frontier Terminal’s compilation: signed terms for what is ours, a dependable feed, full history, custom coverage. Corrections and press too.',
})

interface Named {
  key: string
  name: string
}

/** Registered sources and audited recipes by what a licence can cover; derived feeds follow their parent. */
const groups = computed(() => {
  const out: Record<SourceRights, Named[]> = { ours: [], upstream: [], 'not-cleared': [] }
  for (const s of coverage.value?.sources ?? []) {
    if (s.derived_from || !s.rights) continue
    out[s.rights].push({ key: s.source_id, name: s.label })
  }
  for (const r of coverage.value?.recipes ?? []) {
    if (r.rights) out[r.rights].push({ key: r.recipe_id, name: r.recipe_id })
  }
  return out
})

const GROUPS: { rights: SourceRights; title: string; body: string }[] = [
  {
    rights: 'ours',
    title: 'Ours to license',
    body: 'Facts each publisher states about itself (prices, open roles, incidents, filings), read under terms and a robots.txt that allow it. The compilation is ours: the keyed and timestamped rows, the change log, the alerts and every number we derive. The facts stay their publishers’.',
  },
  {
    rights: 'upstream',
    title: 'Passed on under upstream terms',
    body: 'Someone else’s dataset under its own licence. We pass it on with the attribution its licence requires and cannot sign that condition away. Per-lab shares we compute from it are still derived from CC BY data.',
  },
  {
    rights: 'not-cleared',
    title: 'Not in any paid offer',
    body: 'No stated licence (the Ramp AI Index), terms we could not read, or a robots.txt or terms restriction on automated reading. These stay on the free site and out of anything we sell.',
  },
]
</script>

<template>
  <TerminalPage
    title="Contact"
    lede="Building a product, a fund process or a report on this data? Write to us."
    narrow
  >
    <TerminalPanel id="commercial" title="Paying for the data">
      <div class="max-w-2xl space-y-4 text-default">
        <p>
          Everything on the site stays free under {{ DATA_LICENSE.short }}. A paid arrangement is
          for what the public site cannot promise, and covers only what is ours to license (see
          below). Tell us what you need — for example:
        </p>
        <ul class="list-disc space-y-2 pl-5">
          <li>
            <strong class="text-highlighted">Signed terms for what is ours.</strong> A licence your
            compliance team has signed for our compilation and derived numbers, on attribution terms
            that suit you. Upstream CC BY data keeps its own attribution condition.
          </li>
          <li>
            <strong class="text-highlighted">Delivery you can depend on.</strong> A feed with a
            committed schedule instead of a public endpoint behind a per-address rate limit.
          </li>
          <li>
            <strong class="text-highlighted">History and source bytes.</strong> The full change log
            and the captured payload behind every number, for the sources we can license.
          </li>
          <li>
            <strong class="text-highlighted">Coverage we don’t have.</strong> Another lab, another
            source, another axis.
          </li>
        </ul>
        <UButton
          :to="mailto('Data licensing')"
          external
          size="lg"
          icon="i-lucide-mail"
          :label="`Email ${CONTACT_EMAIL}`"
        />
        <p class="text-sm text-muted">
          It helps to say who you are, what you would use it for, which labs or tables matter, and
          how fresh the numbers need to be.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel
      id="rights"
      title="What a licence can cover"
      note="Per source, from the terms and robots.txt each was read under. The full reading is in the coverage table on /data."
    >
      <UAlert
        v-if="error"
        color="warning"
        variant="subtle"
        title="The source list could not be read"
        description="Each source’s terms are also in the coverage table on /data and in sources.yaml."
      />
      <div v-else class="space-y-4 text-sm">
        <section v-for="g in GROUPS" :key="g.rights" class="space-y-1">
          <h3 class="text-highlighted">{{ g.title }}</h3>
          <p class="max-w-2xl text-muted">{{ g.body }}</p>
          <p v-if="groups[g.rights].length" class="max-w-2xl text-default">
            <template v-for="(s, i) in groups[g.rights]" :key="s.key"
              ><span class="whitespace-nowrap">{{ s.name }}</span
              ><template v-if="i < groups[g.rights].length - 1">; </template></template
            >.
          </p>
        </section>
        <p class="text-xs text-muted">
          <NuxtLink to="/data#coverage" class="text-primary underline underline-offset-2"
            >Each source’s terms</NuxtLink
          >
          ·
          <NuxtLink to="/license" class="text-primary underline underline-offset-2"
            >Licence and attribution</NuxtLink
          >
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="other" title="Everything else">
      <div class="max-w-2xl space-y-3 text-sm text-default">
        <p>
          <strong class="text-highlighted">A number looks wrong.</strong>
          <a :href="mailto('Correction')" class="text-primary underline underline-offset-2"
            >Send a correction</a
          >
          with the page and, if you have it, the row’s source URL — every row prints the one it was
          read from.
        </p>
        <p>
          <strong class="text-highlighted">Press and everything else.</strong> The same address:
          <a :href="mailto('Hello')" class="text-primary underline underline-offset-2">{{
            CONTACT_EMAIL
          }}</a
          >.
        </p>
      </div>
    </TerminalPanel>
  </TerminalPage>
</template>
