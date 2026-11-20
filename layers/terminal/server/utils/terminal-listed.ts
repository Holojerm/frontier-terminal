// The listed-companies table: one row per ticker across the dependency
// graph, the suppliers table and the power table. It joins three payloads
// the site already serves and adds no figure of its own, so a reader gets
// the whole list of names in one place and follows each tie back to the
// table that holds its filing or page.

import type { ListedCompany, ListedData, ListedSupplierTie } from '../../shared/utils/listed'
import type { PowerSitesData } from '../../shared/utils/power-sites'
import {
  SUPPLIER_LAYERS,
  SUPPLIER_RELATIONS,
  type SuppliersData,
} from '../../shared/utils/suppliers'
import type { DependenciesData } from '../../shared/utils/terminal-dependencies'

import type { PipelineDb } from '../pipeline/store'
import type { QueryContext } from './terminal-db'
import { queryDependencies } from './terminal-dependencies'
import { queryPowerSites } from './terminal-recipe-views'
import { buildSuppliers } from './terminal-suppliers'

export const LISTED_RULE =
  'One row per listed company that the graph, the suppliers table or the power table names. Each tie is what a filing or a cited page says, and the three tables measure different things, so the rows aren’t ranked. A row says a source names the company. It isn’t a view on the stock. Not investment advice.'

/** The three tables as one list. Pure: the same inputs give the same rows. */
export function buildListed(
  graph: Pick<DependenciesData, 'nodes' | 'edges'>,
  suppliers: Pick<SuppliersData, 'companies' | 'rows'>,
  power: Pick<PowerSitesData, 'tickers'>,
): Pick<ListedData, 'companies' | 'counts'> {
  const companies = new Map<string, ListedCompany>()
  const at = (ticker: string, company: string) => {
    const c = companies.get(ticker) ?? {
      ticker,
      company,
      lab: null,
      labs: [],
      site_labs: [],
      ties: [],
    }
    companies.set(ticker, c)
    return c
  }
  const add = (into: string[], more: Iterable<string>) => {
    for (const m of more) if (!into.includes(m)) into.push(m)
  }

  const node = new Map(graph.nodes.map((n) => [n.id, n]))
  const labsAmong = (ids: string[]) => ids.filter((id) => node.get(id)?.kind === 'lab')
  const names = (ids: string[]) => ids.map((id) => node.get(id)?.name ?? id)
  for (const n of graph.nodes) {
    if (n.kind !== 'filer' || !n.ticker) continue
    const sells = graph.edges.filter((e) => e.kind === 'buys' && e.to === n.id)
    const funds = graph.edges.filter((e) => e.kind === 'funds' && e.from === n.id)
    const c = at(n.ticker, n.name)
    c.lab = n.lab
    add(c.labs, labsAmong([...sells.map((e) => e.from), ...funds.map((e) => e.to)]))
    c.ties.push({
      source: 'graph',
      sells_to: names(sells.map((e) => e.from)),
      funds: names(funds.map((e) => e.to)),
      figures: [...sells, ...funds].reduce((sum, e) => sum + e.facts.length, 0),
    })
  }

  const byLayer = [...suppliers.companies].sort(
    (a, b) =>
      SUPPLIER_LAYERS.indexOf(a.layer) - SUPPLIER_LAYERS.indexOf(b.layer) ||
      a.ticker.localeCompare(b.ticker),
  )
  for (const s of byLayer) {
    const rows = suppliers.rows.filter((r) => r.ticker === s.ticker)
    const named: ListedSupplierTie['named'] = []
    for (const relation of SUPPLIER_RELATIONS) {
      if (relation === 'concentration') continue
      const who = [
        ...new Set(rows.filter((r) => r.relation === relation).map((r) => r.counterparty)),
      ]
      if (who.length) named.push({ relation, names: who })
    }
    const c = at(s.ticker, s.company)
    add(c.labs, s.labs)
    c.ties.push({
      source: 'suppliers',
      layer: s.layer,
      named,
      unnamed: rows.filter((r) => r.relation === 'concentration').length,
      passages: rows.length,
    })
  }

  for (const p of [...power.tickers].sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    const c = at(p.ticker, p.company)
    add(c.site_labs, p.labs)
    c.ties.push({ source: 'power', roles: p.roles, sites: p.sites })
  }

  const all = [...companies.values()]
  const from = (source: ListedCompany['ties'][number]['source']) =>
    all.filter((c) => c.ties.some((t) => t.source === source)).length
  return {
    companies: all,
    counts: {
      companies: all.length,
      graph: from('graph'),
      suppliers: from('suppliers'),
      power: from('power'),
      lab_tied: all.filter((c) => c.lab || c.labs.length || c.site_labs.length).length,
    },
  }
}

export async function queryListed(db: PipelineDb, ctx: QueryContext): Promise<ListedData> {
  const [graph, power] = await Promise.all([queryDependencies(db, ctx), queryPowerSites(db)])
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    rule: LISTED_RULE,
    ...buildListed(graph, buildSuppliers(), power),
  }
}
