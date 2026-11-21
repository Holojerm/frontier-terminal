/**
 * The width of a chart's box in CSS pixels, for an SVG drawn at 1:1. `refKey`
 * names the template ref on the box. The server draws at `initial` and the
 * client redraws at the measured width on mount; with a fixed height and
 * `preserveAspectRatio="xMinYMid meet"` only the right edge fills in.
 */
export function useChartWidth(refKey: string, initial = 640, min = 280) {
  const box = useTemplateRef<HTMLElement>(refKey)
  const width = ref(initial)
  let observer: ResizeObserver | undefined

  onMounted(() => {
    const el = box.value
    if (!el) return
    const measure = () => {
      const w = Math.round(el.clientWidth)
      if (w > 0) width.value = Math.max(min, w)
    }
    observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
  })
  onBeforeUnmount(() => observer?.disconnect())

  return width
}
