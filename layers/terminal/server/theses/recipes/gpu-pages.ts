// GPU rental price pages: one recipe per provider whose first-party pricing
// page is server-rendered HTML. Each reads only the self-serve on-demand
// offering the page prices per hour; reserved, spot, preemptible, dedicated
// inference endpoints and multi-week clusters are other products and are
// skipped. Every extractor throws when the section it reads is missing, so a
// redesign fails the run instead of storing an empty price list.

import { cellText, contentOf, dollars, gpuOf, gpuRecipe, tablesOf, type GpuRow } from './gpu-prices'

const need = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`missing ${what}`)
  return value
}

/** The page from `marker` on, up to `end` when it follows. */
function section(html: string, marker: string, end?: string): string {
  const at = html.indexOf(marker)
  if (at === -1) throw new Error(`missing "${marker}"`)
  const stop = end ? html.indexOf(end, at) : -1
  return html.slice(at, stop === -1 ? undefined : stop)
}

/** Text of a piece split out mid-tag: it starts with the rest of an opening tag's attributes. */
const tailText = (piece: string) => cellText(`<x ${piece}`)

/** Lambda: "Instances pricing", one table per tab (8x, 4x, 2x, 1x), priced per GPU-hour. */
export function lambdaRows(body: string): GpuRow[] {
  const instances = section(contentOf(body), 'Instances pricing')
  const tabs = [...instances.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => cellText(m[1]!))
  const tables = tablesOf(instances).filter((t) =>
    t.rows[0]?.some((c) => /PRICE\/GPU\/HR/i.test(c)),
  )
  if (tables.length === 0 || tables.length !== tabs.length) {
    throw new Error(`instance tabs (${tabs.length}) and tables (${tables.length}) disagree`)
  }
  return tables.flatMap((table, i) => {
    const gpus = Number(tabs[i]!.match(/^(\d+)x$/)?.[1])
    if (!gpus) throw new Error(`tab "${tabs[i]}" is not a GPU count`)
    return table.rows.slice(1).flatMap((row) => {
      const g = gpuOf(row[0] ?? '')
      const price = dollars(row.at(-1) ?? '')
      if (!g || price === null) return []
      return [
        {
          ...g,
          label: row[0]!,
          usd_per_gpu_hour: price,
          gpus_per_instance: gpus,
          instance_usd_per_hour: null,
          region: null,
          config: `${gpus}x`,
        },
      ]
    })
  })
}

/** CoreWeave: one list item per instance, priced per instance-hour with its GPU count. */
export function coreweaveRows(body: string): GpuRow[] {
  const html = contentOf(body)
  const items = html.split(/<div role="listitem" class="table-row-v2 /).slice(1)
  const rows: GpuRow[] = []
  for (const item of items) {
    const label = item.match(/class="table-model-name"[^>]*>([^<]*)</)?.[1]?.trim()
    const g = label ? gpuOf(label) : null
    if (!label || !g) continue
    const price = dollars(
      item.match(/On-Demand Price:\s*<span class="item-value">([^<]*)</)?.[1] ?? '',
    )
    const gpus = Number(item.match(/table-meta-value">\s*(\d+)\s*<\/div>\s*<div>GPU Count/)?.[1])
    if (price === null) continue
    if (!gpus) throw new Error(`${label}: no GPU count`)
    rows.push({
      ...g,
      label,
      usd_per_gpu_hour: price / gpus,
      gpus_per_instance: gpus,
      instance_usd_per_hour: price,
      region: null,
      config: null,
    })
  }
  return need(rows.length ? rows : null, 'CoreWeave GPU instance list')
}

/** Nebius: the "NVIDIA GPU Instances" table, column "On-demand, GPU-hour". */
export function nebiusRows(body: string): GpuRow[] {
  const table = section(contentOf(body), '>NVIDIA GPU Instances<', 'pc-highlight-table-block__root')
  const rows = table
    .split('class="pc-highlight-table-block__row"')
    .slice(1)
    .map((r) => r.split('class="pc-highlight-table-block__cell"').slice(1).map(tailText))
  const col = rows[0]?.findIndex((c) => /^On-demand, GPU-hour$/i.test(c)) ?? -1
  if (col < 0) throw new Error('missing On-demand, GPU-hour column')
  return rows.slice(1).flatMap((row) => {
    const g = gpuOf(row[0] ?? '')
    const price = dollars(row[col] ?? '')
    if (!g || price === null) return []
    return [
      {
        ...g,
        label: row[0]!,
        usd_per_gpu_hour: price,
        gpus_per_instance: null,
        instance_usd_per_hour: null,
        region: null,
        config: null,
      },
    ]
  })
}

/**
 * Crusoe: "GPU instances pricing" lays out a column of GPU names and one
 * column of prices per header, matched by position. The first price column is
 * today's on-demand price under either header the page has used: "On-demand,
 * Current spot" (until 2026-11-03) or "Current on-demand, New on-demand
 * starting <date>" (a scheduled price change, announced 2026-11-03). Only the
 * first column is read; a price that has not taken effect is not a price.
 */
const CRUSOE_HEADER =
  /GPU model (?:On-demand Current spot|Current on-demand New on-demand starting [A-Z][a-z]+ \d{1,2}, \d{4})$/

export function crusoeRows(body: string): GpuRow[] {
  const gpus = section(contentOf(body), 'GPU instances pricing', 'CPU instances pricing')
  const header = cellText(gpus.slice(0, gpus.indexOf('data-sort-name')))
  if (!CRUSOE_HEADER.test(header)) {
    throw new Error(`GPU instances header reads "${header.slice(-60)}"`)
  }
  const names = [...gpus.matchAll(/data-sort-name="([^"]+)"[\s\S]*?pricing-tag[^>]*>([^<]*)</g)]
  const onDemand = gpus
    .split('<div role="listitem" class="gpu-row w-dyn-item">')
    .slice(1, names.length + 1)
    .map((cell) => tailText(cell.split('</div></div>')[0]!))
  if (names.length === 0 || onDemand.length !== names.length) {
    throw new Error(
      `GPU names (${names.length}) and on-demand prices (${onDemand.length}) disagree`,
    )
  }
  return names.flatMap(([, name, memory], i) => {
    const label = `${name} ${memory}`.trim()
    const g = gpuOf(label)
    const price = dollars(onDemand[i]!)
    if (!g || price === null) return []
    return [
      {
        ...g,
        label,
        usd_per_gpu_hour: price,
        gpus_per_instance: null,
        instance_usd_per_hour: null,
        region: null,
        config: null,
      },
    ]
  })
}

/** Together AI: the GPU Clusters table, column "ON-Demand", priced per GPU-hour. */
export function togetherRows(body: string): GpuRow[] {
  const table = need(
    tablesOf(contentOf(body)).find(
      (t) =>
        t.rows[0]?.some((c) => /^on-demand$/i.test(c)) &&
        t.rows[0]?.some((c) => /preemptible/i.test(c)),
    ),
    'GPU Clusters on-demand table',
  )
  const col = table.rows[0]!.findIndex((c) => /^on-demand$/i.test(c))
  return table.rows.slice(1).flatMap((row) => {
    const g = gpuOf(row[0] ?? '')
    const price = dollars(row[col] ?? '')
    if (!g || price === null) return []
    return [
      {
        ...g,
        label: row[0]!,
        usd_per_gpu_hour: price,
        gpus_per_instance: null,
        instance_usd_per_hour: null,
        region: null,
        config: 'GPU Clusters',
      },
    ]
  })
}

/** DigitalOcean: one pricing card per GPU; the card labelled "On-Demand Price" is the one read. */
export function digitaloceanRows(body: string): GpuRow[] {
  const cards = contentOf(body)
    .split(/class="CardPricingstyles__StyledCardPricingCard/)
    .slice(1)
  const rows: GpuRow[] = []
  for (const card of cards) {
    const label = cellText(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '')
    const g = gpuOf(label)
    const priced = cellText(card.match(/StyledPriceContainer[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '')
    if (!g || !/On-Demand Price$/.test(priced)) continue
    const price = dollars(priced)
    if (price === null) throw new Error(`${label}: on-demand card without a price`)
    rows.push({
      ...g,
      label,
      usd_per_gpu_hour: price,
      gpus_per_instance: null,
      instance_usd_per_hour: null,
      region: null,
      config: null,
    })
  }
  return need(rows.length ? rows : null, 'DigitalOcean on-demand GPU cards')
}

/** Verda: the on-demand "GPU instances" table; two rows of one GPU differ by CPUs and RAM. */
export function verdaRows(body: string): GpuRow[] {
  const table = need(
    tablesOf(contentOf(body)).find(
      (t) =>
        /NVIDIA GPU instances\..*On-demand Pay-as-you-go pricing/.test(t.before.slice(-400)) &&
        t.rows[0]?.[4] === 'Price',
    ),
    'GPU instances on-demand table',
  )
  return table.rows.slice(1).flatMap((row) => {
    const m = row[0]?.match(/^(\d+)x (.+)$/)
    const g = m ? gpuOf(m[2]!) : null
    const price = dollars(row[4] ?? '')
    if (!m || !g || price === null) return []
    const gpus = Number(m[1])
    return [
      {
        ...g,
        label: row[0]!,
        usd_per_gpu_hour: price / gpus,
        gpus_per_instance: gpus,
        instance_usd_per_hour: price,
        region: null,
        config: `${row[1]} CPUs, ${row[2]}`,
      },
    ]
  })
}

export const GPU_LAMBDA = gpuRecipe({
  id: 'gpu-lambda',
  company: 'lambda',
  url: 'https://lambda.ai/pricing',
  ext: 'html',
  description: 'Lambda on-demand instance prices per GPU-hour (lambda.ai/pricing)',
  rows: lambdaRows,
})

export const GPU_COREWEAVE = gpuRecipe({
  id: 'gpu-coreweave',
  company: 'coreweave',
  url: 'https://www.coreweave.com/pricing',
  ext: 'html',
  description: 'CoreWeave on-demand instance prices, divided by GPUs per instance',
  rows: coreweaveRows,
})

export const GPU_NEBIUS = gpuRecipe({
  id: 'gpu-nebius',
  company: 'nebius',
  url: 'https://nebius.com/prices',
  ext: 'html',
  description: 'Nebius on-demand GPU-hour prices (nebius.com/prices)',
  rows: nebiusRows,
})

export const GPU_CRUSOE = gpuRecipe({
  id: 'gpu-crusoe',
  company: 'crusoe',
  url: 'https://www.crusoe.ai/cloud/pricing',
  ext: 'html',
  description: 'Crusoe on-demand GPU instance prices per GPU-hour',
  rows: crusoeRows,
})

export const GPU_TOGETHER = gpuRecipe({
  id: 'gpu-together',
  company: 'together',
  url: 'https://www.together.ai/pricing',
  ext: 'html',
  description: 'Together AI GPU Clusters on-demand prices per GPU-hour',
  rows: togetherRows,
})

export const GPU_DIGITALOCEAN = gpuRecipe({
  id: 'gpu-digitalocean',
  company: 'digitalocean',
  url: 'https://www.digitalocean.com/pricing/gpu-droplets',
  ext: 'html',
  description: 'DigitalOcean GPU Droplet on-demand prices per GPU-hour',
  rows: digitaloceanRows,
})

export const GPU_VERDA = gpuRecipe({
  id: 'gpu-verda',
  company: 'verda',
  url: 'https://verda.com/pricing',
  ext: 'html',
  description: 'Verda (formerly DataCrunch) on-demand GPU instance prices',
  rows: verdaRows,
})
