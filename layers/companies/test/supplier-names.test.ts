import { describe, expect, it } from 'vitest'

import { counterpartyNamed, nameKey } from '../server/suppliers/filers'
import { checkPassage } from '../server/suppliers/review'

// How a name a filing writes finds its counterparty. The matches are names as SEC filings write
// them (HUT's guarantee row reads "Google LLC"); the misses are other companies that share a
// first word with a tracked one.

const named = (name: string) => counterpartyNamed(name)?.name ?? null

describe('counterparty names', () => {
  it.each([
    ['Google LLC', 'Google'],
    ['Alphabet Inc.', 'Google'],
    ['OpenAI OpCo, LLC', 'OpenAI'],
    ['OpenAI, L.L.C.', 'OpenAI'],
    ['Anthropic PBC', 'Anthropic'],
    ['Anthropic, PBC', 'Anthropic'],
    ['X.AI Corp.', 'xAI'],
    ['X.AI LLC', 'xAI'],
    ['Meta Platforms, Inc.', 'Meta'],
    ['Microsoft Corporation', 'Microsoft'],
    ['Amazon.com, Inc.', 'Amazon'],
    ['Amazon Web Services, Inc.', 'Amazon'],
    ['Oracle Corporation', 'Oracle'],
    ['NVIDIA Corporation', 'Nvidia'],
    ['Advanced Micro Devices, Inc.', 'AMD'],
    ['CoreWeave, Inc.', 'CoreWeave'],
    ['Alibaba Group Holding Limited', 'Alibaba'],
    ['Mistral AI SAS', 'Mistral AI'],
    ['Moonshot AI Ltd.', 'Moonshot AI'],
    ['Fluidstack Ltd', 'Fluidstack'],
    ['The Google LLC', 'Google'],
    ['  google   llc ', 'Google'],
  ])('reads %s as %s', (written, name) => {
    expect(named(written)).toBe(name)
  })

  it.each([
    'Meta Materials Inc.',
    'Oracle Financial Services Software Limited',
    'Mistral Solutions Pvt. Ltd.',
    'Moonshot Capital LLC',
    'Dell Financial Services L.L.C.',
    'Microsoft Ireland Operations Limited',
    'Amazon.com Services LLC',
    'Google Cloud',
    'Customer A',
    'the other end customer',
    'The Company',
    'Inc.',
  ])('keeps %s apart from every tracked counterparty', (written) => {
    expect(named(written)).toBeNull()
  })

  it('never strips a name to nothing', () => {
    expect(nameKey('Co.')).toBe('co')
    expect(nameKey('Holdings, Inc.')).toBe('holdings')
  })

  it('reads the lab and ticker off a suffixed name', () => {
    expect(counterpartyNamed('Google LLC')).toMatchObject({ ticker: 'GOOGL', lab: 'google' })
  })

  it('still turns away an unnamed-customer share that names a company with its suffix', () => {
    const quote =
      'Google LLC accounted for 31% of our revenue for the nine months ended September 30.'
    expect(
      checkPassage(
        {
          relation: 'concentration',
          counterparty: 'Google LLC',
          figures: [],
          quote,
          alias: null,
        },
        quote,
      ),
    ).toMatchObject({ reason: 'concentration-names-a-company' })
  })
})
