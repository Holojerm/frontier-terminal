// The power table's cache key: Epoch's runs and the stored ties and documents.

import type { PipelineDb } from '../pipeline/store'
import { recipeRunsStamp } from '../utils/terminal-db'
import { VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { powerTiesStamp } from './store'

export async function powerSitesStamp(db: PipelineDb): Promise<string> {
  const [epoch, ties] = await Promise.all([
    recipeRunsStamp(db, VIEW_RECIPES.powerSites),
    powerTiesStamp(db),
  ])
  return `${epoch}:${ties}`
}
