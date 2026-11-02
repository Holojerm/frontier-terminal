// GET /export/<table>.csv — snapshots, prices_latest, jobs_open, incidents,
// changes, alerts, source_runs. Streamed; provenance columns always present.

import { serveExport } from '../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event))
