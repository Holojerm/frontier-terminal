// The theses: arguments built on the terminal's data, each claim checked against its kill condition.

import { z } from 'zod'
import { THESES } from '../theses/registry'
import { queryTheses } from '../utils/terminal-theses'
import { json, READ_ONLY, PROVENANCE, type McpKit } from './kit'

const ThesisSchema = z
  .enum(THESES.map((t) => t.id) as [string, ...string[]])
  .describe(`A thesis id: ${THESES.map((t) => t.id).join(', ')}.`)

export function registerThesisTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_theses',
    {
      title: 'Theses and the status of each claim',
      description:
        'Every open thesis: an argument about one company (stance bullish or bearish, statement, horizon, position, the comparison set, the day it was opened) broken into claims. ' +
        'Each claim names the signal it is checked against and a kill_condition written before the data arrived. status is holding, weakening, broken or unresolved, computed from our stored readings ' +
        'against that kill condition, with reason saying why and status_since when it entered that status. signal_kind measured claims carry latest (the newest reading, its detail and provenance) and series ' +
        '(oldest first, the history the rule reads). signal_kind judged claims carry verdicts, the judge’s rating of each candidate event with its rationale and the facts the Worker computed; a judged claim stays ' +
        'unresolved until the judge rates one. A claim on filed revenue also carries early_read, the press’s figures for periods not filed yet, which feed nothing above it. ' +
        'This is a research journal, not investment advice, and a status is not a forecast. Optional thesis keeps one thesis. ' +
        PROVENANCE,
      inputSchema: z.object({ thesis: ThesisSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ thesis }) => {
      const data = await deps.serve('theses', (ctx) => queryTheses(deps.db, ctx))
      if (!thesis) return json(data)
      return json({ ...data, theses: data.theses.filter((t) => t.id === thesis) })
    },
  )
}
