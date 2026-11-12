// GET /export/sample/<table>.<csv|json> — SAMPLE_ROWS rows of one export (the
// newest of a table that grows over time, sampleOf), the small file a data
// directory listing asks for.

import { serveExport } from '../../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event, { sample: true }))
