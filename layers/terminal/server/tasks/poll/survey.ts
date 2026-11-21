// Cron task: poll every include source every six hours (layers/core/server/pipeline/scopes.ts).
// Same wiring and the same reasons as poll/edgar.ts.

import sourcesYaml from 'raw:~~/sources.yaml'

import { runPoll } from '#layers/core/server/pipeline/poll'
import { writeGpuMedianAlerts } from '#layers/compute/server/pipeline/gpu-median-floor'
import { paceSec } from '#layers/core/server/pipeline/sec-pace'
import { evaluateTheses } from '../../../../theses/server/theses/evaluate'
import { runRecipes } from '../../../../core/server/recipes/run'

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
