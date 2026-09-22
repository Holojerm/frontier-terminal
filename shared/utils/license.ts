// What may be reused here, and under what terms.
//
// Three different things get licensed on a site like this one, and collapsing
// them into a single "license" line is the easy way to say something false:
//
//   * The code is MIT. That is the repo's license and nothing else's.
//   * The compilation — which rows exist, keyed, timestamped, and joined — is
//     this site's own work, and it is published CC BY 4.0.
//   * The facts are not ours to license. A price on Anthropic's pricing page
//     belongs to Anthropic; a filing belongs to EDGAR. Every row carries the
//     URL it was read from precisely so a reader can go to the owner.
//
// CC BY 4.0 on the compilation is a constrained choice rather than a taste.
// One tracked source states a license of its own — the OpenRouter rankings
// feed is CC BY 4.0 and requires a specific attribution string, which the
// demand-share page prints verbatim from sources.yaml. Publishing the
// compilation under the same terms is what keeps that requirement satisfiable
// by someone downstream instead of stranded at our boundary.

export interface LicenseRef {
  /** SPDX identifier where one exists. */
  id: string
  /** Full name, for a schema.org `name`. */
  name: string
  /** What a sentence calls it. */
  short: string
  url: string
}

/** The compilation: the tables, the change log, the alerts, the exports. */
export const DATA_LICENSE: LicenseRef = {
  id: 'CC-BY-4.0',
  name: 'Creative Commons Attribution 4.0 International',
  short: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
}

/** The code that produces it. */
export const CODE_LICENSE: LicenseRef = {
  id: 'MIT',
  name: 'MIT License',
  short: 'MIT',
  url: 'https://opensource.org/license/mit',
}

/**
 * The attribution CC BY 4.0 asks of a reuser, with the site's own name filled
 * in. Rendered on /license and emitted in /llms.txt so the string a reuser
 * copies is the string we asked for, not one they composed.
 */
export function attributionLine(appName: string, appUrl: string): string {
  return `Source: ${appName} (${appUrl}). Licensed under ${DATA_LICENSE.short}.`
}
