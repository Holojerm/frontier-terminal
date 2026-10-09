// Every company a thesis can be about or compared with. The four labs are
// also the terminal's providers (terminal-sources.ts); the rest exist only
// for the thesis layer, so the lab panels never see them.

export interface Company {
  name: string
  /** Exchange ticker, or null while private. */
  ticker: string | null
  kind: 'lab' | 'company'
}

export const COMPANIES = {
  openai: { name: 'OpenAI', ticker: null, kind: 'lab' },
  anthropic: { name: 'Anthropic', ticker: null, kind: 'lab' },
  google: { name: 'Google', ticker: 'GOOGL', kind: 'lab' },
  xai: { name: 'xAI', ticker: null, kind: 'lab' },
  cloudflare: { name: 'Cloudflare', ticker: 'NET', kind: 'company' },
  akamai: { name: 'Akamai', ticker: 'AKAM', kind: 'company' },
  fastly: { name: 'Fastly', ticker: 'FSLY', kind: 'company' },
} as const satisfies Record<string, Company>

export type CompanyId = keyof typeof COMPANIES

export const isCompanyId = (id: string): id is CompanyId => Object.hasOwn(COMPANIES, id)

/** Display name, falling back to the id for a provider this registry does not list. */
export const companyName = (id: string): string => (isCompanyId(id) ? COMPANIES[id].name : id)
