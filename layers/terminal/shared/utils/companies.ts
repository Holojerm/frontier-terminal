// Every company a thesis can be about or compared with. The tracked labs are
// also the terminal's providers (terminal-sources.ts); the rest exist only
// for the thesis layer, so the lab panels never see them. A group is a
// basket a thesis can be about as one subject (the Compute thesis is about
// the frontier labs together), never a company in a comparison set.

export interface Company {
  name: string
  /** Exchange ticker, or null while private. */
  ticker: string | null
  kind: 'lab' | 'company' | 'group'
}

export const COMPANIES = {
  openai: { name: 'OpenAI', ticker: null, kind: 'lab' },
  anthropic: { name: 'Anthropic', ticker: null, kind: 'lab' },
  google: { name: 'Google', ticker: 'GOOGL', kind: 'lab' },
  xai: { name: 'xAI', ticker: null, kind: 'lab' },
  meta: { name: 'Meta', ticker: 'META', kind: 'lab' },
  mistral: { name: 'Mistral', ticker: null, kind: 'lab' },
  deepseek: { name: 'DeepSeek', ticker: null, kind: 'lab' },
  alibaba: { name: 'Alibaba', ticker: 'BABA', kind: 'lab' },
  moonshot: { name: 'Moonshot AI', ticker: null, kind: 'lab' },
  cloudflare: { name: 'Cloudflare', ticker: 'NET', kind: 'company' },
  akamai: { name: 'Akamai', ticker: 'AKAM', kind: 'company' },
  fastly: { name: 'Fastly', ticker: 'FSLY', kind: 'company' },
  'frontier-labs': { name: 'Frontier labs', ticker: null, kind: 'group' },
  // GPU rental providers: the Compute thesis's comparison set, one price recipe each.
  coreweave: { name: 'CoreWeave', ticker: 'CRWV', kind: 'company' },
  lambda: { name: 'Lambda', ticker: null, kind: 'company' },
  nebius: { name: 'Nebius', ticker: 'NBIS', kind: 'company' },
  crusoe: { name: 'Crusoe', ticker: null, kind: 'company' },
  together: { name: 'Together AI', ticker: null, kind: 'company' },
  digitalocean: { name: 'DigitalOcean', ticker: 'DOCN', kind: 'company' },
  verda: { name: 'Verda', ticker: null, kind: 'company' },
  microsoft: { name: 'Microsoft Azure', ticker: 'MSFT', kind: 'company' },
  oracle: { name: 'Oracle Cloud', ticker: 'ORCL', kind: 'company' },
} as const satisfies Record<string, Company>

export type CompanyId = keyof typeof COMPANIES

export const isCompanyId = (id: string): id is CompanyId => Object.hasOwn(COMPANIES, id)

/** Display name, falling back to the id for a provider this registry does not list. */
export const companyName = (id: string): string => (isCompanyId(id) ? COMPANIES[id].name : id)
