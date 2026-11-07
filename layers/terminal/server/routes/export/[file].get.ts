// GET /export/<table>.<csv|json> — one export table, streamed, provenance
// columns always present; /export/dictionary.<csv|json> too. serveExport reads
// the table and the format off the path (parseExportPath).

import { serveExport } from '../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event))
