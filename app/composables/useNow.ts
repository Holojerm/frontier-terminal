// Client clock for relative timestamps. Stays null through SSR so the server
// renders the absolute form and hydration cannot mismatch; ticks once a
// minute afterwards so "3m ago" does not go stale on an open terminal.
//
// One interval for the whole page: every ProvenanceTag reads the same ref
// instead of each running a timer of its own.

const now = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
let subscribers = 0

export function useNow() {
  onMounted(() => {
    subscribers += 1
    if (timer) return
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, 60_000)
  })
  onBeforeUnmount(() => {
    subscribers -= 1
    if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })
  return now
}
