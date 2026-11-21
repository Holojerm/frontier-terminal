// The data dictionary core's export route serves at /export/dictionary.json and .csv. It is the
// shell's (layers/terminal/server/utils/terminal-dictionary.ts): its table notes cover every
// domain's exports, so no layer below the shell can hold it.

export {
  DICTIONARY_NAME,
  dataDictionary,
  dictionaryCsv,
} from '#layers/terminal/server/utils/terminal-dictionary'
