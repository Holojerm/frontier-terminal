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

import { absoluteUrl } from './site'

/** A JSON-LD node. Deliberately loose — schema.org is open-world. */
export type JsonLdNode = Record<string, unknown>

export interface SiteContext {
  appName: string
  /** Canonical origin, no trailing slash. Empty disables every builder. */
  appUrl: string
}

/** Stable @id anchors so nodes across pages resolve to the same entities. */
export const SCHEMA_IDS = {
  organization: '#organization',
  website: '#website',
} as const

/** The publisher. The site is its own publisher — there is no separate legal entity to name. */
export function organizationSchema(site: SiteContext): JsonLdNode | null {
  if (!site.appUrl) return null
  return {
    '@type': 'Organization',
    '@id': `${site.appUrl}/${SCHEMA_IDS.organization}`,
    name: site.appName,
    url: site.appUrl,
    logo: `${site.appUrl}/og.png`,
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
 */
export function webPageSchema(
  site: SiteContext,
  page: { url: string; title: string; description: string },
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
