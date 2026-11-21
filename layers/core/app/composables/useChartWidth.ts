/**
 * The width of a chart's box in CSS pixels, for an SVG drawn at 1:1. `refKey`
 * names the template ref on the box (`ref="box"`).
 *
 * The server cannot measure, so it draws at `initial` and the client redraws
 * at the measured width on mount. The SVG keeps a fixed pixel height and
 * `preserveAspectRatio="xMinYMid meet"`, so the server's drawing sits at its
 * natural size on the left until then: the height never jumps, only the
 * right edge fills in.
 */
export function useChartWidth(refKey: string, initial = 640, min = 280) {
  const box = useTemplateRef<HTMLElement>(refKey)
  const width = ref(initial)
  useResizeObserver(box, () => {
    const w = Math.round(box.value?.clientWidth ?? 0)
    if (w > 0) width.value = Math.max(min, w)
  })
  return width
}
