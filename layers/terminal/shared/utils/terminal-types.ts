// Response shapes for the terminal API (server/api/* -> app/pages/*).
//
// Every displayed datum descends from a type carrying Prov: provenance
// (source_url + fetched_at) is a field of the data, not a UI garnish. The
// shapes are plain JSON so a KV cache can hold them and a page can render
// them without a second conversion.

export * from '../../../core/shared/utils/terminal-types/common'
export * from '../../../core/shared/utils/terminal-types/coverage'
export * from './terminal-types/overview'
export * from '../../../pricing/shared/utils/terminal-types/prices'
export * from '../../../talent/shared/utils/terminal-types/hiring'
export * from '../../../reliability/shared/utils/terminal-types/incidents'
export * from '../../../reliability/shared/utils/terminal-types/probes'
export * from '../../../models/shared/utils/terminal-types/disclosures'
export * from '../../../adoption/shared/utils/terminal-types/rankings'
export * from '../../../companies/shared/utils/terminal-types/revenue'
export * from '../../../companies/shared/utils/terminal-types/guidance'
export * from '../../../press/shared/utils/terminal-types/reported'
export * from '../../../press/shared/utils/terminal-types/ground-truth'
export * from '../../../adoption/shared/utils/terminal-types/spend'
export * from '../../../models/shared/utils/terminal-types/releases'
export * from './terminal-types/alerts'
export * from '../../../compute/shared/utils/terminal-types/gpu-prices'
export * from '../../../press/shared/utils/terminal-types/track-record'
