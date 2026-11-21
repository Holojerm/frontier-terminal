// Reader settings: how times and figures read, how tightly tables sit, and
// which labs come first. Stored per browser in localStorage and never sent to
// the server.
//
// Page HTML is cached and shared by every reader, so the server always renders
// DEFAULTS read as UTC_STYLE. The stored settings load once hydration has
// finished (plugins/reader-prefs.client.ts), the same handoff useClock makes for
// relative ages, so a hydration mismatch cannot happen. Density is the
// exception: plugins/reader-prefs.ts sets it on <html> before first paint,
// because it moves layout rather than text.
//
// One module-level ref. The server never writes it, so requests cannot leak
// settings into each other.

import { DEFAULTS, PREFS_KEY, type ReaderPrefs } from '../../shared/utils/reader-prefs'

export { DEFAULTS, PREFS_KEY, type ReaderPrefs }

/** Only what differs from the defaults, so a later default change reaches readers who never chose. */
const serializer = {
  read: (raw: string): ReaderPrefs => {
    try {
      return parsePrefs(JSON.parse(raw))
    } catch {
      return DEFAULTS
    }
  },
  write: (p: ReaderPrefs) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(p).filter(
          ([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULTS[k as keyof ReaderPrefs]),
        ),
      ),
    ),
}

// Another tab's change arrives through the storage event useLocalStorage listens to.
const stored = import.meta.client
  ? useLocalStorage<ReaderPrefs>(PREFS_KEY, DEFAULTS, {
      serializer,
      writeDefaults: false,
      // Private mode or a full quota: the setting still applies to this tab.
      onError: () => {},
    })
  : shallowRef(DEFAULTS)
/** False through SSR and hydration: everything reads as the server rendered it. */
const loaded = ref(false)
const prefs = computed<ReaderPrefs>(() => (loaded.value ? stored.value : DEFAULTS))

function applyDensity(p: ReaderPrefs) {
  if (p.density === 'compact') document.documentElement.dataset.density = 'compact'
  else delete document.documentElement.dataset.density
}

/** Called once by the client plugin, after hydration. */
export function loadReaderPrefs() {
  loaded.value = true
  watch(prefs, applyDensity, { immediate: true })
}

export function useReaderPrefs() {
  const set = (patch: Partial<ReaderPrefs>) => {
    stored.value = parsePrefs({ ...prefs.value, ...patch })
  }
  return {
    prefs,
    loaded: readonly(loaded),
    set,
    reset: () => set(DEFAULTS),
  }
}

/** The browser's zone, or UTC where the runtime cannot say. */
export function browserZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return zone && isTimeZone(zone) ? zone : 'UTC'
}

function browserHour12(): boolean {
  const cycle = new Intl.DateTimeFormat(navigator.language, { hour: 'numeric' }).resolvedOptions()
    .hourCycle
  return cycle === 'h11' || cycle === 'h12'
}

/** The resolved reading: UTC_STYLE until the settings have loaded. */
export function useStampStyle() {
  return computed<StampStyle>(() => {
    if (!loaded.value) return UTC_STYLE
    const p = prefs.value
    return {
      zone: p.zone === 'local' ? browserZone() : p.zone,
      hour12: p.clock === 'auto' ? browserHour12() : p.clock === '12h',
      iso: p.dates === 'iso',
      relative: p.relative,
    }
  })
}

/**
 * Timestamp formatters bound to the reader's clock and settings. Call them in
 * a template or a computed and they re-render when either changes.
 */
export function useStamps() {
  const now = useClock()
  const style = useStampStyle()
  return {
    now,
    style,
    absolute: (iso: string) => absoluteStamp(iso, now.value, style.value),
    relative: (iso: string) => relativeStamp(iso, now.value, style.value),
    /** A UTC date printed alone (YYYY-MM-DD): the reader's date form, never shifted by zone. */
    day: (date: string) => dayStamp(date, now.value, style.value),
    /** A UTC date that always names its year: a filing period, a filing date, a planned date. */
    date: (date: string) => fullDayStamp(date, style.value),
    /** An instant that always names its year, for a page read on paper. */
    dated: (iso: string) => datedStamp(iso, style.value),
    zone: computed(() => zoneName(style.value)),
  }
}

/** '$7.81B' or '$7,810,000,000'; a chart axis keeps the compact form either way. */
export function useFigures() {
  const full = computed(() => loaded.value && prefs.value.numbers === 'full')
  return {
    usd: (n: number) =>
      full.value ? `${n < 0 ? '−' : ''}$${count(Math.round(Math.abs(n)))}` : compactUsd(n),
    tokens: (n: number) => (full.value ? count(Math.round(n)) : compactTokens(n)),
  }
}

/**
 * The reader's starred labs. `first` moves their rows to the top, keeping the
 * order inside each group; use it only where the order is a registry order,
 * never a ranking or a timeline.
 */
export function useWatchlist() {
  const { set } = useReaderPrefs()
  const ids = computed<readonly LabId[]>(() => (loaded.value ? prefs.value.watchlist : []))
  const has = (id: string) => isLab(id) && ids.value.includes(id)
  return {
    ids,
    has,
    toggle: (id: LabId) =>
      set({
        watchlist: has(id) ? ids.value.filter((x) => x !== id) : [...ids.value, id],
      }),
    first: <T>(rows: readonly T[], lab: (row: T) => string): T[] => labsFirst(rows, lab, ids.value),
  }
}
