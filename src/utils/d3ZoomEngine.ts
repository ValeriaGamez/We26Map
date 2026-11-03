import { pointer, select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform } from "d3-zoom";
import type { D3ZoomEvent, ZoomTransform } from "d3-zoom";
import "d3-transition";

export type MapBounds = { x: number; y: number; width: number; height: number };
type MotionOptions = { animate?: boolean };
// 8x keeps the transformed coordinate space bounded; finer label tiers reveal
// well below the ceiling so every booth name is reachable before max zoom.
export const ZOOM_MIN = 0.5, ZOOM_MAX = 8;
/** Time constant of the camera ease. At 60 fps this matches the former fixed
 * 0.18 per-frame factor; on slow frames it catches up instead of lagging. */
export const EASE_TAU_MS = 80;

/** The SVG layers share this viewBox: scene bounds plus a 4% margin. */
export function fittedViewBox(bounds: MapBounds): MapBounds {
  const pad = Math.min(bounds.width, bounds.height) * 0.04;
  return { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 };
}

/** How the viewBox is letterboxed into a stage at identity (CSS pixels). */
export type Frame = { width: number; height: number; pixelsPerUnit: number; offsetX: number; offsetY: number };
export function frameFor(viewBox: MapBounds, width: number, height: number): Frame {
  const pixelsPerUnit = width > 0 && height > 0 ? Math.min(width / viewBox.width, height / viewBox.height) : 0;
  return { width, height, pixelsPerUnit, offsetX: (width - viewBox.width * pixelsPerUnit) / 2, offsetY: (height - viewBox.height * pixelsPerUnit) / 2 };
}

/** Invert a CSS-pixel camera back to map units. Padding is in CSS pixels. */
export function visibleMapBounds(viewBox: MapBounds, width: number, height: number, camera: { x: number; y: number; k: number }, padding = 100): MapBounds | null {
  if (width <= 0 || height <= 0) return null;
  const frame = frameFor(viewBox, width, height);
  const toMapX = (px: number) => viewBox.x + ((px - camera.x) / camera.k - frame.offsetX) / frame.pixelsPerUnit;
  const toMapY = (px: number) => viewBox.y + ((px - camera.y) / camera.k - frame.offsetY) / frame.pixelsPerUnit;
  const x = toMapX(-padding), y = toMapY(-padding);
  return { x, y, width: toMapX(width + padding) - x, height: toMapY(height + padding) - y };
}

export function intersectsBounds(a: MapBounds, b: MapBounds) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}
export function labelLevel(scale: number) {
  return scale >= 5 ? 4 : scale >= 3.5 ? 3 : scale >= 2.5 ? 2 : scale >= 1.8 ? 1 : 0;
}
/** Conservative square around a structural <text>; rotation never escapes it. */
export function textCullBounds(x: number, y: number, size: number, characters: number): MapBounds {
  const extent = Math.max(size, characters * size * 0.6) / 2 + size;
  return { x: x - extent, y: y - extent, width: extent * 2, height: extent * 2 };
}
/** Buffered label view, reported during gestures when eligible IDs/tiers change. */
export type SettledView = { scale: number; level: number; visibleIds: string[] };
export type D3ZoomOptions = {
  bounds: MapBounds;
  minZoom?: number;
  maxZoom?: number;
  detailThreshold?: number;
  /** Letterboxed frame inside the camera; the engine sizes it to the viewBox aspect. */
  fit?: HTMLElement;
  /** Layer holding `rect[data-booth-id]`; receives LOD attributes. Defaults to the camera. */
  booths?: Element;
  /** Static venue layer; its <text> nodes are frustum-culled. */
  backdrop?: Element;
  labels?: Element;
  onSelectBooth?: (id: string) => void;
  onDirectionsBooth?: (id: string) => void;
  canClearRoute?: (point: [number, number], pixelsPerUnit: number) => boolean;
  onClearRoute?: () => void;
  onDeselectBooth?: () => void;
  onViewSettle?: (view: SettledView) => void;
  onMapPoint?: (point: [number, number], pixelsPerUnit: number) => void;
  controls?: { zoomIn: HTMLButtonElement; zoomOut: HTMLButtonElement; indicator?: HTMLOutputElement };
};

function validBounds(box: MapBounds) {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error("Invalid map bounds.");
}

/** Transform that centers `box` inside `frame`, both in the same (pixel) units. */
export function focusTransform(frame: MapBounds, box: MapBounds, min: number, max: number) {
  validBounds(frame); validBounds(box);
  const k = Math.max(min, Math.min(max, Math.min(frame.width / box.width, frame.height / box.height)));
  return zoomIdentity.translate(frame.x + frame.width / 2 - (box.x + box.width / 2) * k, frame.y + frame.height / 2 - (box.y + box.height / 2) * k).scale(k);
}

/** D3 owns gesture state and transitions; React never updates the camera.
 *
 * `stage` is the HTML gesture surface (CSS-pixel extent). `camera` is the one
 * HTML element that pans (`translate3d` only). Zoom is applied by sizing the
 * letterboxed `fit` frame, so SVG layers re-rasterize at the current scale
 * instead of stretching a compositor bitmap (which reads as blur). */
export function createD3ZoomEngine(stage: HTMLElement, camera: HTMLElement, options: D3ZoomOptions) {
  validBounds(options.bounds);
  const min = Math.max(ZOOM_MIN, options.minZoom ?? ZOOM_MIN), max = Math.min(ZOOM_MAX, options.maxZoom ?? ZOOM_MAX), threshold = options.detailThreshold ?? 1.8;
  if (![min, max, threshold].every(Number.isFinite) || min <= 0 || min > 1 || max < 1 || threshold < 0) throw new Error("Invalid zoom limits.");
  const browserWindow = stage.ownerDocument.defaultView;
  if (!browserWindow) throw new Error("A browser document is required.");
  const win = browserWindow;
  const booths = options.booths ?? camera, backdrop = options.backdrop, labels = options.labels, fit = options.fit, controls = options.controls;
  const previous = {
    cameraTransform: camera.style.transform, touch: stage.style.touchAction, tap: stage.style.getPropertyValue("-webkit-tap-highlight-color"), strokeScale: stage.style.getPropertyValue("--sw"),
    markerScale: stage.style.getPropertyValue("--map-unit-per-pixel"),
    moving: stage.getAttribute("data-moving"), detail: booths.getAttribute("data-detail"), boothLevel: booths.getAttribute("data-label-level"), labelLevel: labels?.getAttribute("data-label-level") ?? null,
    stage: ["is-zooming", "is-panning", "is-interacting", "is-low-detail"].filter((name) => stage.classList.contains(name)),
    boothsLow: booths.classList.contains("is-low-detail"), labelsLow: labels?.classList.contains("is-low-detail") ?? false,
    fit: fit ? { left: fit.style.left, top: fit.style.top, width: fit.style.width, height: fit.style.height } : null,
    controls: controls ? { inDisabled: controls.zoomIn.disabled, outDisabled: controls.zoomOut.disabled, text: controls.indicator?.textContent ?? null } : null,
  };
  let destroyed = false, restoreTimer: number | null = null, previousScale = 1;
  let wheelTarget: ZoomTransform | null = null, wheelFrame: number | null = null;
  let currentView = zoomIdentity, snapNextFrame = false;
  let renderTarget: ZoomTransform | null = null, rendering = false;
  let targetLowDetail = threshold > 0 && 1 < threshold;
  let interaction: "zoom" | "pan" | null = null;
  let pointSelection = false;
  let placementClick = false;
  let lastClickBooth: string | null = null;
  let clearRouteClick = false;
  const preference = win.matchMedia("(prefers-reduced-motion: reduce)");
  const selection = select<HTMLElement, unknown>(stage);
  // Cache geometry once. No per-frame getBBox/getBoundingClientRect calls.
  const cullNodes = Array.from(booths.querySelectorAll<SVGRectElement>("rect[data-booth-id]"), node => ({
    id: node.getAttribute("data-booth-id")!, node, bounds: { x: Number(node.getAttribute("x") ?? 0), y: Number(node.getAttribute("y") ?? 0), width: Number(node.getAttribute("width")), height: Number(node.getAttribute("height")) }, hidden: null as boolean | null, oldDisplay: node.style.display,
  }));
  const boothBounds = new Map(cullNodes.map(item => [item.id, item.bounds]));
  // Structural annotations are plain positioned text; a square around each is
  // enough to keep off-screen ones out of the paint pipeline.
  const structureNodes = Array.from(backdrop?.querySelectorAll<SVGTextElement>("text") ?? [], node => ({
    node, bounds: textCullBounds(Number(node.getAttribute("x") ?? 0), Number(node.getAttribute("y") ?? 0), Number(node.getAttribute("font-size")) || 1, node.textContent?.length ?? 0), hidden: null as boolean | null, oldDisplay: node.style.display,
  }));
  // Label groups are mounted and unmounted by React from the buffered view, so
  // they are resolved per frame instead of cached.
  const labelNodeBounds = new WeakMap<Element, MapBounds | null>();
  let settledSignature: string | null = null;
  let settlePending = true, lastFrameTime: number | null = null;
  let paintedLabelLevel = -1;
  let paintedDetail: string | null = null;
  let paintedInteraction: "zoom" | "pan" | null | undefined;
  let paintedStrokeScale: string | null = null;
  let paintedMarkerScale: string | null = null;
  const viewBox = fittedViewBox(options.bounds);
  let frame = frameFor(viewBox, 0, 0);
  stage.style.touchAction = "none";
  camera.style.transformOrigin = "0 0";
  function clearRestore() { if (restoreTimer !== null) win.clearTimeout(restoreTimer); restoreTimer = null; }
  function queueFrame() {
    if (!destroyed && !rendering && wheelFrame === null) wheelFrame = win.requestAnimationFrame(wheelTick);
  }
  /** Map units to identity stage pixels. */
  const projectX = (x: number) => frame.offsetX + (x - viewBox.x) * frame.pixelsPerUnit;
  const projectY = (y: number) => frame.offsetY + (y - viewBox.y) * frame.pixelsPerUnit;
  function measureViewport() {
    if (destroyed) return;
    const box = stage.getBoundingClientRect();
    frame = frameFor(viewBox, box.width, box.height);
    settlePending = true;
    queueFrame();
  }
  const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(measureViewport) : null;
  observer?.observe(stage);
  win.addEventListener("resize", measureViewport);
  measureViewport();
  function restoreAnnotations() {
    if (interaction && (renderTarget || wheelTarget)) {
      restoreTimer = win.setTimeout(() => { restoreTimer = null; restoreAnnotations(); }, 150);
      return;
    }
    interaction = null; queueFrame();
  }
  function clearWheel() {
    wheelTarget = null;
  }
  const wheelDelta = (event: WheelEvent) => -event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 100 : 1) * Math.log2(1.15) / 100 * (event.ctrlKey ? 10 : 1);
  const behavior = zoom<HTMLElement, unknown>()
    .extent(() => [[0, 0], [frame.width, frame.height]])
    .scaleExtent([min, max])
    // Normalize a conventional notch (100 pixels, 3 lines, or 1 page) to 1.15x.
    // D3 interprets wheelDelta in log2 units; high-resolution deltas stay continuous.
    .wheelDelta(wheelDelta)
    .filter((event: MouseEvent) => {
      const hit = (event.target as Element | null)?.closest?.("[data-booth-id]");
      if (event.type === "dblclick" && (pointSelection || placementClick || shouldClearRoute(event) || (options.onDirectionsBooth && (lastClickBooth || (hit && stage.contains(hit)))))) return false;
      if (event.type !== "wheel") clearWheel();
      return (!event.ctrlKey || event.type === "wheel") && !event.button;
    })
    .touchable(() => true)
    .clickDistance(4)
    .on("start.floorplan", (event: D3ZoomEvent<HTMLElement, unknown>) => {
      if (destroyed) return;
      clearRestore();
      const type = event.sourceEvent?.type ?? "transition";
      interaction = type === "mousedown" || type === "touchstart" ? "pan" : "zoom";
      queueFrame();
    })
    .on("zoom.floorplan", (event: D3ZoomEvent<HTMLElement, unknown>) => {
      if (destroyed) return;
      renderTarget = event.transform;
      settlePending = true;
      targetLowDetail = threshold > 0 && event.transform.k < threshold;
      if (event.transform.k !== previousScale) interaction = "zoom";
      previousScale = event.transform.k;
      queueFrame();
    })
    .on("end.floorplan", () => {
      if (destroyed) return;
      clearRestore(); restoreTimer = win.setTimeout(() => { restoreTimer = null; if (!destroyed) restoreAnnotations(); }, 150);
    });
  selection.call(behavior);
  selection.call(behavior.transform, zoomIdentity);
  // The initial label view reports in the first frame.
  clearRestore(); interaction = null; settlePending = true; queueFrame();
  function paintStrokeScale(k: number) {
    // Strokes are authored in map units; this keeps them visually constant as
    // the fit frame grows with zoom. Written per frame so borders never thicken
    // mid-gesture; the toFixed dedupe skips frames with no change.
    const value = (1 / k).toFixed(4);
    if (value !== paintedStrokeScale) { stage.style.setProperty("--sw", value); paintedStrokeScale = value; }
  }
  function paintMarkerScale(k: number) {
    if (frame.pixelsPerUnit <= 0) return;
    // Real circle radii/borders compensate for the displayed SVG scale, including
    // viewport resizing. One inherited variable updates all markers in this RAF.
    const value = (1 / (frame.pixelsPerUnit * k)).toFixed(8);
    if (value !== paintedMarkerScale) { stage.style.setProperty("--map-unit-per-pixel", value); paintedMarkerScale = value; }
  }
  function paintFit(k: number) {
    if (!fit || frame.pixelsPerUnit <= 0) return;
    // Identity size × k, with the letterbox offsets scaled the same way a CSS
    // `scale(k)` from the origin would have moved them — without the bitmap stretch.
    const style = {
      left: `${frame.offsetX * k}px`,
      top: `${frame.offsetY * k}px`,
      width: `${viewBox.width * frame.pixelsPerUnit * k}px`,
      height: `${viewBox.height * frame.pixelsPerUnit * k}px`,
    };
    for (const key of ["left", "top", "width", "height"] as const) if (fit.style[key] !== style[key]) fit.style[key] = style[key];
  }
  function paintCamera() {
    const { x, y, k } = currentView;
    const transform = `translate3d(${x}px, ${y}px, 0px)`;
    if (camera.style.transform !== transform) camera.style.transform = transform;
    paintFit(k);
    paintStrokeScale(k);
    paintMarkerScale(k);
    const level = labelLevel(k);
    if (level !== paintedLabelLevel) {
      booths.setAttribute("data-label-level", String(level));
      labels?.setAttribute("data-label-level", String(level));
      paintedLabelLevel = level;
    }
    const detail = !targetLowDetail && (threshold === 0 || k >= threshold) ? "high" : "low";
    if (detail !== paintedDetail) {
      stage.classList.toggle("is-low-detail", detail === "low");
      booths.classList.toggle("is-low-detail", detail === "low");
      labels?.classList.toggle("is-low-detail", detail === "low");
      booths.setAttribute("data-detail", detail);
      paintedDetail = detail;
    }
  }
  // Wheel handlers buffer only. One display-synced loop interpolates the D3
  // camera, then pans the camera element and sizes the fit frame.
  function wheelTick(time: number) {
    wheelFrame = null;
    if (destroyed) return;
    rendering = true;
    // Frame-rate independent ease: a 60 fps frame yields the former 0.18
    // factor; a 60 ms frame yields ~0.53 so slow devices do not trail further.
    const dt = lastFrameTime === null || !Number.isFinite(time) ? 1000 / 60 : Math.min(100, Math.max(1, time - lastFrameTime));
    lastFrameTime = Number.isFinite(time) ? time : null;
    if (wheelTarget) {
      selection.interrupt();
      const target = wheelTarget;
      wheelTarget = null;
      selection.call(behavior.transform, target);
    }
    if (renderTarget) {
      settlePending = true;
      const target = renderTarget;
      const alpha = preference.matches || snapNextFrame ? 1 : 1 - Math.exp(-dt / EASE_TAU_MS);
      const next = zoomIdentity.translate(
        currentView.x + (target.x - currentView.x) * alpha,
        currentView.y + (target.y - currentView.y) * alpha,
      ).scale(currentView.k + (target.k - currentView.k) * alpha);
      // Snap within half a CSS pixel: invisible, and it ends the exponential tail.
      const done = Math.abs(next.x - target.x) < 0.5 && Math.abs(next.y - target.y) < 0.5 && Math.abs(next.k - target.k) < 0.001;
      currentView = done ? target : next;
      if (done) renderTarget = null;
      snapNextFrame = false;
    }
    paintCamera();
    if (interaction !== paintedInteraction) {
      stage.classList.toggle("is-interacting", interaction !== null);
      stage.classList.toggle("is-zooming", interaction === "zoom");
      stage.classList.toggle("is-panning", interaction === "pan");
      if (interaction) stage.setAttribute("data-moving", "true"); else stage.removeAttribute("data-moving");
      paintedInteraction = interaction;
    }
    const visible = visibleMapBounds(viewBox, frame.width, frame.height, currentView);
    if (visible) {
      for (const item of cullNodes) {
        const hidden = !intersectsBounds(item.bounds, visible) && stage.ownerDocument.activeElement !== item.node;
        if (hidden !== item.hidden) {
          // React owns className for selection/search. Keep culling in an
          // independent style property so those renders cannot undo it.
          item.node.style.display = hidden ? "none" : item.oldDisplay;
          item.hidden = hidden;
        }
      }
      for (const item of structureNodes) {
        const hidden = !intersectsBounds(item.bounds, visible);
        if (hidden !== item.hidden) { item.node.style.display = hidden ? "none" : item.oldDisplay; item.hidden = hidden; }
      }
      if (labels) for (let i = 0; i < labels.children.length; i++) {
        const node = labels.children[i] as SVGGElement;
        let bounds = labelNodeBounds.get(node);
        if (bounds === undefined) { bounds = boothBounds.get(node.getAttribute("data-booth-label-id") ?? "") ?? null; labelNodeBounds.set(node, bounds); }
        if (!bounds) continue;
        const display = intersectsBounds(bounds, visible) ? "" : "none";
        if (node.style.display !== display) node.style.display = display;
      }
    }
    // Prefetch labels for the target, retaining those still visible in the eased
    // camera. This avoids both delayed reveals and disappearing labels mid-pan.
    // Signature deduplication keeps unchanged frames out of React.
    if (settlePending && !wheelTarget) {
      settlePending = false;
      const target = zoomTransform(stage);
      const targetVisible = visibleMapBounds(viewBox, frame.width, frame.height, target);
      if (targetVisible && options.onViewSettle) {
        const scale = Math.max(currentView.k, target.k), level = labelLevel(scale), visibleIds: string[] = [];
        for (const item of cullNodes) if (intersectsBounds(item.bounds, targetVisible) || (visible && intersectsBounds(item.bounds, visible))) visibleIds.push(item.id);
        const signature = `${level}|${visibleIds.join(",")}`;
        if (signature !== settledSignature) { settledSignature = signature; options.onViewSettle({ scale, level, visibleIds }); }
      }
    }
    if (controls) {
      const text = `${Math.min(max, Math.max(min, currentView.k)).toFixed(1)}×`;
      if (controls.indicator && controls.indicator.textContent !== text) controls.indicator.textContent = text;
      const targetScale = zoomTransform(stage).k;
      const atMax = targetScale >= max - 0.000001, atMin = targetScale <= min + 0.000001;
      if (controls.zoomIn.disabled !== atMax) controls.zoomIn.disabled = atMax;
      if (controls.zoomOut.disabled !== atMin) controls.zoomOut.disabled = atMin;
    }
    rendering = false;
    if (wheelTarget || renderTarget) queueFrame();
  }
  selection.on("wheel.zoom", null).on("wheel.floorplan", (event: WheelEvent) => {
    if (destroyed) return;
    // Map gestures consume wheel/trackpad input. Passive listeners cannot cancel
    // page scroll or browser pinch zoom; keep this handler short and buffer only.
    event.preventDefault();
    const anchor = pointer(event, stage), current = zoomTransform(stage);
    const k = Math.max(min, Math.min(max, (wheelTarget?.k ?? current.k) * 2 ** wheelDelta(event)));
    const world = currentView.invert(anchor);
    const destination = zoomIdentity.translate(anchor[0] - world[0] * k, anchor[1] - world[1] * k).scale(k);
    wheelTarget = destination;
    queueFrame();
  }, { passive: false });

  function scaleBy(factor: number, motion: MotionOptions = {}) {
    if (destroyed) return;
    clearWheel();
    selection.interrupt();
    snapNextFrame = preference.matches || motion.animate === false;
    if (preference.matches || motion.animate === false) selection.call(behavior.scaleBy, factor);
    else selection.transition().duration(300).call(behavior.scaleBy, factor);
  }
  function transformTo(transform: ZoomTransform, duration: number, motion: MotionOptions = {}) {
    if (destroyed) return;
    clearWheel();
    selection.interrupt();
    snapNextFrame = preference.matches || motion.animate === false;
    if (preference.matches || motion.animate === false) selection.call(behavior.transform, transform);
    else selection.transition().duration(duration).call(behavior.transform, transform);
  }
  function resetView(motion: MotionOptions = {}) { transformTo(zoomIdentity, 500, motion); }
  function fitBounds(minX: number, minY: number, maxX: number, maxY: number, motion: MotionOptions = {}) {
    if (frame.pixelsPerUnit <= 0) return;
    const box = { x: projectX(minX), y: projectY(minY), width: (maxX - minX) * frame.pixelsPerUnit, height: (maxY - minY) * frame.pixelsPerUnit };
    transformTo(focusTransform({ x: 0, y: 0, width: frame.width, height: frame.height }, box, min, max), 300, motion);
  }
  function screenToMap(x: number, y: number): [number, number] {
    const world = currentView.invert([x, y]);
    return [viewBox.x + (world[0] - frame.offsetX) / frame.pixelsPerUnit, viewBox.y + (world[1] - frame.offsetY) / frame.pixelsPerUnit];
  }
  function canClearRouteAt(event: MouseEvent) {
    const [x, y] = pointer(event, stage);
    return Boolean(options.onClearRoute && options.canClearRoute?.(screenToMap(x, y), frame.pixelsPerUnit * currentView.k));
  }
  function shouldClearRoute(event: MouseEvent) {
    const hit = (event.target as Element | null)?.closest?.("[data-booth-id]");
    return clearRouteClick && !lastClickBooth && !(hit && stage.contains(hit)) && canClearRouteAt(event);
  }
  selection.on("click.floorplan", (event: MouseEvent) => {
    if (destroyed || event.detail !== 1 || event.defaultPrevented) return;
    if (pointSelection) {
      placementClick = true;
      const [x, y] = pointer(event, stage);
      options.onMapPoint?.(screenToMap(x, y), frame.pixelsPerUnit * currentView.k);
      return;
    }
    placementClick = false;
    const target = event.target as Element | null;
    const hit = target?.closest?.("[data-booth-id]");
    lastClickBooth = hit && stage.contains(hit) ? hit.getAttribute("data-booth-id") : null;
    // Capture eligibility before the first background click deselects a booth.
    clearRouteClick = !lastClickBooth && canClearRouteAt(event);
    if (hit && stage.contains(hit)) options.onSelectBooth?.(hit.getAttribute("data-booth-id")!);
    else options.onDeselectBooth?.();
  });
  selection.on("dblclick.floorplan", (event: MouseEvent) => {
    if (destroyed || event.defaultPrevented) return;
    // The first click may already have placed a pin and exited placement mode.
    if (pointSelection || placementClick) { placementClick = false; event.preventDefault(); return; }
    if (shouldClearRoute(event)) {
      clearRouteClick = false;
      event.preventDefault();
      options.onClearRoute?.();
      return;
    }
    if (!options.onDirectionsBooth) return;
    const hit = (event.target as Element | null)?.closest?.("[data-booth-id]");
    // Keep the first click's booth if automatic focusing moved it under the cursor.
    const id = lastClickBooth ?? (hit && stage.contains(hit) ? hit.getAttribute("data-booth-id") : null);
    if (!id) return;
    event.preventDefault();
    options.onDirectionsBooth(id);
  });
  selection.on("keydown.floorplan", (event: KeyboardEvent) => {
    if (event.key === "+" || event.key === "=") { event.preventDefault(); scaleBy(1.25, { animate: false }); }
    else if (event.key === "-") { event.preventDefault(); scaleBy(0.8, { animate: false }); }
    else if (event.key === "Home" || event.key === "0") { event.preventDefault(); resetView({ animate: false }); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); clearWheel(); selection.interrupt();
      const k = zoomTransform(stage).k;
      selection.call(behavior.translateBy, (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0) / k, (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) / k);
    }
  });
  function motionChanged() {
    if (preference.matches) {
      selection.interrupt();
      // Pending wheel input snaps in its next scheduled frame, never in the handler.
    }
  }
  preference.addEventListener("change", motionChanged);
  return {
    zoomIn: (motion?: MotionOptions) => scaleBy(1.25, motion),
    zoomOut: (motion?: MotionOptions) => scaleBy(0.8, motion),
    resetView, fitBounds,
    screenToMap,
    getDisplayedPixelsPerUnit: () => frame.pixelsPerUnit * currentView.k,
    setPointSelection: (enabled: boolean) => { pointSelection = enabled; },
    getTransform: () => zoomTransform(stage),
    getZoom: () => zoomTransform(stage).k,
    getFrame: () => frame,
    isHighDetail: () => threshold === 0 || zoomTransform(stage).k >= threshold,
    destroy() {
      if (destroyed) return;
      destroyed = true; clearRestore(); clearWheel(); selection.interrupt(); selection.on(".zoom", null).on(".floorplan", null);
      if (wheelFrame !== null) win.cancelAnimationFrame(wheelFrame);
      wheelFrame = null; renderTarget = null;
      preference.removeEventListener("change", motionChanged);
      observer?.disconnect(); win.removeEventListener("resize", measureViewport);
      for (const item of cullNodes) item.node.style.display = item.oldDisplay;
      for (const item of structureNodes) item.node.style.display = item.oldDisplay;
      if (labels) for (let i = 0; i < labels.children.length; i++) (labels.children[i] as SVGGElement).style.display = "";
      if (controls && previous.controls) {
        controls.zoomIn.disabled = previous.controls.inDisabled;
        controls.zoomOut.disabled = previous.controls.outDisabled;
        if (controls.indicator) controls.indicator.textContent = previous.controls.text;
      }
      behavior.on(".floorplan", null);
      restoreAnnotations();
      const restore = (node: Element, key: string, value: string | null) => { if (value === null) node.removeAttribute(key); else node.setAttribute(key, value); };
      restore(stage, "data-moving", previous.moving);
      restore(booths, "data-detail", previous.detail); restore(booths, "data-label-level", previous.boothLevel);
      camera.style.transform = previous.cameraTransform;
      stage.style.touchAction = previous.touch; stage.style.setProperty("-webkit-tap-highlight-color", previous.tap);
      if (previous.strokeScale) stage.style.setProperty("--sw", previous.strokeScale); else stage.style.removeProperty("--sw");
      if (previous.markerScale) stage.style.setProperty("--map-unit-per-pixel", previous.markerScale); else stage.style.removeProperty("--map-unit-per-pixel");
      for (const name of ["is-zooming", "is-panning", "is-interacting", "is-low-detail"]) stage.classList.toggle(name, previous.stage.includes(name));
      booths.classList.toggle("is-low-detail", previous.boothsLow);
      if (labels) { restore(labels, "data-label-level", previous.labelLevel); labels.classList.toggle("is-low-detail", previous.labelsLow); }
      if (fit && previous.fit) Object.assign(fit.style, previous.fit);
      // Remove D3's element-local state so Strict Mode/remount starts at identity.
      selection.property("__zoom", null);
    },
  };
}

export type D3ZoomEngine = ReturnType<typeof createD3ZoomEngine>;
