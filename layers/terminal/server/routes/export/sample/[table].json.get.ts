// GET /export/sample/<table>.json — the CSV sample route's rows as a JSON array.

import { serveExport } from '../../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event, { sample: true }))
