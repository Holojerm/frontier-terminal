// The data dictionary core's export route serves at /export/dictionary.json and .csv: the app's
// composition root for it. The builder is core's (layers/core/server/utils/terminal-dictionary.ts);
// each layer writes its own tables' entries in its server/dictionary.ts and adds them here. The
// dictionary lists tables in EXPORT_TABLES order, so the order here changes nothing served.

import { parseCikWhitelistBlock } from '#layers/companies/server/pipeline/parsers/sec/whitelist'
import { CORE_DICTIONARY } from '#layers/core/server/dictionary'
import { PRICING_DICTIONARY } from '#layers/pricing/server/dictionary'
import { TALENT_DICTIONARY } from '#layers/talent/server/dictionary'
import { RELIABILITY_DICTIONARY } from '#layers/reliability/server/dictionary'
import { MODELS_DICTIONARY } from '#layers/models/server/dictionary'
import { COMPANIES_DICTIONARY } from '#layers/companies/server/dictionary'
import { THESES_DICTIONARY } from '#layers/theses/server/dictionary'
import { PRESS_DICTIONARY } from '#layers/press/server/dictionary'
import { ADOPTION_DICTIONARY } from '#layers/adoption/server/dictionary'
import { COMPUTE_DICTIONARY } from '#layers/compute/server/dictionary'
import { SIGNALS_DICTIONARY } from '#layers/signals/server/dictionary'

/** Every export table's entry, by table name. */
export const DICTIONARY_ENTRIES: Readonly<Record<string, DictionaryEntry>> = {
  ...CORE_DICTIONARY,
  ...PRICING_DICTIONARY,
  ...TALENT_DICTIONARY,
  ...RELIABILITY_DICTIONARY,
  ...MODELS_DICTIONARY,
  ...COMPANIES_DICTIONARY,
  ...THESES_DICTIONARY,
  ...PRESS_DICTIONARY,
  ...ADOPTION_DICTIONARY,
  ...COMPUTE_DICTIONARY,
  ...SIGNALS_DICTIONARY,
}

/** The dictionary /export/dictionary.<format> serves. */
export function dataDictionary(sourcesYaml: string): DataDictionary {
  return buildDataDictionary(sourcesYaml, {
    entries: DICTIONARY_ENTRIES,
    joining: JOINING_NOTE,
    cikWhitelist: parseCikWhitelistBlock,
  })
}
