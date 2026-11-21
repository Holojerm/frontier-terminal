// Adds the licensee-key counters to GET /api/fleet's `extra` section.

import { kv } from '@nuxthub/kv'

import { registerFleetExtraContributor } from '#server/utils/extensions'

import { collectApiKeyCounters } from '../utils/api-keys'

export default defineNitroPlugin(() => {
  registerFleetExtraContributor({
    key: 'api-keys',
    collect: (db, now) => collectApiKeyCounters(db, kv, now),
  })
})
