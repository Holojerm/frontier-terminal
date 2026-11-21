// Cron task: the filings lane, six-hourly at :47 (layers/terminal/server/pipeline/scopes.ts ›
// REGISTRATION_PREFIXES). Same wiring and the same reasons as poll/edgar.ts.
//
// Its own invocation because its own memory: each S-1 and amendment runs to
// ~14 MB, and with a third one in it the survey would carry ~124 MiB of the
// 128 MB that killed it on 2026-11-04 (payload-budget.test.ts).
//
// After the poll, the suppliers reader fetches the suppliers' new 10-Qs,
// 10-Ks, 8-Ks, 20-Fs and 6-Ks (layers/terminal/server/suppliers/ingest.ts),
// one document at a time, for the same reason. Then the power-sites reader
// searches EDGAR for new filings naming a quarter of Epoch's lab sites and
// fetches the newest few (layers/terminal/server/power/ingest.ts).

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'
import { recordOpsEvent } from '#server/utils/ops'
import { kv } from '@nuxthub/kv'

import sourcesYaml from 'raw:~~/sources.yaml'

import { createFetcher } from '#layers/core/server/pipeline/fetch'
import { unstorageLockStore } from '#layers/core/server/pipeline/lock'
import { blobRawStore, runPoll } from '../../pipeline/poll'
import { paceSec } from '../../pipeline/sec-pace'
import { KIND_READ_FAILED, runPowerSiteReads } from '../../power/ingest'
import { runSupplierReads } from '../../suppliers/ingest'
import { warmAfterPoll } from '#layers/core/server/utils/cache-warm-task'
import { withHeartbeat } from '#layers/core/server/utils/task-heartbeat'

const task = defineTask({
  meta: {
    name: 'poll:filings',
    description: 'Fetch the registration filings (S-1 indexes and prospectuses); diff and store',
  },
  async run({ context }) {
    const config = useRuntimeConfig()
    const fetcher = paceSec(
      createFetcher({
        secContactEmail: config.secContactEmail,
        appUrl: config.public.appUrl,
      }),
    )
    const raw = blobRawStore(blob)
    const result = await runPoll('filings', {
      db,
      raw,
      lock: unstorageLockStore(kv),
      fetcher,
      sourcesYaml,
    })
    const suppliers = await runSupplierReads(db, { raw, fetcher, now: new Date() }).catch(
      async (error: unknown) => {
        await recordOpsEvent(db, { kind: 'supplier_read_failed', detail: String(error) })
        return null
      },
    )
    const power = await runPowerSiteReads(db, { raw, fetcher, now: new Date() }).catch(
      async (error: unknown) => {
        await recordOpsEvent(db, { kind: KIND_READ_FAILED, detail: String(error) })
        return null
      },
    )
    await warmAfterPoll(context)
    return { result, suppliers, power }
  },
})

export default withHeartbeat(task)
