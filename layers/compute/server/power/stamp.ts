// The power table's cache key: Epoch's runs and the stored ties and documents.

import { powerTiesStamp } from './store'

export async function powerSitesStamp(db: PipelineDb): Promise<string> {
  const [epoch, ties] = await Promise.all([
    recipeRunsStamp(db, DATACENTER_RECIPES.powerSites),
    powerTiesStamp(db),
  ])
  return `${epoch}:${ties}`
}
