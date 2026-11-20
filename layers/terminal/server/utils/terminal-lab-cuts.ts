// One lab's slice of an all-lab payload, for the routes that take `?lab=`.
// Each cut runs on the cached all-lab payload, so every lab page reads the one
// KV entry the axis page fills. A payload that trims its lists before caching
// can't be cut here, because the trim would hide the lab's older rows; ground
// truth filters inside its query instead (queryGroundTruth's `lab`).

import { z } from 'zod'
import type { ListedCompany, ListedData } from '../../shared/utils/listed'
import { LABS } from '../../shared/utils/terminal-lab-summary'
import type { DisclosuresData, LabId, ProbesData } from '../../shared/utils/terminal-types'

export const labQuerySchema = z.object({ lab: z.enum(LABS as [LabId, ...LabId[]]).optional() })

export function probesForLab(data: ProbesData, lab: LabId): ProbesData {
  return { ...data, labs: data.labs.filter((l) => l.lab === lab) }
}

export function disclosuresForLab(data: DisclosuresData, lab: LabId): DisclosuresData {
  return {
    ...data,
    providers: data.providers.filter((p) => p.provider === lab),
    entries: data.entries.filter((e) => e.provider === lab),
  }
}

/** Tied to the lab by being it or its parent, by a filing that names it, or by a site it uses. */
export const listedTiedTo = (c: ListedCompany, lab: LabId): boolean =>
  c.lab === lab || c.labs.includes(lab) || c.site_labs.includes(lab)

export function listedForLab(data: ListedData, lab: LabId): ListedData {
  const companies = data.companies.filter((c) => listedTiedTo(c, lab))
  const from = (source: ListedCompany['ties'][number]['source']) =>
    companies.filter((c) => c.ties.some((t) => t.source === source)).length
  return {
    ...data,
    companies,
    counts: {
      companies: companies.length,
      graph: from('graph'),
      suppliers: from('suppliers'),
      power: from('power'),
      lab_tied: companies.length,
    },
  }
}
