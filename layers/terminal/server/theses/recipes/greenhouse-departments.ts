// Open roles per department on a company's public Greenhouse board, counted
// on each run's date. A board is a current state, not a history, so the
// series starts on the first run and grows a point per day.

import type { Recipe } from './contract'

export function extractDepartments(body: string, ctx: { date: string }) {
  const doc = JSON.parse(body) as { departments?: { id: number; name: string; jobs?: unknown[] }[] }
  if (!Array.isArray(doc.departments)) throw new Error('not a Greenhouse departments listing')
  return doc.departments.map((d) => ({
    key: d.name,
    date: ctx.date,
    value: d.jobs?.length ?? 0,
    payload: { department_id: d.id },
  }))
}

export const GREENHOUSE_CLOUDFLARE: Recipe = {
  id: 'greenhouse-cloudflare',
  company: 'cloudflare',
  description: 'Open roles per department on Cloudflare’s Greenhouse board',
  url: () => 'https://boards-api.greenhouse.io/v1/boards/cloudflare/departments',
  ext: 'json',
  extract: extractDepartments,
}
