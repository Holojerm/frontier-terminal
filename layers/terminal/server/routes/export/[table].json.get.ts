// GET /export/<table>.json — the same tables as the CSV route, as a JSON array.

import { serveExport } from '../../utils/terminal-export-route'

export default defineEventHandler((event) => serveExport(event))
