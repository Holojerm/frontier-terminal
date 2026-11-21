// The lab sites the power table covers, and the words EDGAR full-text search
// is asked for to find a filing that names one.
//
// The sites are Epoch AI's: every site in its newest data-center snapshot that
// names a tracked lab as a user at #confident or #likely (the same rule as the
// /power panel, terminal-datacenters.ts). Epoch's names are its own labels
// ("OpenAI Stargate Abilene"), not words a filing uses, so a site we know has
// the place or project name filings write for it in SITE_SEARCH. A site Epoch
// adds later gets its name with the labs, the owner and the brand words taken
// out, searched beside "data center" (searchFor): a best guess, and the gap
// for that site stays on the table until a filing or a person reads it.

import { inArray } from 'drizzle-orm'

import { LAB_OF_NAME } from '#layers/core/shared/utils/lab-names'
import type { LabId } from '#layers/core/shared/utils/terminal-types/common'
import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { EPOCH_DATA_CENTERS } from '../recipes/epoch-data-centers'

export interface SiteSearch {
  /** The names a filing uses for the site; a hit needs one of them. */
  terms: readonly string[]
  /** A phrase the filing must also have, where the name alone is a common word. */
  with: string | null
}

const DC = 'data center'

/** Filings' names for the sites we know, keyed by Epoch's name, exactly. */
export const SITE_SEARCH: Readonly<Record<string, SiteSearch>> = {
  'Anthropic Lake Mariner': { terms: ['Lake Mariner'], with: null },
  'Core42 Lake Mariner': { terms: ['Lake Mariner'], with: null },
  'Anthropic Barber Lake': { terms: ['Barber Lake'], with: null },
  'Anthropic-Amazon New Carlisle': { terms: ['New Carlisle'], with: DC },
  'OpenAI Stargate Abilene': { terms: ['Abilene'], with: DC },
  'Crusoe Abilene Expansion': { terms: ['Abilene'], with: DC },
  'OpenAI Stargate Shackelford': { terms: ['Shackelford County'], with: null },
  'OpenAI Stargate Milam': { terms: ['Milam County'], with: null },
  'OpenAI Stargate Michigan': { terms: ['Saline Township'], with: null },
  'OpenAI Stargate New Mexico': { terms: ['Doña Ana County', 'Dona Ana County'], with: DC },
  'OpenAI Stargate Wisconsin': { terms: ['Port Washington'], with: DC },
  'OpenAI Stargate Lordstown': { terms: ['Lordstown'], with: DC },
  'OpenAI Stargate UAE': { terms: ['Stargate UAE'], with: null },
  'Microsoft Fairwater Wisconsin': { terms: ['Mount Pleasant'], with: 'Microsoft' },
  'Microsoft Fairwater Atlanta': { terms: ['Fairwater'], with: 'Microsoft' },
  'Microsoft Goodyear': { terms: ['Goodyear'], with: 'Microsoft' },
  'Microsoft-Nebius New Jersey': { terms: ['Vineland'], with: DC },
  'Microsoft Narvik Norway': { terms: ['Narvik'], with: DC },
  'Start Campus Sines Data Campus': { terms: ['Sines'], with: DC },
  'CoreWeave Denton TX': { terms: ['Denton'], with: DC },
  'Meta Prometheus': { terms: ['Prometheus', 'New Albany'], with: DC },
  'Meta Hyperion': { terms: ['Hyperion', 'Richland Parish'], with: DC },
  'Colossus 1': { terms: ['Colossus'], with: 'Memphis' },
  'Colossus 2': { terms: ['Colossus'], with: 'Memphis' },
  'xAI QTS Atlanta': { terms: ['QTS'], with: 'Atlanta' },
}

/** Words in an Epoch name that are a brand, not a place. */
const BRAND = new Set([
  'stargate',
  'fairwater',
  'expansion',
  'campus',
  'data',
  'center',
  'centre',
  'centres',
  'tx',
])

const untag = (s: string) => s.replace(/#\w+/g, '').trim()

/**
 * What to search EDGAR for one site: its entry in SITE_SEARCH, or its name
 * with the owner, the users and the brand words taken out, beside "data
 * center". Null when nothing is left to search for.
 */
export function searchFor(site: Pick<LabSite, 'name' | 'owner' | 'users'>): SiteSearch | null {
  const known = SITE_SEARCH[site.name]
  if (known) return known
  const drop = new Set(
    [site.owner, ...site.users.split(',')]
      .flatMap((n) =>
        untag(n)
          .toLowerCase()
          .split(/[\s-]+/),
      )
      .filter(Boolean),
  )
  const rest = site.name
    .split(/[\s-]+/)
    .filter((w) => w && !drop.has(w.toLowerCase()) && !BRAND.has(w.toLowerCase()))
    .join(' ')
  return rest.length >= 4 ? { terms: [rest], with: DC } : null
}

/** The EDGAR full-text search query for a site: any of its names, and the phrase beside them. */
export function searchQuery(s: SiteSearch): string {
  const any = s.terms.map((t) => `"${t}"`).join(' OR ')
  return s.with ? `(${any}) "${s.with}"` : any
}

export interface LabSite {
  name: string
  labs: LabId[]
  owner: string
  users: string
  country: string
  mw_now: number
}

const ATTRIBUTED = /#(confident|likely)\b/

/** The labs Epoch names as users at #confident or #likely. */
export function attributedLabs(users: string): LabId[] {
  const labs = users
    .split(',')
    .filter((u) => ATTRIBUTED.test(u))
    .map((u) => LAB_OF_NAME[untag(u).toLowerCase().replace(/\s+/g, '-')])
  return [...new Set(labs.filter((l): l is LabId => Boolean(l)))]
}

/** Every site in Epoch's newest snapshot that names a tracked lab, largest first. */
export async function epochLabSites(db: PipelineDb): Promise<LabSite[]> {
  const rows = (
    await db
      .select()
      .from(tables.recipeObservations)
      .where(inArray(tables.recipeObservations.recipe_id, [EPOCH_DATA_CENTERS.id]))
  ).filter((r) => r.value !== null)
  const snapshot = rows.reduce((m, r) => (r.date > m ? r.date : m), '')
  const out: LabSite[] = []
  for (const r of rows) {
    if (r.date !== snapshot) continue
    const p = JSON.parse(r.payload) as { owner?: string; users?: string; country?: string }
    const labs = attributedLabs(p.users ?? '')
    if (labs.length === 0) continue
    out.push({
      name: r.key,
      labs,
      owner: p.owner ?? '',
      users: p.users ?? '',
      country: p.country ?? '',
      mw_now: r.value!,
    })
  }
  return out.sort((a, b) => b.mw_now - a.mw_now || a.name.localeCompare(b.name))
}
