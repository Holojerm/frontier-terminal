// Which listed companies a lab's views carry: the ones /api/listed?lab= ties to it
// (listedTiedTo: the lab or its listed parent, a company a filing or cited page names
// beside the lab, or one whose power site the lab uses). /api/hiring/listed?lab= and
// /api/call-guidance?lab= narrow to these tickers, so a lab's listed table, its listed
// hiring and its call guidance always name the same companies.

import { powerSitesStamp } from '#layers/compute/server/power/stamp'
import { suppliersStamp } from '#layers/companies/server/suppliers/store'

/** What changes the listed table besides the poll tick, so every reader shares one KV entry. */
export async function listedVariant(): Promise<string> {
  const [power, suppliers] = await Promise.all([
    powerSitesStamp(terminalDb),
    suppliersStamp(terminalDb),
  ])
  return `${suppliers}:${power}`
}

/** The tickers tied to `lab`, read from the cached listed table, sorted. */
export async function listedTickersFor(lab: LabId): Promise<string[]> {
  const data = await terminalPayload(
    'listed',
    (ctx) => queryListed(terminalDb, ctx),
    await listedVariant(),
  )
  return listedForLab(data, lab)
    .companies.map((c) => c.ticker)
    .sort()
}
