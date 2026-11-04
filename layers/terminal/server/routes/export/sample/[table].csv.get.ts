// GET /export/sample/<table>.csv — the first SAMPLE_ROWS rows of one export,
// the small file a data directory listing asks for. Either sample route
// serves either format (parseExportPath).

import { serveExport } from '../../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event, { sample: true }))
