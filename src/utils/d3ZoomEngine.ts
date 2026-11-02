import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform } from "d3-zoom";
import type { D3ZoomEvent, ZoomTransform } from "d3-zoom";
import "d3-transition";

export type MapBounds = { x: number; y: number; width: number; height: number };
type MotionOptions = { animate?: boolean };
export type D3ZoomOptions = {
  bounds: MapBounds;
  minZoom?: number;
  maxZoom?: number;
  detailThreshold?: number;
  onSelectBooth?: (id: string) => void;
};

function validBounds(box: MapBounds) {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error("Invalid map bounds.");
}

export function focusTransform(viewBox: MapBounds, box: MapBounds, min: number, max: number) {
  validBounds(viewBox); validBounds(box);
  const k = Math.max(min, Math.min(max, Math.min(viewBox.width / box.width, viewBox.height / box.height)));
  return zoomIdentity.translate(viewBox.x + viewBox.width / 2 - (box.x + box.width / 2) * k, viewBox.y + viewBox.height / 2 - (box.y + box.height / 2) * k).scale(k);
}

/** D3 owns gesture state and transitions; React never updates the camera. */
export function createD3ZoomEngine(svg: SVGSVGElement, viewport: SVGGElement, options: D3ZoomOptions) {
  validBounds(options.bounds);
  const min = options.minZoom ?? 0.5, max = options.maxZoom ?? 8, threshold = options.detailThreshold ?? 1.8;
  if (![min, max, threshold].every(Number.isFinite) || min <= 0 || min > 1 || max < 1 || threshold < 0) throw new Error("Invalid zoom limits.");
  const browserWindow = svg.ownerDocument.defaultView;
  if (!browserWindow) throw new Error("A browser document is required.");
  const win = browserWindow;
  const previous = { viewBox: svg.getAttribute("viewBox"), transform: viewport.getAttribute("transform"), cssTransform: viewport.style.transform, detail: viewport.getAttribute("data-detail"), moving: svg.getAttribute("data-moving"), touch: svg.style.touchAction, tap: svg.style.getPropertyValue("-webkit-tap-highlight-color"), zooming: svg.classList.contains("is-zooming"), panning: svg.classList.contains("is-panning") };
  let destroyed = false, restoreTimer: number | null = null, previousScale = 1;
  const preference = win.matchMedia("(prefers-reduced-motion: reduce)");
  const selection = select<SVGSVGElement, unknown>(svg);
  const group = select(viewport);
  const pad = Math.min(options.bounds.width, options.bounds.height) * 0.04;
  // With the venue fitted by viewBox, D3's identity is the useful reset view.
  const viewBox = { x: options.bounds.x - pad, y: options.bounds.y - pad, width: options.bounds.width + pad * 2, height: options.bounds.height + pad * 2 };
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  svg.style.touchAction = "none";
  group.attr("transform", null);
  function clearRestore() { if (restoreTimer !== null) win.clearTimeout(restoreTimer); restoreTimer = null; }
  function restoreAnnotations() { svg.classList.remove("is-zooming", "is-panning"); svg.removeAttribute("data-moving"); }
  const behavior = zoom<SVGSVGElement, unknown>()
    .extent([[viewBox.x, viewBox.y], [viewBox.x + viewBox.width, viewBox.y + viewBox.height]])
    .scaleExtent([min, max])
    // Normalize a conventional notch (100 pixels, 3 lines, or 1 page) to 1.15x.
    // D3 interprets wheelDelta in log2 units; high-resolution deltas stay continuous.
    .wheelDelta((event: WheelEvent) => -event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 100 : 1) * Math.log2(1.15) / 100 * (event.ctrlKey ? 10 : 1))
    .touchable(() => true)
    .clickDistance(4)
    .on("start.floorplan", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      if (destroyed) return;
      clearRestore(); svg.setAttribute("data-moving", "true");
      const type = event.sourceEvent?.type ?? "transition";
      svg.classList.toggle("is-panning", type === "mousedown" || type === "touchstart");
      svg.classList.toggle("is-zooming", type !== "mousedown" && type !== "touchstart");
    })
    .on("zoom.floorplan", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      if (destroyed) return;
      const { x, y, k } = event.transform;
      group.style("transform", `translate3d(${x}px, ${y}px, 0px) scale(${k})`);
      group.attr("data-detail", threshold === 0 || event.transform.k > threshold ? "high" : "low");
      if (event.transform.k !== previousScale) { svg.classList.add("is-zooming"); svg.classList.remove("is-panning"); }
      previousScale = event.transform.k;
    })
    .on("end.floorplan", () => {
      if (destroyed) return;
      clearRestore(); restoreTimer = win.setTimeout(() => { restoreTimer = null; if (!destroyed) restoreAnnotations(); }, 150);
    });
  selection.call(behavior);
  selection.call(behavior.transform, zoomIdentity);
  clearRestore(); restoreAnnotations();

  function scaleBy(factor: number, motion: MotionOptions = {}) {
    if (destroyed) return;
    selection.interrupt();
    if (preference.matches || motion.animate === false) selection.call(behavior.scaleBy, factor);
    else selection.transition().duration(300).call(behavior.scaleBy, factor);
  }
  function transformTo(transform: ZoomTransform, duration: number, motion: MotionOptions = {}) {
    if (destroyed) return;
    selection.interrupt();
    if (preference.matches || motion.animate === false) selection.call(behavior.transform, transform);
    else selection.transition().duration(duration).call(behavior.transform, transform);
  }
  function resetView(motion: MotionOptions = {}) { transformTo(zoomIdentity, 500, motion); }
  function fitBounds(minX: number, minY: number, maxX: number, maxY: number, motion: MotionOptions = {}) {
    transformTo(focusTransform(viewBox, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, min, max), 300, motion);
  }
  selection.on("click.floorplan", (event: MouseEvent) => {
    if (destroyed || event.detail === 0 || event.defaultPrevented) return;
    const target = event.target as Element | null;
    const hit = target?.closest?.("[data-booth-id]");
    if (hit && svg.contains(hit)) options.onSelectBooth?.(hit.getAttribute("data-booth-id")!);
  });
  selection.on("keydown.floorplan", (event: KeyboardEvent) => {
    if (event.key === "+" || event.key === "=") { event.preventDefault(); scaleBy(1.25, { animate: false }); }
    else if (event.key === "-") { event.preventDefault(); scaleBy(0.8, { animate: false }); }
    else if (event.key === "Home" || event.key === "0") { event.preventDefault(); resetView({ animate: false }); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); selection.interrupt();
      const k = zoomTransform(svg).k;
      selection.call(behavior.translateBy, (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0) / k, (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) / k);
    }
  });
  function motionChanged() { if (preference.matches) selection.interrupt(); }
  preference.addEventListener("change", motionChanged);
  return {
    zoomIn: (motion?: MotionOptions) => scaleBy(1.25, motion),
    zoomOut: (motion?: MotionOptions) => scaleBy(0.8, motion),
    resetView, fitBounds,
    getTransform: () => zoomTransform(svg),
    getZoom: () => zoomTransform(svg).k,
    isHighDetail: () => threshold === 0 || zoomTransform(svg).k > threshold,
    destroy() {
      if (destroyed) return;
      destroyed = true; clearRestore(); selection.interrupt(); selection.on(".zoom", null).on(".floorplan", null);
      preference.removeEventListener("change", motionChanged);
      behavior.on(".floorplan", null);
      restoreAnnotations();
      const restore = (node: Element, key: string, value: string | null) => { if (value === null) node.removeAttribute(key); else node.setAttribute(key, value); };
      restore(svg, "viewBox", previous.viewBox); restore(svg, "data-moving", previous.moving); restore(viewport, "transform", previous.transform); restore(viewport, "data-detail", previous.detail);
      viewport.style.transform = previous.cssTransform;
      svg.style.touchAction = previous.touch; svg.style.setProperty("-webkit-tap-highlight-color", previous.tap);
      svg.classList.toggle("is-zooming", previous.zooming); svg.classList.toggle("is-panning", previous.panning);
      // Remove D3's element-local state so Strict Mode/remount starts at identity.
      selection.property("__zoom", null);
    },
  };
}

export type D3ZoomEngine = ReturnType<typeof createD3ZoomEngine>;
