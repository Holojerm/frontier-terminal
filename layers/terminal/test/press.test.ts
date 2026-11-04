import { describe, expect, it } from 'vitest'

import { parsePressList, pressBrief, pressNote } from '../server/pipeline/press'

const ALERT = {
  id: 'abc123',
  headline: 'Anthropic, PBC S-1/A (Amendment No. 2): price range $40.00–$44.00',
  explanation: 'Anthropic, PBC filed S-1/A (Amendment No. 2) on 2026-11-10.',
}

const LIST = JSON.stringify([
  { name: 'Ada Reporter', outlet: 'Wire', email: 'ada@example.com', priority: 1 },
  { name: 'Tips Desk', outlet: 'Paper', tips_email: 'tips@example.com', priority: 2 },
  { name: 'No Address', outlet: 'Blog', priority: 1 },
])

describe('press briefs', () => {
  it('keeps contacts with an address, highest priority first', () => {
    expect(parsePressList(LIST).map((c) => c.name)).toEqual(['Ada Reporter', 'Tips Desk'])
  })

  it('treats a missing or malformed list as no list', () => {
    expect(parsePressList(undefined)).toEqual([])
    expect(parsePressList('not json')).toEqual([])
    expect(parsePressList('[{"name":1}]')).toEqual([])
  })

  it('fills a mailto draft from the alert, greeting a reporter by first name', () => {
    const [ada, desk] = parsePressList(LIST)
    const note = pressNote(ALERT, ada!, 'https://frontierterm.com')
    expect(note.href.startsWith('mailto:ada@example.com?subject=')).toBe(true)
    const body = decodeURIComponent(note.href.split('&body=')[1]!)
    expect(body).toMatch(/^Hi Ada,/)
    expect(body).toContain('https://frontierterm.com/alerts/abc123')
    expect(body).toContain('https://frontierterm.com/revenue')
    expect(pressNote(ALERT, desk!, 'https://frontierterm.com').desk).toBe(true)
  })

  it('mails the owner one link per contact, escaped', () => {
    const brief = pressBrief(
      { ...ALERT, headline: 'A <b> & "c"' },
      parsePressList(LIST),
      'https://frontierterm.com',
    )
    expect(brief.subject).toBe('Press brief ready: A <b> & "c"')
    expect(brief.html).toContain('A &lt;b&gt; &amp; &quot;c&quot;')
    expect(brief.html.match(/<li>/g)).toHaveLength(2)
    expect(brief.text).toContain('Tips Desk, Paper (tips desk)')
  })
})
