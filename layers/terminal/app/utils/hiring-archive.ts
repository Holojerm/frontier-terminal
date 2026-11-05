// What a page keeps of /api/hiring/history's Internet Archive history. The
// API ships every archived copy with its departments (a few hundred kB for
// all labs), and only /hiring draws the archived series, from the totals and
// the infrastructure cluster. A page's useFetch transform runs on the server,
// so whatever it drops never reaches the page payload.

import type { HiringHistoryData } from '../../shared/utils/terminal-types'

/** Totals and cluster counts only: departments are in the API and /export/archived_hiring. */
export function slimArchive(d: HiringHistoryData): HiringHistoryData {
  return {
    ...d,
    providers: d.providers.map((p) => ({
      ...p,
      archived: p.archived.map((a) => ({
        ...a,
        departments: null,
        clusters: a.clusters?.map((c) => ({ ...c, departments: [] })) ?? null,
      })),
    })),
  }
}

/** No archived history: for pages that show only the live board. */
export function withoutArchive(d: HiringHistoryData): HiringHistoryData {
  return { ...d, reach: [], providers: d.providers.map((p) => ({ ...p, archived: [] })) }
}
