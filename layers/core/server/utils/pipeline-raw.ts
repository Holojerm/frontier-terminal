// Raw payload store (R2 via NuxtHub's `blob`): every derived number keeps its
// source bytes.

/** Where raw payloads go. R2 in production (NuxtHub `blob`), the test binding in workerd. */
export interface RawStore {
  put(key: string, body: string, contentType: string): Promise<void>
}

/** NuxtHub's `blob` (or anything with its put signature) as a RawStore. */
export function blobRawStore(blob: {
  put(pathname: string, body: string, options?: { contentType?: string }): Promise<unknown>
}): RawStore {
  return {
    put: async (key, body, contentType) => {
      await blob.put(key, body, { contentType })
    },
  }
}

/** Reads an R2 object's text; null when it is not there. */
export type RawReader = (key: string) => Promise<string | null>

/** NuxtHub's `blob` (or anything with its get signature) as a RawReader. */
export function blobRawReader(blob: {
  get(key: string): Promise<{ text(): Promise<string> } | null>
}): RawReader {
  return async (key) => {
    const object = await blob.get(key)
    return object ? object.text() : null
  }
}
