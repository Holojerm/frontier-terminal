import { relayStore } from '../../server/pipeline/relay'

/** R2 and KV as maps, with the methods the relay calls. */
export function relayMemory() {
  const objects = new Map<string, Uint8Array>()
  // Values go through JSON, as unstorage's do.
  const keys = new Map<string, string>()
  const blob = {
    get: async (key: string) => {
      const b = objects.get(key)
      return b
        ? {
            arrayBuffer: async () => b.slice().buffer as ArrayBuffer,
            text: async () => new TextDecoder().decode(b),
          }
        : null
    },
    put: async (key: string, body: string | Uint8Array) => {
      objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body)
    },
    del: async (pathnames: string[]) => {
      for (const key of pathnames) objects.delete(key)
    },
  }
  const kv = {
    get: async (key: string): Promise<unknown> => {
      const held = keys.get(key)
      return held === undefined ? null : JSON.parse(held)
    },
    set: async (key: string, value: unknown) => {
      keys.set(key, JSON.stringify(value))
    },
    del: async (key: string) => {
      keys.delete(key)
    },
    keys: async (base = '') => [...keys.keys()].filter((k) => k.startsWith(base)),
  }
  return { blob, kv, objects, keys, store: relayStore(blob, kv) }
}
