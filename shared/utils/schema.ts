// JSON-LD (schema.org) builders — the AEO half of this template's SEO layer.
//
// Classic SEO is about being *findable*. Answer engines — AI Overviews,
// ChatGPT Search, Perplexity, Claude — are about being *quotable*: they need to
// extract, without guessing, what this site is and who publishes it. Prose can
// be paraphrased wrongly. A typed graph can't.
//
// Everything here is a pure function of an explicit SiteContext, so the shapes
// are unit-testable (test/seo.test.ts) without booting Nuxt. `useSeo()` is what
// actually injects them into the document.
//
// Two rules worth keeping:
//   1. Nodes are linked by `@id`, not duplicated. One Organization node, one
//      WebSite node, and everything else points at them — that's what lets a
//      consumer resolve "this page" and "this company" to a single entity
//      instead of four unrelated blobs.
//   2. Never describe something in JSON-LD that isn't visible on the page.
//      Markup for content that isn't rendered is a manual-action risk with
//      Google and, more practically, a lie an answer engine will repeat.

import { DATA_LICENSE } from './license'
import { absoluteUrl } from './site'

/** A JSON-LD node. Deliberately loose — schema.org is open-world. */
export type JsonLdNode = Record<string, unknown>

export interface SiteContext {
  appName: string
  /** Canonical origin, no trailing slash. Empty disables every builder. */
  appUrl: string
  /** Public source repository, from fleet.json. Empty omits `sameAs`. */
  repoUrl: string
}

/** Stable @id anchors so nodes across pages resolve to the same entities. */
export const SCHEMA_IDS = {
  organization: '#organization',
  website: '#website',
  /** The one DataCatalog every Dataset node points back at. Anchored on /data. */
  dataCatalog: '#data-catalog',
} as const

/**
 * The catalog's `@id`. Unlike the site-wide anchors above it hangs off a real
 * page rather than the origin, because the catalog *is* /data — the node and
 * the page a reader would open describe the same thing.
 */
export function dataCatalogId(site: SiteContext): string {
  return `${absoluteUrl(site.appUrl, '/data')}${SCHEMA_IDS.dataCatalog}`
}

/** The publisher. The site is its own publisher — there is no separate legal entity to name. */
export function organizationSchema(site: SiteContext): JsonLdNode | null {
  if (!site.appUrl) return null
  return {
    '@type': 'Organization',
    '@id': `${site.appUrl}/${SCHEMA_IDS.organization}`,
    name: site.appName,
    url: site.appUrl,
    logo: `${site.appUrl}/og.png`,
    // The repo is the only other place this entity exists on the open web.
    // Without it an answer engine has a name and a domain and no way to tell
    // that the code producing the numbers is the code it can go read.
    ...(site.repoUrl ? { sameAs: [site.repoUrl] } : {}),
  }
}

export function websiteSchema(site: SiteContext): JsonLdNode | null {
  if (!site.appUrl) return null
  return {
    '@type': 'WebSite',
    '@id': `${site.appUrl}/${SCHEMA_IDS.website}`,
    name: site.appName,
    url: site.appUrl,
    publisher: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    inLanguage: 'en',
  }
}

/**
 * The page itself. Emitted on every indexable page so each URL has a node an
 * answer engine can attribute a quote to, rather than only the site root.
 *
 * `dateModified` is the one field here worth the wiring. Every page on this
 * site restates numbers that change daily, and the question an answer engine
 * is actually asked — "what does Claude's API cost right now" — is answered
 * wrongly by a stale quote with no date on it. Pages pass the poll tick the
 * data reflects (`Stamp.as_of`), not the render time, so the claim is about
 * the data rather than about the request.
 */
export function webPageSchema(
  site: SiteContext,
  page: { url: string; title: string; description: string; dateModified?: string | null },
): JsonLdNode | null {
  if (!site.appUrl || !page.url) return null
  return {
    '@type': 'WebPage',
    '@id': page.url,
    url: page.url,
    name: page.title,
    description: page.description,
    isPartOf: { '@id': `${site.appUrl}/${SCHEMA_IDS.website}` },
    inLanguage: 'en',
    ...(page.dateModified ? { dateModified: page.dateModified } : {}),
  }
}

/**
 * The catalog on /data: one node saying that a set of downloadable tables
 * exists, is free, and is licensed. Every Dataset points at it by `@id`, which
 * is what turns seven unrelated downloads into one publication.
 */
export function dataCatalogSchema(
  site: SiteContext,
  catalog: { description: string; dateModified?: string | null },
): JsonLdNode | null {
  if (!site.appUrl) return null
  return {
    '@type': 'DataCatalog',
    '@id': dataCatalogId(site),
    url: absoluteUrl(site.appUrl, '/data'),
    name: `${site.appName} data`,
    description: catalog.description,
    license: DATA_LICENSE.url,
    isAccessibleForFree: true,
    publisher: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    inLanguage: 'en',
    ...(catalog.dateModified ? { dateModified: catalog.dateModified } : {}),
  }
}

export interface DatasetInput {
  /**
   * Absolute URL of the page documenting this dataset. Also the base of its
   * `@id`, which appends `#dataset` (plus `slug`, where one page carries many).
   */
  url: string
  /** Distinguishes sibling datasets documented on the same page. */
  slug?: string
  name: string
  description: string
  /** ISO 8601 of the newest observation behind it. */
  dateModified?: string | null
  /** `YYYY-MM-DD/YYYY-MM-DD`, or an open interval — schema.org's own format. */
  temporalCoverage?: string | null
  /** Column names, or the quantities measured. */
  variableMeasured?: readonly string[]
  /** Downloads, as `{ format, url }`. A dataset with none is still a dataset. */
  distribution?: readonly { encodingFormat: string; contentUrl: string }[]
  /** Rows, where the count is known and cheap. */
  rows?: number | null
}

/**
 * A Dataset node — the schema.org type this whole site is, and the one type
 * with a search index of its own (Google Dataset Search) rather than a
 * rich-result treatment.
 *
 * `distribution` is the part that does the work: a DataDownload with a real
 * `contentUrl` and `encodingFormat` is the difference between "a page about
 * some numbers" and "a machine-readable table at this URL". Pass only formats
 * that actually resolve — a 404 in a distribution is worse than an omission.
 */
export function datasetSchema(site: SiteContext, dataset: DatasetInput): JsonLdNode | null {
  if (!site.appUrl || !dataset.url) return null
  const id = `${dataset.url}#dataset${dataset.slug ? `-${dataset.slug}` : ''}`
  return {
    '@type': 'Dataset',
    '@id': id,
    url: dataset.url,
    name: dataset.name,
    description: dataset.description,
    license: DATA_LICENSE.url,
    isAccessibleForFree: true,
    creator: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    publisher: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    includedInDataCatalog: { '@id': dataCatalogId(site) },
    inLanguage: 'en',
    ...(dataset.dateModified ? { dateModified: dataset.dateModified } : {}),
    ...(dataset.temporalCoverage ? { temporalCoverage: dataset.temporalCoverage } : {}),
    ...(dataset.variableMeasured?.length
      ? { variableMeasured: [...dataset.variableMeasured] }
      : {}),
    ...(typeof dataset.rows === 'number' ? { size: `${dataset.rows} rows` } : {}),
    ...(dataset.distribution?.length
      ? {
          distribution: dataset.distribution.map((d) => ({
            '@type': 'DataDownload',
            encodingFormat: d.encodingFormat,
            contentUrl: d.contentUrl,
          })),
        }
      : {}),
  }
}

export interface ArticleInput {
  url: string
  headline: string
  description: string
  /** ISO 8601. An append-only row's creation time is exact. */
  datePublished: string
  dateModified?: string | null
  /**
   * The sources the piece rests on, as URLs. On an alert these are the source
   * URLs of the change rows it cites — the same links the page renders, which
   * is what keeps this side of rule 2.
   */
  citation?: readonly string[]
}

/**
 * An Article node for a page that makes a dated claim — here, an alert
 * permalink. These are the most quotable URLs on the site and the only ones
 * where WebPage undersells what is there: a WebPage has no author, no
 * publication date and nowhere to put the sources, so a quote from one is
 * attributable to nobody and datable to nothing.
 */
export function articleSchema(site: SiteContext, article: ArticleInput): JsonLdNode | null {
  if (!site.appUrl || !article.url) return null
  const citation = [...new Set(article.citation ?? [])].filter(Boolean)
  return {
    '@type': 'Article',
    '@id': `${article.url}#article`,
    url: article.url,
    headline: article.headline,
    description: article.description,
    datePublished: article.datePublished,
    dateModified: article.dateModified ?? article.datePublished,
    author: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    publisher: { '@id': `${site.appUrl}/${SCHEMA_IDS.organization}` },
    isPartOf: { '@id': `${site.appUrl}/${SCHEMA_IDS.website}` },
    license: DATA_LICENSE.url,
    inLanguage: 'en',
    ...(citation.length ? { citation } : {}),
  }
}

export function breadcrumbSchema(
  site: SiteContext,
  trail: { name: string; path: string }[],
): JsonLdNode | null {
  if (!site.appUrl || trail.length === 0) return null
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(site.appUrl, crumb.path),
    })),
  }
}

/**
 * Fold nodes into a single `@graph` document. One <script> per page rather than
 * one per node: consumers parse the whole graph at once, and `@id` references
 * between nodes only resolve reliably inside a shared graph.
 */
export function jsonLdGraph(nodes: (JsonLdNode | null | undefined)[]): string {
  const graph = nodes.filter((node): node is JsonLdNode => Boolean(node))
  // Escape `<` so a value containing `</script>` can't close the tag this JSON
  // is about to be embedded in. \u003c is still a plain `<` to any JSON parser.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
    /</g,
    '\\u003c',
  )
}
