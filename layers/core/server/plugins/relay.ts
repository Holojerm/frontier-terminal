// Registers the relay store, so every fetcher in this Worker reads relayed
// hosts from the Mac mini job's copies (core pipeline/relay.ts).

import { relayStore, registerRelay } from '#layers/core/server/pipeline/relay'

export default defineNitroPlugin(() => {
  registerRelay(relayStore(blob, kv))
})
