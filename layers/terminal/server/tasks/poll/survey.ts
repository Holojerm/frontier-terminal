// Cron task: poll every include source every six hours (layers/core/server/pipeline/scopes.ts).
// Same wiring and the same reasons as poll/edgar.ts.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import { createFetcher } from '#layers/core/server/pipeline/fetch'
import { unstorageLockStore } from '#layers/core/server/pipeline/lock'
import { runPoll } from '#layers/core/server/pipeline/poll'
import { blobRawStore } from '#layers/core/server/pipeline/raw'
import { writeGpuMedianAlerts } from '#layers/compute/server/pipeline/gpu-median-floor'
import { paceSec } from '#layers/core/server/pipeline/sec-pace'
import { evaluateTheses } from '../../theses/evaluate'
import { runRecipes } from '../../theses/recipes/run'
import { recordOpsEvent } from '#server/utils/ops'
import { warmAfterPoll } from '#layers/core/server/utils/cache-warm-task'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'poll:survey',
    description:
      'Fetch every include source (pricing, hiring, EDGAR, rankings); diff and store; evaluate the theses',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    // One paced fetcher for the poll and the recipes, so the SEC spacing
    // counts the whole tick (layers/core/server/pipeline/sec-pace.ts).
    const fetcher = paceSec(
      createFetcher({
        secContactEmail: config.secContactEmail,
        openrouterApiKey: config.openrouterApiKey,
        githubToken: config.githubToken,
        appUrl: config.public.appUrl,
      }),
    )
    const result = await runPoll('survey', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher,
      sourcesYaml,
    })
    // The theses read what this tick stored, so they run after it: recipes
    // first (their own fetches), then the evaluation. A failure here must not
    // undo or hide the poll, so it is spooled for the digest.
    const recipes = await runRecipes(db, {
      raw: blobRawStore(blob),
      fetcher,
      now: () => new Date(),
    }).catch(async (error: unknown) => {
      await recordOpsEvent(db, { kind: 'recipes_run_failed', detail: String(error) })
      return null
    })
    // The GPU median rule reads the prices the recipes just stored.
    const gpuMedians = recipes
      ? await writeGpuMedianAlerts(db).catch(async (error: unknown) => {
          await recordOpsEvent(db, { kind: 'gpu_median_alerts_failed', detail: String(error) })
          return null
        })
      : null
    const theses = await evaluateTheses(db, { sourcesYaml, now: () => new Date() }).catch(
      async (error: unknown) => {
        await recordOpsEvent(db, { kind: 'theses_evaluate_failed', detail: String(error) })
        return null
      },
    )
    await warmAfterPoll(context)
    return { result, recipes, gpuMedians, theses }
  },
})

export default withHeartbeat(task)
