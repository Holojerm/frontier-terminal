// Cron task: rebuild the bulk feed's files in R2 (layers/core/server/utils/terminal-bulk.ts).
// Hourly at :41, off the survey (:00), careers (:17) and filings (:47) minutes.
// It builds only what isn't built today, so most hours it reads the index and
// stops; a failed file is spooled and retried next hour while yesterday's stays
// served. The licensed bucket comes on the task's env
// (layers/core/server/utils/owner-mail.ts says why); without it the `full`
// files stay in the blob store.

const task = defineTask({
  meta: {
    name: 'bulk:build',
    description:
      'Write each export table as a gzipped CSV and a Parquet file to R2 for the bulk feed, once a day',
  },
  async run({ context }) {
    const cloudflare = (context as { cloudflare?: { env?: unknown } } | undefined)?.cloudflare
    const report = await runBulkBuild({
      db,
      store: blob,
      licensed: licensedStoreOf(cloudflare?.env),
      appUrl: useRuntimeConfig().public.appUrl.replace(/\/+$/, ''),
    })
    for (const { file, error } of report.failed) {
      await recordOpsEvent(db, { kind: 'bulk_build_failed', detail: `${file}: ${error}` })
    }
    return { result: report }
  },
})

export default withHeartbeat(task)
