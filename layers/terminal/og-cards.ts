// Share cards for the routes that a page file cannot enumerate: the lab pages,
// their tear sheets, the compare pairs and the theses. Titles and one line of
// what the page is, never a live number: a card is drawn once per build and a
// price on it would go stale. The pages link them with `ogCardPath()`.
// Read by scripts/og-images.ts.
import type { OgCard } from '../../scripts/lib/og-source'
import { COMPARE_PAGES } from './shared/utils/terminal-compare'
import { LAB_PAGES, TEAR_SHEET_PAGES } from './shared/utils/terminal-lab-summary'
import { thesisPages } from './shared/utils/thesis-format'
import { THESES } from './server/theses/registry'

export default function ogCards(): OgCard[] {
  return [
    ...LAB_PAGES.map((page) => ({
      path: page.path,
      title: page.title,
      summary: 'API pricing, revenue, hiring and outages on one page.',
    })),
    ...TEAR_SHEET_PAGES.map((page) => ({
      path: page.path,
      title: page.title,
      summary: 'Every axis on one printable page, with each source and its fetch time.',
    })),
    ...COMPARE_PAGES.map((page) => ({
      path: page.path,
      title: page.title,
      summary: 'Side by side on every axis the terminal tracks.',
    })),
    ...thesisPages(THESES).map((page) => ({
      path: page.path,
      title: page.title,
      summary: 'Each claim, its kill condition and what the evidence says now.',
    })),
  ]
}
