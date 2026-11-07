// Cron task: re-render the enumerable pages after a deploy or a poll moves the
// payload cache key (layers/terminal/server/utils/cache-warm.ts says why).
//
// Scheduled every five minutes from nuxt.config.ts (SCHEDULED_TASKS); a tick
// whose (build, stamp) is already warm costs one D1 read and one KV read.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import { LAB_PAGES } from '../../../shared/utils/terminal-lab-summary'
import { POLL_LOCK_KEY } from '../../pipeline/lock'
import { thesisPages } from '../../../shared/utils/thesis-format'
import { THESES } from '../../theses/registry'
import { warmCaches, warmPaths } from '../../utils/cache-warm'
import { terminalStamps } from '../../utils/terminal-cache'
import { withHeartbeat } from '../../utils/task-heartbeat'

interface CloudflareTaskContext {
  cloudflare?: { context?: { waitUntil?: (promise: Promise<unknown>) => void } }
}

const task = defineTask({
  meta: {
    name: 'cache:warm',
    description:
      'Render the public pages once per (build, poll stamp) so readers hit a warm KV cache',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    const nitro = useNitroApp()
    const cloudflare = (context as CloudflareTaskContext).cloudflare
    // The render reads the host for absolute URLs; this HTML also lands in the
    // cron's edge cache, where readers are served it.
    const host = new URL(config.public.appUrl).host

    const result = await warmCaches(
      {
        store: kv,
        build: config.public.buildSha || 'dev',
        // The key stamp the pages are cached under, so a judge run is warmed too.
        stamp: async () => (await terminalStamps(db)).key,
        // A poll's own warm runs after it releases the lock. If KV still shows
        // the lock then, the next five-minute tick warms instead.
        pollRunning: async () => (await kv.getItem(POLL_LOCK_KEY)) !== null,
        render: async (path) => {
          // The same context shape the Worker's fetch handler hands Nitro, so
          // bindings and waitUntil (the deferred KV writes) reach the render
          // and every API call inside it.
          const init = {
            headers: { host, 'x-forwarded-proto': 'https', accept: 'text/html' },
            context: {
              waitUntil: (promise: Promise<unknown>) => cloudflare?.context?.waitUntil?.(promise),
              _platform: { cloudflare },
            },
          }
          const response = await nitro.localFetch(path, init as RequestInit)
          await response.arrayBuffer()
          return response.status
        },
      },
      warmPaths([...config.publicPages, ...LAB_PAGES, ...thesisPages(THESES)]),
    )

    if (result.status === 'warmed' && result.failed.length > 0) {
      console.warn(JSON.stringify({ kind: 'cache_warm_incomplete', failed: result.failed }))
    }
    return { result }
  },
})

export default withHeartbeat(task)
