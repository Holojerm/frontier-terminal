import { misalignmentIndexItems } from '../../server/pipeline/parsers/disclosures/openai-misalignment-reports'
import { fixtureText } from './fixtures'

export type IndexItem = Record<string, unknown> & {
  title: string
  href: string
  description: string
  reportDates: Record<string, unknown>
  filters: { type: string[] }
}

/** The committed index's entries, as the page's flight payload holds them. */
export function committedIndexItems(): IndexItem[] {
  const items = misalignmentIndexItems(
    fixtureText('fixtures/disclosures/openai-misalignment-reports.html'),
  )
  if (!items) throw new Error('the committed index has no items payload')
  return items as IndexItem[]
}

/** A minimal index page carrying `items` the way the real one does: one flight-payload string. */
export function indexPage(items: readonly IndexItem[]): string {
  const flight = `5:["$","div",null,{"filters":[],"items":${JSON.stringify(items)}}]\n`
  return `<html><body><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`
}

/** The committed entries with one report's fields replaced, by slug. */
export function withReport(slug: string, edit: (item: IndexItem) => IndexItem): IndexItem[] {
  let hit = false
  const items = committedIndexItems().map((i) => {
    if (!i.href.endsWith(`/${slug}/`)) return i
    hit = true
    return edit(structuredClone(i))
  })
  if (!hit) throw new Error(`no report ${slug} in the committed index`)
  return items
}
