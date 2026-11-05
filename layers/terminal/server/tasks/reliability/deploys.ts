// Cron task: read the post-deploy smoke results from GitHub for
// /data#reliability (layers/terminal/server/pipeline/reliability/deploys.ts).
// On the five-minute tick, but a read goes out at most hourly once one has
// succeeded, and not at all while GitHub has refused us. A refusal is
// expected without a token and only logged.

import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import manifest from '~~/fleet.json'

import { recordDeployChecks } from '../../pipeline/reliability/deploys'

export default defineTask({
  meta: {
    name: 'reliability:deploys',
    description: 'Read the post-deploy smoke test results on main from GitHub Actions',
  },
  async run() {
    const result = await recordDeployChecks(db, {
      fetch: (input, init) => fetch(input, init),
      kv,
      now: new Date(),
      repoUrl: manifest.links.github ?? '',
      token: useRuntimeConfig().githubToken,
    })
    if (result.status === 'rate-limited' || result.status === 'failed') {
      console.warn(JSON.stringify({ kind: 'github_deploys_unread', ...result }))
    }
    return { result }
  },
})
