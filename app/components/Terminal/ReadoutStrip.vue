<script setup lang="ts">
// The readout: one row per lab, one column per axis, the number and its
// delta and nothing else. This is what an investor glances at and leaves
// with. Every figure links to the lab page section that carries its full
// provenance, and its title names the source host and the fetch instant, so
// the number is never further than one hover from where it came from.

import {
  absoluteStamp,
  compactUsd,
  hostOf,
  money,
  periodLabel,
  ppLabel,
  relativeStamp,
  sharePct,
} from '#shared/utils/terminal-format'
import { labPath, summarizeLab, type LabInputs } from '#shared/utils/terminal-lab-summary'
import { alertPath } from '#shared/utils/terminal-tiers'
import type { BigFour, Prov } from '#shared/utils/terminal-types'

const props = defineProps<{
  labs: readonly BigFour[]
  data: LabInputs
  /** The lab column links here; on a lab page it is already the page. */
  linkLabs?: boolean
}>()

const now = useNow()

const rows = computed(() => props.labs.map((lab) => summarizeLab(lab, props.data)))

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '·')
const provTitle = (p: Prov | null | undefined) =>
  p ? `${hostOf(p.source_url)} · fetched ${absoluteStamp(p.fetched_at)}` : undefined
const anchor = (lab: BigFour, id: string) => `${labPath(lab)}#${id}`
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <caption class="sr-only">
        Each lab on every axis: flagship price, disclosed revenue, demand share, open roles,
        incidents, and its newest alert
      </caption>
      <thead>
        <tr class="border-b border-default text-left text-xs text-toned">
          <th scope="col" class="py-2 pr-3 font-medium">Lab</th>
          <th scope="col" class="py-2 pr-3 font-medium">Flagship $/Mtok</th>
          <th scope="col" class="py-2 pr-3 font-medium">SEC revenue</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Demand</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Open roles</th>
          <th scope="col" class="py-2 pr-3 text-right font-medium">Incidents 30d</th>
          <th scope="col" class="py-2 font-medium">Newest alert</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.lab" class="border-b border-default align-baseline">
          <th
            scope="row"
            class="whitespace-nowrap py-2 pr-3 text-left font-medium text-highlighted"
          >
            <NuxtLink
              v-if="linkLabs"
              :to="labPath(r.lab)"
              class="hover:underline hover:underline-offset-2"
            >
              {{ r.display }}
            </NuxtLink>
            <template v-else>{{ r.display }}</template>
          </th>

          <td class="whitespace-nowrap py-2 pr-3 font-mono">
            <NuxtLink
              v-if="r.flagship?.priced"
              :to="anchor(r.lab, 'prices')"
              :title="provTitle(r.flagship.row)"
              class="hover:underline hover:underline-offset-2"
            >
              <span class="text-highlighted">{{ money(r.flagship.row!.input_per_mtok) }}</span>
              <span class="text-xs text-toned"> in </span>
              <span class="text-default">{{ money(r.flagship.row!.output_per_mtok) }}</span>
              <span class="text-xs text-toned"> out</span>
            </NuxtLink>
            <NuxtLink
              v-else
              :to="anchor(r.lab, 'prices')"
              class="text-xs text-toned hover:underline hover:underline-offset-2"
              :title="r.flagship?.gap ?? undefined"
            >
              {{ r.flagship?.row ? 'no published price' : 'not mapped' }}
            </NuxtLink>
          </td>

          <td class="whitespace-nowrap py-2 pr-3 font-mono">
            <NuxtLink
              v-if="r.revenue.newest"
              :to="anchor(r.lab, 'revenue')"
              :title="provTitle(r.revenue.newest)"
              class="hover:underline hover:underline-offset-2"
            >
              <span class="text-highlighted">{{ compactUsd(r.revenue.newest.val) }}</span>
              <span class="text-xs text-toned">
                {{ periodLabel(r.revenue.newest.days) }} to {{ r.revenue.newest.end }}
                <template v-if="r.revenue.view?.disclosure === 'parent'"> · parent</template>
              </span>
            </NuxtLink>
            <NuxtLink
              v-else
              :to="anchor(r.lab, 'revenue')"
              class="text-xs text-toned hover:underline hover:underline-offset-2"
            >
              none filed
            </NuxtLink>
          </td>

          <td class="whitespace-nowrap py-2 pr-3 text-right font-mono">
            <NuxtLink
              v-if="r.demand?.share !== null && r.demand"
              :to="anchor(r.lab, 'demand')"
              :title="provTitle(data.rankings?.provenance)"
              class="hover:underline hover:underline-offset-2"
            >
              <span class="text-highlighted">{{ sharePct(r.demand.share) }}</span>
              <span v-if="r.demand.delta_pp !== null" class="ml-1 text-xs text-toned">
                {{ ppLabel(r.demand.delta_pp) }}
              </span>
            </NuxtLink>
            <span v-else class="text-xs text-toned">—</span>
          </td>

          <td class="whitespace-nowrap py-2 pr-3 text-right font-mono">
            <NuxtLink
              v-if="r.hiring.now !== null"
              :to="anchor(r.lab, 'hiring')"
              :title="provTitle(r.hiring.view?.sources[0])"
              class="hover:underline hover:underline-offset-2"
            >
              <span class="text-highlighted">{{ r.hiring.now }}</span>
              <span v-if="r.hiring.delta !== null" class="ml-1 text-xs text-toned">
                {{ signed(r.hiring.delta) }} in {{ r.hiring.days }}d
              </span>
            </NuxtLink>
            <NuxtLink
              v-else
              :to="anchor(r.lab, 'hiring')"
              class="text-xs text-toned hover:underline hover:underline-offset-2"
            >
              no feed
            </NuxtLink>
          </td>

          <td class="whitespace-nowrap py-2 pr-3 text-right font-mono">
            <NuxtLink
              v-if="r.incidents?.feed === 'ok'"
              :to="anchor(r.lab, 'incidents')"
              :title="provTitle(r.incidents.sources[0])"
              class="hover:underline hover:underline-offset-2"
            >
              <span class="text-highlighted">{{ r.incidents.last_window }}</span>
              <span class="text-xs text-toned"> vs {{ r.incidents.prior_window }}</span>
              <span v-if="r.incidents.open.length" class="ml-1 text-xs text-warning">
                {{ r.incidents.open.length }} open
              </span>
            </NuxtLink>
            <NuxtLink
              v-else
              :to="anchor(r.lab, 'incidents')"
              class="text-xs text-toned hover:underline hover:underline-offset-2"
            >
              no feed
            </NuxtLink>
          </td>

          <td class="max-w-64 py-2 text-xs">
            <template v-if="r.alerts[0]">
              <time
                :datetime="r.alerts[0].created_at"
                class="mr-2 whitespace-nowrap font-mono text-toned"
              >
                {{ relativeStamp(r.alerts[0].created_at, now) }}
              </time>
              <NuxtLink
                :to="alertPath(r.alerts[0].id)"
                :title="r.alerts[0].headline"
                class="text-default underline decoration-1 underline-offset-2 hover:text-highlighted"
              >
                {{
                  r.alerts[0].headline.length > 56
                    ? `${r.alerts[0].headline.slice(0, 55).trimEnd()}…`
                    : r.alerts[0].headline
                }}
              </NuxtLink>
            </template>
            <span v-else class="text-toned">none</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
