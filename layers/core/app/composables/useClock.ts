// Client clock for relative timestamps. Stays null through SSR so the server
// renders the absolute form and hydration cannot mismatch; ticks once a
// minute afterwards so "3m ago" does not go stale on an open terminal.
//
// Shared, so every ProvenanceTag reads one ref behind one interval. Not named
// useNow: VueUse auto-imports one, and it would win over a layer's.
export const useClock = createSharedComposable(() => {
  const mounted = useMounted()
  const now = shallowRef(Date.now())
  useIntervalFn(() => {
    now.value = Date.now()
  }, 60_000)
  return computed<number | null>(() => (mounted.value ? now.value : null))
})
