// Cron task: poll every include source every six hours (server/pipeline/scopes.ts).
// Same wiring and the same reasons as poll/edgar.ts.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:../../../sources.yaml'

import { createFetcher } from '../../pipeline/fetch'
import { unstorageLockStore } from '../../pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { evaluateTheses } from '../../theses/evaluate'
import { runRecipes } from '../../theses/recipes/run'
import { recordOpsEvent } from '../../utils/ops'

export default defineTask({
  meta: {
    name: 'poll:survey',
    description:
      'Fetch every include source (pricing, hiring, EDGAR, rankings); diff and store; evaluate the theses',
  },
  async run() {
    const config = useRuntimeConfig()
    const result = await runPoll('survey', {
      db,
      raw: blobRawStore(blob),
      lock: unstorageLockStore(kv),
      fetcher: createFetcher({
        secContactEmail: config.secContactEmail,
        openrouterApiKey: config.openrouterApiKey,
        appUrl: config.public.appUrl,
      }),
      sourcesYaml,
    })
    // The theses read what this tick stored, so they run after it: recipes
    // first (their own fetches), then the evaluation. A failure here must not
    // undo or hide the poll, so it is spooled for the digest.
    const recipes = await runRecipes(db, {
      raw: blobRawStore(blob),
      fetcher: createFetcher({
        secContactEmail: config.secContactEmail,
        openrouterApiKey: config.openrouterApiKey,
        appUrl: config.public.appUrl,
      }),
      now: () => new Date(),
    }).catch(async (error: unknown) => {
      await recordOpsEvent(db, { kind: 'recipes_run_failed', detail: String(error) })
      return null
    })
    const theses = await evaluateTheses(db, { sourcesYaml, now: () => new Date() }).catch(
      async (error: unknown) => {
        await recordOpsEvent(db, { kind: 'theses_evaluate_failed', detail: String(error) })
        return null
      },
    )
    return { result, recipes, theses }
  },
})
