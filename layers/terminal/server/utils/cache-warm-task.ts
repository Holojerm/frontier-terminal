// The poll tasks' last step: a poll that wrote a source_runs row moved the
// payload cache key, so warm it now rather than at the next five-minute tick
// (layers/terminal/server/utils/cache-warm.ts). A quiet poll costs one D1 read
// and one KV read, because the marker for its stamp already exists.

import { runTask } from 'nitropack/runtime'

/** Never fails the poll that called it: the data is stored either way, only the warm is lost. */
export async function warmAfterPoll(context: unknown): Promise<void> {
  try {
    await runTask('cache:warm', { context: context as Record<string, unknown>, payload: {} })
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'cache_warm_failed', error: String(error) }))
  }
}
