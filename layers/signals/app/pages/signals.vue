<script setup lang="ts">
// The signal scorecard: every registered series tested against the stocks it
// is expected to lead, failures included, and the forward calls. Method detail
// is in the signal_results description on /data and the API's `method`.

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Signals',
    summary:
      'Every series we track (package downloads, the Ramp AI Index, OpenRouter share, GPU prices, probe strain, open roles at the labs and the listed companies, launches, price cuts, filed revenue, call guidance against filings, Taiwan monthly revenue, Korea chip exports, grid load) tested against the stocks it should lead: correlation with forward returns less SPY at 1, 5, 20 and 60 trading days, and event studies, with the newest third held out. Also dated forward calls, scored when the filing prints. Research, not investment advice.',
  },
})

const { data, error } = await useFetch<SignalsData>('/api/signals')

useSeo({
  title: 'Signals: AI lab data tested against the stocks it should lead',
  description:
    'Each Frontier Terminal series tested against forward returns of the listed companies tied to it, with a held-out sample and forward calls.',
  dateModified: data.value?.as_of,
})

const stamps = useStamps()

const callsNote = computed(() => {
  const calls = data.value?.forward_calls ?? []
  const settled = calls.filter((c) => c.actual).length
  return `${calls.length} calls, ${settled} settled.`
})

const note = computed(() => {
  const d = data.value
  if (!d) return ''
  const parts = [`${d.series.length} series`, `${d.tests} tests with enough history`]
  if (d.bonferroni_p !== null) parts.push(`0.05 / ${d.tests} = ${d.bonferroni_p.toPrecision(2)}`)
  if (d.prices_through) parts.push(`closes through ${stamps.date(d.prices_through)}`)
  return `${parts.join(', ')}.`
})
</script>

<template>
  <TerminalPage
    title="Signals"
    lede="Each series we track, tested against the stocks it should lead. The newest third of every series is held out. A result needs 10 held-out periods or 4 held-out event days before it gets a number."
    :as-of="data?.as_of"
    :error="Boolean(error)"
    error-title="Signals didn’t load"
    error-body="Try reloading in a minute."
  >
    <template v-if="data">
      <TerminalGap
        v-if="!data.run"
        title="No run yet."
        reason="The scorecard is computed once a day after the US close."
      />
      <TerminalPanel
        id="scorecard"
        title="Scorecard"
        :note="note"
        :more="{ label: 'Method and download', to: '/data#signal_results' }"
        flush
      >
        <TerminalSignalScorecard :data="data" />
        <template #foot>
          Highlighted: clears 0.05 divided by the number of tests, held out, with the same sign in
          sample. {{ data.credit }}
        </template>
      </TerminalPanel>
      <TerminalPanel
        v-for="family in data.families"
        :id="family.id"
        :key="family.id"
        :title="family.label"
        note="Predicted before it was run, and corrected as its own family."
        flush
      >
        <TerminalSignalFamily :data="data" :family="family" />
        <template #foot>
          A cell holds when its held-out p clears the bar, with the sign the wave predicted and the
          same sign in sample. The wave bar divides 0.05 by the wave's own tests only; the all-tests
          bar divides it by every test on this page. Research, not investment advice.
        </template>
      </TerminalPanel>
      <TerminalPanel
        id="forward-calls"
        title="Forward calls"
        :note="callsNote"
        :more="{ label: 'Download', to: '/data#forward_calls' }"
      >
        <TerminalForwardCalls :calls="data.forward_calls" />
        <template #foot>{{ data.forward_rule }}</template>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
