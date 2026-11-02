// GPU rental prices: the contract every gpu-* recipe's observations obey, and
// the helpers their extractors share. One observation is one published
// on-demand price for one H100 or B200 configuration, normalized to USD per
// GPU-hour, with the provider's own label, configuration and region beside it
// (null where the page prints none).
//
// Only first-party price pages and documented price APIs feed these recipes
// (docs/source-audit.md › GPU rental prices). The Compute thesis reads them
// through server/theses/compute-signals.ts.

import { z } from 'zod'

import type { CompanyId } from '#shared/utils/companies'

import { decodeEntities } from '../../pipeline/parsers/disclosures/html-text'
import type { Observation, Recipe } from './contract'

export const GPU_MODELS = ['H100', 'B200'] as const
export type GpuModel = (typeof GPU_MODELS)[number]

/** The H100 form factors a page may print. SXM and HGX are the same 8-GPU board. */
export const formFactorEnum = z.enum(['SXM', 'HGX', 'PCIe', 'NVL'])

export const gpuPricePayload = z.object({
  provider: z.string().min(1),
  gpu: z.enum(GPU_MODELS),
  /** As printed; null when the page names the GPU without a form factor. */
  form_factor: formFactorEnum.nullable(),
  /**
   * Whether the median counts this row: SXM/HGX boards, or a row that prints
   * no form factor. PCIe and NVL cards are kept as observations, not counted,
   * so the median compares like with like.
   */
  counted: z.boolean(),
  /** The provider's own name for the row, verbatim. */
  label: z.string().min(1),
  gpus_per_instance: z.number().int().positive().nullable(),
  /** The instance price when the page prices the instance, not the GPU. */
  instance_usd_per_hour: z.number().positive().nullable(),
  region: z.string().nullable(),
  /** Anything else that tells two rows of one provider apart (a SKU, a tab). */
  config: z.string().nullable(),
})
export type GpuPricePayload = z.infer<typeof gpuPricePayload>

export const gpuPriceObservation = z.object({
  key: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** USD per GPU-hour, on demand. */
  value: z.number().positive().max(1000),
  payload: gpuPricePayload,
})

export interface GpuRow {
  gpu: GpuModel
  form_factor: z.infer<typeof formFactorEnum> | null
  label: string
  usd_per_gpu_hour: number
  gpus_per_instance: number | null
  instance_usd_per_hour: number | null
  region: string | null
  config: string | null
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Rows to observations, validated against the contract. Identical rows (a
 * page that renders one table twice) collapse; two rows that share a key but
 * disagree on price fail the run rather than store either.
 */
export function gpuObservations(
  provider: CompanyId,
  rows: readonly GpuRow[],
  date: string,
): Observation[] {
  const byKey = new Map<string, Observation>()
  for (const r of rows) {
    const key = [r.gpu, r.form_factor, r.label, r.gpus_per_instance, r.region, r.config]
      .filter((p) => p !== null)
      .map((p) => slug(String(p)))
      .join(':')
    const obs = gpuPriceObservation.parse({
      key,
      date,
      value: Math.round(r.usd_per_gpu_hour * 10_000) / 10_000,
      payload: {
        provider,
        gpu: r.gpu,
        form_factor: r.form_factor,
        counted: r.form_factor !== 'PCIe' && r.form_factor !== 'NVL',
        label: r.label,
        gpus_per_instance: r.gpus_per_instance,
        instance_usd_per_hour: r.instance_usd_per_hour,
        region: r.region,
        config: r.config,
      },
    })
    const held = byKey.get(key)
    if (held && held.value !== obs.value) {
      throw new Error(`${key} is priced twice: ${held.value} and ${obs.value}`)
    }
    byKey.set(key, obs)
  }
  if (byKey.size === 0) throw new Error('no H100 or B200 on-demand price found')
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
}

/** H100 or B200 named in a label, with the form factor it prints. */
export function gpuOf(label: string): { gpu: GpuModel; form_factor: GpuRow['form_factor'] } | null {
  // Whole words only: GB200 (a Grace-Blackwell system) is not a B200 board,
  // and Oracle's "H100T" is not a part it documents.
  const gpu = GPU_MODELS.find((m) => new RegExp(`\\b${m}\\b`).test(label))
  if (!gpu) return null
  const form = label.match(/\b(SXM\d?|HGX|PCIe|NVL)\b/i)?.[1] ?? null
  const form_factor = !form
    ? null
    : /^sxm/i.test(form)
      ? 'SXM'
      : /^hgx$/i.test(form)
        ? 'HGX'
        : /^pcie$/i.test(form)
          ? 'PCIe'
          : 'NVL'
  return { gpu, form_factor }
}

/** "$3.99", "$4.793/h", "$49.24 / Hour" → 3.99; anything else (Contact sales, —) → null. */
export function dollars(text: string): number | null {
  const m = text.replace(/,/g, '').match(/^\s*\$\s*(\d+(?:\.\d+)?)\b/)
  return m ? Number(m[1]) : null
}

/** The page with scripts, styles, inline SVG and noscript blocks dropped, whitespace collapsed. */
export function contentOf(html: string): string {
  return html.replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, '').replace(/\s+/g, ' ')
}

/** Visible text of a fragment; a tag cut off at its end (a split mid-markup) is dropped too. */
export function cellText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>|<[^>]*$/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every `<table>` as rows of cell text, with the text just before it (its heading). */
export function tablesOf(html: string): { before: string; rows: string[][] }[] {
  const out: { before: string; rows: string[][] }[] = []
  for (const m of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = [...m[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((tr) =>
      [...tr[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => cellText(c[1]!)),
    )
    out.push({ before: cellText(html.slice(Math.max(0, m.index - 2000), m.index)), rows })
  }
  return out
}

/** A recipe for one provider's price page, read on the run's date. */
export function gpuRecipe(opts: {
  id: string
  company: CompanyId
  url: string
  ext: 'html' | 'json'
  description: string
  rows: (body: string) => GpuRow[]
}): Recipe {
  return {
    id: opts.id,
    company: opts.company,
    description: opts.description,
    url: () => opts.url,
    ext: opts.ext,
    extract: (body, ctx) => gpuObservations(opts.company, opts.rows(body), ctx.date),
  }
}
