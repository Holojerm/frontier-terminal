import { describe, expect, it } from 'vitest'

import { ALERTS_FEED_PATH, alertEntryId, buildAlertsAtom } from '../server/utils/terminal-feed'
import type { AlertView } from '../shared/utils/terminal-types'

// The Atom feed as a document. workerd has no XML parser, so well-formedness
// is checked the way it fails in practice — an unescaped character or an
// unbalanced tag — with a small tag-balance walk over the output.

const alert = (overrides: Partial<AlertView> = {}): AlertView => ({
  id: 'a1b2c3',
  severity: 'critical',
  headline: 'S-1/A filed by SPCX (2026-09-01)',
  explanation: 'Accession 0001628280-26-099999: form S-1/A filed 2026-09-01 by whitelisted CIK.',
  rule: 's1-floor',
  created_at: '2026-09-07T10:00:05.000Z',
  change_ids: ['c1'],
  changes: [],
  missing_change_ids: [],
  source_url: 'https://efts.sec.gov/LATEST/search-index?q=%22Anthropic%22&forms=S-1',
  fetched_at: '2026-09-07T10:00:05.000Z',
  ...overrides,
})

/** Every open tag has a matching close tag, in order; self-closing tags are skipped. */
function assertBalanced(xml: string): void {
  const stack: string[] = []
  const tags = xml.replace(/^<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w:-]*)[^>]*?(\/?)>/g)
  for (const [, closing, name, selfClosing] of tags) {
    if (selfClosing) continue
    if (closing) {
      expect(stack.pop(), `closing </${name}>`).toBe(name)
    } else {
      stack.push(name!)
    }
  }
  expect(stack).toEqual([])
}

const SITE = { appName: 'Frontier Terminal', appUrl: 'https://example.com' }

describe('buildAlertsAtom', () => {
  it('is a well-formed Atom feed with the required feed-level elements', () => {
    const xml = buildAlertsAtom({
      ...SITE,
      alerts: [alert()],
      fallbackUpdated: '2026-01-01T00:00:00Z',
    })
    assertBalanced(xml)
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">',
      ),
    ).toBe(true)
    expect(xml).toContain(`<id>https://example.com${ALERTS_FEED_PATH}</id>`)
    expect(xml).toContain('<title>Frontier Terminal — alerts</title>')
    expect(xml).toContain('<author><name>Frontier Terminal</name></author>')
    // The feed's updated is the newest entry's timestamp.
    expect(xml).toContain('<updated>2026-09-07T10:00:05.000Z</updated>')
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://example.com/alerts.xml"/>',
    )
  })

  it('carries one entry per alert: id, headline, explanation, page link, and the source as a related link', () => {
    const xml = buildAlertsAtom({
      ...SITE,
      alerts: [alert()],
      fallbackUpdated: '2026-01-01T00:00:00Z',
    })
    expect(xml).toContain('<entry>')
    expect(xml).toContain('<id>https://example.com/alerts#a1b2c3</id>')
    expect(xml).toContain('<title>S-1/A filed by SPCX (2026-09-01)</title>')
    expect(xml).toContain(
      '<summary type="text">Accession 0001628280-26-099999: form S-1/A filed 2026-09-01 by whitelisted CIK.</summary>',
    )
    expect(xml).toContain(
      '<link rel="alternate" type="text/html" href="https://example.com/alerts#a1b2c3"/>',
    )
    // The & in the query string must be escaped, and the fetch time travels on the link.
    expect(xml).toContain(
      '<link rel="related" href="https://efts.sec.gov/LATEST/search-index?q=%22Anthropic%22&amp;forms=S-1" title="source, fetched 2026-09-07T10:00:05.000Z"/>',
    )
    expect(xml).toContain('<category term="critical" label="severity"/>')
    expect(xml).toContain('<category term="s1-floor" label="rule"/>')
  })

  it('escapes markup in headlines and explanations so an alert cannot break the document', () => {
    const xml = buildAlertsAtom({
      ...SITE,
      alerts: [alert({ id: 'x', headline: 'Haiku <33% & "cheaper"', explanation: "it's </feed>" })],
      fallbackUpdated: '2026-01-01T00:00:00Z',
    })
    assertBalanced(xml)
    expect(xml).toContain('<title>Haiku &lt;33% &amp; &quot;cheaper&quot;</title>')
    expect(xml).toContain('<summary type="text">it&apos;s &lt;/feed&gt;</summary>')
  })

  it('with no alerts is still a valid feed, dated by the fallback', () => {
    const xml = buildAlertsAtom({
      ...SITE,
      alerts: [],
      fallbackUpdated: '2026-09-07T10:00:00.000Z',
    })
    assertBalanced(xml)
    expect(xml).not.toContain('<entry>')
    expect(xml).toContain('<updated>2026-09-07T10:00:00.000Z</updated>')
  })

  it('falls back to URNs when no origin is configured, since an Atom id must be an IRI', () => {
    expect(alertEntryId('', 'abc')).toBe('urn:sha256:abc')
    expect(alertEntryId('https://example.com/', 'abc')).toBe('https://example.com/alerts#abc')
    const xml = buildAlertsAtom({
      appName: 'T',
      appUrl: '',
      alerts: [alert()],
      fallbackUpdated: 'x',
    })
    assertBalanced(xml)
    expect(xml).toContain('<id>urn:frontier-terminal:alerts</id>')
    expect(xml).toContain('<id>urn:sha256:a1b2c3</id>')
  })
})
