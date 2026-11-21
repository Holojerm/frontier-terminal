// One lab's slice of an all-lab payload, for the routes that take `?lab=`
// (layers/core/server/utils/lab-query.ts). The disclosures cut is the models layer's
// (terminal-disclosures.ts › disclosuresForLab).
// Each cut runs on the cached all-lab payload, so every lab page reads the one
// KV entry the axis page fills. A payload that trims its lists before caching
// can't be cut here, because the trim would hide the lab's older rows; ground
// truth filters inside its query instead (queryGroundTruth's `lab`).

/** Tied to the lab by being it or its parent, by a filing that names it, or by a site it uses. */
export const listedTiedTo = (c: ListedCompany, lab: LabId): boolean =>
  c.lab === lab || c.labs.includes(lab) || c.site_labs.includes(lab)

export const listedForLab = (data: ListedData, lab: LabId): ListedData =>
  listedSubset(
    data,
    data.companies.filter((c) => listedTiedTo(c, lab)),
  )
