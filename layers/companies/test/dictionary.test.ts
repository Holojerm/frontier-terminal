import { describe, expect, it } from 'vitest'

import { fixtureText } from '#layers/core/test/pipeline/fixtures'
import { dataDictionary } from '#server/registries/dictionary'

const sourcesYaml = fixtureText('sources.yaml')

describe('the companies tables in the data dictionary', () => {
  it('keys entity_securities by entity and symbol, which no two rows share', () => {
    const t = dataDictionary(sourcesYaml).tables.find((x) => x.name === 'entity_securities')!
    const keys = ENTITY_SECURITIES.map((row) =>
      t.key.map((k) => row[k as keyof typeof row]).join('\n'),
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})
