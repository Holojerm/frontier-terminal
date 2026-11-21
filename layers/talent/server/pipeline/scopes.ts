import type { ScopeEntry } from '#layers/core/server/pipeline/scopes'

// Alphabet's whole careers feed, ~20 MB of XML, read for DeepMind's ~140 roles.
export const CAREERS_SOURCES: readonly string[] = ['google-careers']

/** The careers tick, alone in its own invocation (server/registries/scopes.ts). */
export const CAREERS_SCOPE: ScopeEntry = { sources: CAREERS_SOURCES }
