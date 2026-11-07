// GET /export/sample/<table>.<csv|json> — the first SAMPLE_ROWS rows of one
// export, the small file a data directory listing asks for.

import { serveExport } from '../../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event, { sample: true }))
