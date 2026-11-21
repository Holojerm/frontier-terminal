// The XBRL concepts the earnings-call reader (layers/companies/server/calls/ingest.ts ›
// readConcepts) reads each run beyond what its own open statements need: the
// app's composition root for them, so the reader never imports the layers that
// ask. Each entry names the filer's CIK.

import type { ConceptNeeds } from '#layers/companies/server/calls/ingest'
import { forwardConceptNeeds, forwardFiler } from '#layers/signals/server/signals/forward-filers'

/** The concepts forward calls settle against (layers/signals/server/signals/forward-filers.ts). */
const forwardCallConcepts: ConceptNeeds = async (db, today) =>
  (await forwardConceptNeeds(db, today)).flatMap((w) => {
    const cik = forwardFiler(w.ticker)?.cik
    return cik ? [{ ...w, cik }] : []
  })

export const CALL_CONCEPT_NEEDS: readonly ConceptNeeds[] = [forwardCallConcepts]
