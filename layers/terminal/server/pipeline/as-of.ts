/** The `as_of` a rankings lane wrote into its run detail, if the detail carries one. */
export function asOfFromDetail(detail: string | null): string | null {
  return detail?.match(/as_of (\S+)/)?.[1] ?? null
}
