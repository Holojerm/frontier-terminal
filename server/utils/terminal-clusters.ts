// Department clusters, read from the department_clusters block in
// sources.yaml: a named set of match terms over each board's own department
// labels. The physical-infrastructure cluster is the buildout signal — open
// roles in Data Center / Infrastructure / Facilities / Energy / Construction
// (and the like) per lab per day — and its terms are stated in the audited
// file, never typed into the query layer, so the judge prompt and the panel
// name the same departments (test/terminal-clusters.test.ts pins the pair).
//
// Matching is a whole-word, case-insensitive substring test on the label,
// minus any label that carries an `exclude` term ("Software Engineering -
// Infrastructure" is code, not concrete). Which labels matched ships beside
// every count, so the sum is never a black box.

import type { ClusterSeries, DeptSeries } from '#shared/utils/terminal-types'

import { byString } from './terminal-json'

export interface DepartmentCluster {
  id: string
  label: string
  terms: string[]
  exclude: string[]
}

const splitTerms = (raw: string): string[] =>
  raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/** Narrow block reader in the sources.yaml house style: `  id:` then
 * 4-space `label:` / `terms:` / `exclude:` scalars; a `>-` folded field
 * (`why:`) is skipped with its continuation lines. */
export function parseDepartmentClusters(yaml: string): DepartmentCluster[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^department_clusters:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no department_clusters block')

  const clusters: DepartmentCluster[] = []
  let current: DepartmentCluster | null = null
  let folding = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const head = line.match(/^ {2}([a-z0-9-]+):\s*(#.*)?$/)
    if (head) {
      current = { id: head[1]!, label: head[1]!, terms: [], exclude: [] }
      clusters.push(current)
      folding = false
      continue
    }
    if (!current) continue
    const field = line.match(/^ {4}([a-z]+):\s*(.*?)\s*$/)
    if (field) {
      const value = field[2]!.replace(/\s+#.*$/, '')
      folding = value === '>-' || value === '>'
      if (field[1] === 'label') current.label = value
      else if (field[1] === 'terms') current.terms = splitTerms(value)
      else if (field[1] === 'exclude') current.exclude = splitTerms(value)
      continue
    }
    if (folding && /^ {6,}\S/.test(line)) continue
    throw new Error(
      `department_clusters line ${i + 1} is not a cluster field: ${JSON.stringify(line)}`,
    )
  }
  for (const c of clusters) {
    if (c.terms.length === 0) throw new Error(`department_clusters ${c.id}: no terms`)
  }
  return clusters
}

const wordRegex = (term: string) =>
  new RegExp(
    `(^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`,
  )

/** True when a department label belongs to the cluster. */
export function inCluster(department: string, cluster: DepartmentCluster): boolean {
  const label = department.toLowerCase()
  if (cluster.exclude.some((t) => wordRegex(t).test(label))) return false
  return cluster.terms.some((t) => wordRegex(t).test(label))
}

/**
 * The cluster's series on one board: matched departments summed per day.
 * `thenIndex` is the comparison point the board's HiringCompare uses (or
 * null before there are two points), so now/then agree with the mix table.
 */
export function clusterSeries(
  cluster: DepartmentCluster,
  departments: readonly DeptSeries[],
  dates: readonly string[],
  thenIndex: number | null,
): ClusterSeries {
  const matched = departments.filter((d) => inCluster(d.department, cluster))
  const series = dates.map((_, i) => matched.reduce((n, d) => n + (d.series[i] ?? 0), 0))
  const last = dates.length - 1
  return {
    id: cluster.id,
    label: cluster.label,
    departments: matched
      .map((d) => ({
        department: d.department,
        then: thenIndex === null ? 0 : (d.series[thenIndex] ?? 0),
        now: d.series[last] ?? 0,
      }))
      .sort((a, b) => b.now - a.now || byString(a.department, b.department)),
    series,
    now: series[last] ?? 0,
    then: thenIndex === null ? null : (series[thenIndex] ?? 0),
    then_at: thenIndex === null ? null : (dates[thenIndex] ?? null),
  }
}
