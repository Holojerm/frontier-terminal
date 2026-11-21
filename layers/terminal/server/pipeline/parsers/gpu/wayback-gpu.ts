// Parsers for the Internet Archive's copies of GPU rental price pages, one
// per page layout the live recipes (theses/recipes/gpu-pages.ts) don't read.
// Each returns the rows the live extractor would: the same labels, GPU
// counts and configs where the page prints them, so an archived row keys
// like the live row for the same offering. Each throws when the section it
// reads is missing, so a capture in another shape is skipped with the reason.

import {
  cellText,
  contentOf,
  dollars,
  gpuOf,
  tablesOf,
  type GpuRow,
} from '../../../theses/recipes/gpu-prices'

const need = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`missing ${what}`)
  return value
}

/** 1/1/2024 -> 2024-01-01 */
const usDate = (m: string, d: string, y: string) =>
  `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`

/**
 * Lambda before December 2025 (lambdalabs.com/service/gpu-cloud, then
 * lambda.ai/pricing): the "On-demand GPU cloud pricing" table, one row per
 * instance ("8x NVIDIA H100 SXM", later "On-demand 8x NVIDIA H100 SXM"),
 * priced per instance-hour ("$27.92 / hr") until late 2024 and per GPU-hour
 * ("$2.99 / GPU / hr", or under a PRICE/GPU/HR header) after. Late 2023 the
 * table printed two price columns, "2023 Price" and "2024 Price (effective
 * 1/1/2024)": the one in effect on the capture's day is read. Reserved rows
 * and the reserved-cluster tables (a Term column) are other products.
 */
export function lambdaArchivedRows(body: string, capturedAt: string): GpuRow[] {
  const day = capturedAt.slice(0, 10)
  const tables = tablesOf(contentOf(body)).filter((t) => {
    const head = t.rows[0] ?? []
    return head.some((c) => /^VRAM/i.test(c)) && !head.some((c) => /^Term$/i.test(c))
  })
  const rows: GpuRow[] = []
  let priced = 0
  for (const table of tables) {
    const head = table.rows[0]!
    // Each price column with the day it takes effect ('' for the plain one).
    const prices = head.flatMap((c, i) => {
      if (/^PRICE\s*(\/\s*GPU\s*\/\s*HR)?\*?$/i.test(c)) return [{ i, from: '' }]
      const m = c.match(/^\d{4} Price(?: \(effective (\d{1,2})\/(\d{1,2})\/(\d{4})\))?$/i)
      if (!m) return []
      return [{ i, from: m[1] ? usDate(m[1], m[2]!, m[3]!) : '' }]
    })
    const col = prices.filter((p) => p.from <= day).at(-1)
    if (!col) continue
    priced++
    const perGpuHeader = /GPU\s*\/\s*HR/i.test(head[col.i]!)
    for (const row of table.rows.slice(1)) {
      // A row whose first cell is Reserved is not on demand. The instance is
      // the first cell naming a GPU count ("New" and "Price" are badges).
      if (/^Reserved\b/i.test(row[0] ?? '')) continue
      const m = row
        .map((c) => c.match(/^(?:On-demand\s+)?(\d+)x\s+(.+?)(?:\s+New)?(?:\s+Price)?$/i))
        .find(Boolean)
      if (!m) continue
      const label = m[2]!.trim()
      const g = gpuOf(label)
      const cell = row[col.i] ?? ''
      const price = dollars(cell)
      if (!g || price === null) continue
      const gpus = Number(m[1])
      const perGpu = perGpuHeader || /\/\s*GPU\b/i.test(cell)
      if (!perGpu && !/\/\s*hr\b/i.test(cell)) throw new Error(`${m[0]}: "${cell}" is not hourly`)
      rows.push({
        ...g,
        label,
        usd_per_gpu_hour: perGpu ? price : price / gpus,
        gpus_per_instance: gpus,
        instance_usd_per_hour: perGpu ? null : price,
        region: null,
        config: `${gpus}x`,
      })
    }
  }
  if (priced === 0) throw new Error('missing the on-demand GPU cloud pricing table')
  return need(rows.length ? rows : null, 'an on-demand H100 or B200 row')
}

/** Text of a piece split out mid-tag: it starts with the rest of an opening tag's attributes. */
const tailText = (piece: string) => cellText(`<x ${piece}`)

/**
 * CoreWeave until April 2026: Webflow "table-v2" lists, a header row of
 * "table-header-text" cells, then one list item per instance with its GPU
 * count and "Instance Price (Per Hour)". The page also lists per-GPU
 * component rates ("Offering, Rate") for its older à la carte product; only
 * lists with an instance price column are read. The live layout (from April
 * 2026) is gpu-pages.ts › coreweaveRows.
 */
export function coreweaveArchivedRows(body: string): GpuRow[] {
  const blocks = contentOf(body)
    .split(/<div[^>]*\bclass="table-v2 /)
    .slice(1)
  const rows: GpuRow[] = []
  let priced = 0
  for (const block of blocks) {
    const [headPart = '', bodyPart = ''] = block.split('table-v2-body')
    const head = [...headPart.matchAll(/class="table-header-text">([\s\S]*?)<\/div>/g)].map((m) =>
      cellText(m[1]!),
    )
    const col = {
      price: head.findIndex((c) => /^(Instance|On-Demand) Price \(Per Hour\)$/i.test(c)),
      gpus: head.indexOf('GPU Count'),
    }
    if (col.price === -1 || col.gpus === -1) continue
    priced++
    for (const item of bodyPart.split('role="listitem"').slice(1)) {
      const label = cellText(
        item.match(/class="table-model-name[^"]*">([\s\S]*?)<\/h3>/)?.[1] ?? '',
      )
      const g = gpuOf(label)
      if (!g) continue
      // The desktop cells; the "table-cell-column" after them repeats the row for phones.
      const cells = item
        .split('table-cell-column')[0]!
        .split(/class="table-v2-cell[^"]*"/)
        .slice(1)
        .map(tailText)
      const price = dollars(cells[col.price] ?? '')
      if (price === null) continue
      const gpus = Number(cells[col.gpus])
      if (!Number.isInteger(gpus) || gpus < 1) throw new Error(`${label}: no GPU count`)
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
  }
  if (priced === 0) throw new Error('missing an instance price list')
  return need(rows.length ? rows : null, 'an H100 or B200 instance price')
}

/**
 * nebius.ai/prices, late 2023 to autumn 2024: one paragraph per GPU type,
 * "GPU type: H100 SXM5. PAYG price – $4.85/h", priced per GPU-hour (the page
 * says "Prices per hour per H100 SXM5"). The reserve tables under it are
 * commitments, not on-demand prices.
 */
export function nebiusAiArchivedRows(body: string): GpuRow[] {
  const text = cellText(contentOf(body))
  const rows = [
    ...text.matchAll(/GPU type: ([^.]+?)\. PAYG price\s*[–-]\s*(\$[\d.]+)\s*\/\s*h\b/g),
  ].flatMap(([, label, cell]) => {
    const g = gpuOf(label!)
    const price = dollars(cell!)
    if (!g || price === null) return []
    return [
      {
        ...g,
        label: label!,
        usd_per_gpu_hour: price,
        gpus_per_instance: null,
        instance_usd_per_hour: null,
        region: null,
        config: null,
      },
    ]
  })
  return need(rows.length ? rows : null, 'a "GPU type: … PAYG price" line for an H100 or B200')
}

/**
 * nebius.com/prices, November 2024 to spring 2025: a "pc-table" of GPU
 * prices. Until early 2025 it is "GPU prices and configurations", one row
 * per VM ("1 × H100 SXM", "8 × H100 SXM") priced per VM-hour in its "On
 * demand" column, beside a "Reserve" commitment price that is skipped. From
 * March 2025 it is "On-demand GPU pricing", one row per GPU ("NVIDIA H100
 * GPU") priced per hour.
 */
export function nebiusTableArchivedRows(body: string): GpuRow[] {
  const html = contentOf(body)
  const heading = html.match(/>(?:NVIDIA )?GPU prices and configurations<|>On-demand GPU pricing</)
  if (!heading) throw new Error('missing the GPU prices table heading')
  // The table under the heading, up to the next block's heading.
  const after = html.slice(heading.index! + heading[0].length)
  const next = after.search(/g-text_variant_display-2/)
  const lines = (next === -1 ? after : after.slice(0, next))
    .split(/class="pc-table__row"/)
    .slice(1)
    .map((r) =>
      r
        .split(/class="pc-table__cell[^"]*"/)
        .slice(1)
        .map(tailText),
    )
  const col = lines[0]?.findIndex((c) => /^(On demand|Price per hour)$/i.test(c)) ?? -1
  if (col < 0) throw new Error('missing the On demand or Price per hour column')
  const rows = lines.slice(1).flatMap((row) => {
    const m = row[0]?.match(/^(?:(\d+)\s*[×x]\s*)?(.+)$/)
    const g = m ? gpuOf(m[2]!) : null
    const price = dollars(row[col] ?? '')
    if (!m || !g || price === null) return []
    const gpus = m[1] ? Number(m[1]) : null
    return [
      {
        ...g,
        label: m[2]!.trim(),
        usd_per_gpu_hour: gpus ? price / gpus : price,
        gpus_per_instance: gpus,
        instance_usd_per_hour: gpus ? price : null,
        region: null,
        config: null,
      },
    ]
  })
  return need(rows.length ? rows : null, 'an on-demand H100 or B200 row')
}

/**
 * nebius.com/prices, summer 2025 to spring 2026: the "NVIDIA GPU Instances"
 * table the live recipe reads, with one price column, "Price per GPU-hour",
 * where the live page now prints "On-demand, GPU-hour". Reserve prices were
 * cards above the table then, not a column.
 */
export function nebiusGpuHourArchivedRows(body: string): GpuRow[] {
  const html = contentOf(body)
  const at = html.indexOf('>NVIDIA GPU Instances<')
  if (at === -1) throw new Error('missing ">NVIDIA GPU Instances<"')
  const stop = html.indexOf('pc-highlight-table-block__root', at)
  const lines = html
    .slice(at, stop === -1 ? undefined : stop)
    .split('class="pc-highlight-table-block__row"')
    .slice(1)
    .map((r) => r.split('class="pc-highlight-table-block__cell"').slice(1).map(tailText))
  const col = lines[0]?.findIndex((c) => /^Price per GPU-hour$/i.test(c)) ?? -1
  if (col < 0) throw new Error('missing the Price per GPU-hour column')
  const rows = lines.slice(1).flatMap((row) => {
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
  return need(rows.length ? rows : null, 'an H100 or B200 row')
}

/**
 * Crusoe, spring to autumn 2025: the "GPU Pricing" table (from September
 * "GPU VM pricing"), one row per GPU
 * ("NVIDIA H100 80GB SXM"), priced per GPU-hour ("$ 3.90 /hr") in its
 * On-Demand column. Spot ("Contact Sales" for the H100 then) and the reserved
 * columns are other products.
 */
export function crusoeTableArchivedRows(body: string): GpuRow[] {
  const table = need(
    tablesOf(contentOf(body)).find((t) => /^GPU (VM )?Pricing$/i.test(t.rows[0]?.[0] ?? '')),
    'the GPU Pricing table',
  )
  const col = table.rows[0]!.findIndex((c) => /^On-Demand$/i.test(c))
  if (col < 0) throw new Error('missing the On-Demand column')
  const rows = table.rows.slice(1).flatMap((row) => {
    const g = gpuOf(row[0] ?? '')
    const price = dollars(row[col] ?? '')
    if (!g || price === null) return []
    if (!/\/\s*hr$/i.test(row[col]!)) throw new Error(`${row[0]}: "${row[col]}" is not hourly`)
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
  return need(rows.length ? rows : null, 'an on-demand H100 or B200 row')
}

/**
 * Crusoe, December 2025 to October 2026: the Webflow GPU list under the
 * "GPU model, On-demand, Current spot" headings, one item per GPU with its
 * name, a memory tag and a form-factor tag, then an on-demand and a spot
 * cell. Read like the live recipe (gpu-pages.ts › crusoeRows): the name and
 * memory tag as the label, the on-demand cell only.
 */
export function crusoeListArchivedRows(body: string): GpuRow[] {
  const html = contentOf(body)
  const heads = html.split('class="pricing-table-heading')
  const list = heads.find((h) =>
    /^[^>]*>\s*<div class="pricing-heading[^"]*">GPU model<\/div>\s*<div class="pricing-heading[^"]*">On-demand<\/div>/.test(
      h,
    ),
  )
  if (!list) throw new Error('missing the "GPU model, On-demand" list')
  const rows = list
    .split(/<div role="listitem" class="prixing-item\b/)
    .slice(1)
    .flatMap((item) => {
      const name = cellText(item.match(/class="pricing-item-heading">([\s\S]*?)<\/h4>/)?.[1] ?? '')
      const memory = cellText(item.match(/class="pricing-tag[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? '')
      const label = `${name} ${memory}`.trim()
      const g = gpuOf(label)
      const onDemand = cellText(
        item.match(/class="pricing-rich[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? '',
      )
      const price = dollars(onDemand)
      if (!g || price === null) return []
      if (!/\/GPU-hr$/i.test(onDemand))
        throw new Error(`${label}: "${onDemand}" is not per GPU-hour`)
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
  return need(rows.length ? rows : null, 'an on-demand H100 or B200 item')
}

/**
 * DataCrunch (Verda's name until 2025) at datacrunch.io/products: one table
 * per GPU family, a row per instance ("8H100.80S.176V", GPU model "H100 SXM5
 * 80GB", 8 GPUs) priced per instance-hour in its on-demand column ("PRICE ON
 * DEMAND", later "On demand price"). The 6-month and 2-year columns are
 * commitments. The page repeats each table for phones; identical rows
 * collapse.
 */
export function datacrunchProductsArchivedRows(body: string): GpuRow[] {
  // The CPU instance tables carry the same price columns under "CPU model".
  const tables = tablesOf(contentOf(body)).filter(
    (t) =>
      t.rows[0]?.some((c) => /^(PRICE ON DEMAND|On demand price)$/i.test(c)) &&
      t.rows[0]?.some((c) => /^GPU model$/i.test(c)),
  )
  if (tables.length === 0) throw new Error('missing a GPU instance table with an on-demand price')
  const rows = tables.flatMap((t) => {
    const head = t.rows[0]!
    const col = {
      name: head.findIndex((c) => /^Instance name$/i.test(c)),
      model: head.findIndex((c) => /^GPU model$/i.test(c)),
      gpus: head.findIndex((c) => /^GPU$/i.test(c)),
      price: head.findIndex((c) => /^(PRICE ON DEMAND|On demand price)$/i.test(c)),
    }
    if (Object.values(col).some((i) => i === -1))
      throw new Error(`table header reads "${head.join(', ')}"`)
    return t.rows.slice(1).flatMap((row) => {
      const g = gpuOf(row[col.model] ?? '')
      const cell = row[col.price] ?? ''
      const price = dollars(cell)
      if (!g || price === null) return []
      if (!/\/h$/i.test(cell)) throw new Error(`${row[col.name]}: "${cell}" is not hourly`)
      const gpus = Number(row[col.gpus])
      if (!Number.isInteger(gpus) || gpus < 1) throw new Error(`${row[col.name]}: no GPU count`)
      return [
        {
          ...g,
          label: row[col.model]!,
          usd_per_gpu_hour: price / gpus,
          gpus_per_instance: gpus,
          instance_usd_per_hour: price,
          region: null,
          config: row[col.name]!,
        },
      ]
    })
  })
  return need(rows.length ? rows : null, 'an on-demand H100 or B200 instance')
}

/**
 * Together AI at together.ai/gpu-clusters, from March 2026: one card per GPU
 * cluster, "Hardware NVIDIA HGX H100 SXM (80GB) On-demand $2.99/hr per GPU
 * Reserved Starting at $1.75/hr per GPU". The on-demand price is read; the
 * reserved one is a commitment. A card whose hardware is an inference build
 * ("NVIDIA HGX H100 SXM - Inference") is another product than the training
 * clusters the live recipe prices, so it is left out.
 */
export function togetherClustersArchivedRows(body: string): GpuRow[] {
  const text = cellText(contentOf(body))
  const rows = [
    ...text.matchAll(/Hardware (.+?) On-demand (\$\s*[\d.]+)\s*\/\s*hr per GPU\b/g),
  ].flatMap(([, hardware, cell]) => {
    const label = hardware!.replace(/\s*\(\s*(\d+)\s*GB\s*\)/, ' ($1GB)').trim()
    const g = gpuOf(label)
    const price = dollars(cell!)
    if (!g || price === null || /\binference\b/i.test(label)) return []
    return [
      {
        ...g,
        label,
        usd_per_gpu_hour: price,
        gpus_per_instance: null,
        instance_usd_per_hour: null,
        region: null,
        config: 'GPU Clusters',
      },
    ]
  })
  return need(rows.length ? rows : null, 'an on-demand H100 or B200 cluster card')
}
