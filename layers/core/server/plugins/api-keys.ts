// Adds the licensee-key counters to GET /api/fleet's `extra` section.

export default defineNitroPlugin(() => {
  registerFleetExtraContributor({
    key: 'api-keys',
    collect: (db, now) => collectApiKeyCounters(db, kv, now),
  })
})
