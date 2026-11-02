// Every public URL a crawler document names, and the /llms.txt input built
// from them — in one place because three readers need the same answer:
// sitemap.xml, /llms.txt, and the MCP `describe` tool, which hands an agent
// the llms.txt body. The MCP copy once listed only the route-table pages, so
// an agent asking what the site holds was never told the lab pages, the
// theses, or the bulk tables existed.

import type { PublicPage } from '#shared/utils/site'
import { COMPARE_PAGES } from '../../shared/utils/terminal-compare'
import { LAB_PAGES } from '../../shared/utils/terminal-lab-summary'
import { thesisPages } from '../../shared/utils/thesis-format'

import manifest from '~~/fleet.json'
import { THESES } from '../theses/registry'
import type { LlmsTxtInput } from '#server/utils/seo'
import { EXPORT_TABLES } from './terminal-export'

/** The route-table pages plus the dynamic ones enumerable without a query. */
export function crawlerPages(publicPages: PublicPage[] | undefined): PublicPage[] {
  return [...(publicPages ?? []), ...LAB_PAGES, ...COMPARE_PAGES, ...thesisPages(THESES)]
}

/** The pages that read only some labs, dated by those labs' changes (seo.ts › dataLastmods). */
export function labScopedPages(): Record<string, readonly string[]> {
  return Object.fromEntries([
    ...LAB_PAGES.map((page) => [page.path, [page.lab]] as const),
    ...COMPARE_PAGES.map((page) => [page.path, page.labs] as const),
  ])
}

export function llmsTxtInput(config: {
  appName: string
  appUrl: string
  appDescription: string
  publicPages: PublicPage[] | undefined
}): LlmsTxtInput {
  return {
    appName: config.appName,
    appUrl: config.appUrl,
    description: config.appDescription,
    pages: crawlerPages(config.publicPages),
    tables: Object.values(EXPORT_TABLES).map((table) => ({
      name: table.name,
      description: table.description,
    })),
    repoUrl: manifest.links.github ?? '',
  }
}
