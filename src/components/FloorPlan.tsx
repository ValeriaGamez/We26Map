"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Booth, Bounds, Company, FloorplanData, Point } from "@/lib/floorplan-types";
import { getBounds, safeImageUrl, unionBounds, validateFloorplan } from "@/lib/floorplan-geometry";
import { createD3ZoomEngine, fittedViewBox } from "@/utils/d3ZoomEngine";
import type { D3ZoomEngine, SettledView } from "@/utils/d3ZoomEngine";
import { selectFloorplanArea } from "@/lib/floorplan-area";
import { boothLabelTier } from "@/lib/booth-label-lod";
import type { FloorplanArea } from "@/lib/floorplan-area";
import styles from "./FloorPlan.module.css";

const majorLandmark = /\b(lobby|registration|entrance|main entry|hall [a-z])\b/i;

export type FloorPlanProps = {
  area?: FloorplanArea;
  dataUrl?: string;
  selectedBoothId?: string | null;
  focusRequest?: { boothId: string; revision: number } | null;
  matchingBoothIds?: ReadonlySet<string>;
  savedCompanyIds?: ReadonlySet<string>;
  visitedCompanyIds?: ReadonlySet<string>;
  minZoom?: number;
  maxZoom?: number;
  detailThreshold?: number;
  onSelectBooth?: (boothId: string) => void;
  onDeselectBooth?: () => void;
  onDataLoad?: (data: FloorplanData) => void;
  onEngineReady?: (engine: D3ZoomEngine | null) => void;
  pointSelection?: boolean;
  onMapPoint?: (point: Point, pixelsPerUnit: number) => void;
  onCancelPlacement?: () => void;
  routePoints?: Point[];
  routeFitRevision?: number;
  mapOverlay?: React.ReactNode;
};

export default function FloorPlan({ dataUrl = "/data/booths.json", area = "main", onDataLoad, ...props }: FloorPlanProps) {
  const [data, setData] = useState<FloorplanData | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(onDataLoad);
  useEffect(() => { loaded.current = onDataLoad; }, [onDataLoad]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(dataUrl, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Floor-plan request failed (${response.status}).`);
      const snapshot: unknown = await response.json();
      validateFloorplan(snapshot);
      const view = selectFloorplanArea(snapshot, area);
      if (!controller.signal.aborted) { setData(view); loaded.current?.(view); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load the floor plan."); });
    return () => controller.abort();
  }, [dataUrl, attempt, area]);
  if (!data) return <div className={styles.message} role="status"><p>{error || "Loading the official WE26 floor plan..."}</p>{error && <button onClick={() => { setError(""); setAttempt((n) => n + 1); }}>Retry</button>}</div>;
  return <MapSurface key={`${dataUrl}-${area}`} data={data} {...props} />;
}

function MapSurface({ data, selectedBoothId, onSelectBooth, onDeselectBooth, focusRequest, matchingBoothIds, savedCompanyIds, visitedCompanyIds, minZoom = 1.0, maxZoom = 8, detailThreshold = 1.8, onEngineReady, pointSelection = false, onMapPoint, onCancelPlacement, routePoints, routeFitRevision = 0, mapOverlay }: Omit<FloorPlanProps, "dataUrl" | "onDataLoad"> & { data: FloorplanData }) {
  const stage = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLDivElement>(null);
  const fit = useRef<HTMLDivElement>(null);
  const boothLayer = useRef<SVGSVGElement>(null);
  const backdropLayer = useRef<SVGSVGElement>(null);
  const labelLayer = useRef<SVGSVGElement>(null);
  const zoomInButton = useRef<HTMLButtonElement>(null);
  const zoomOutButton = useRef<HTMLButtonElement>(null);
  const engine = useRef<D3ZoomEngine | null>(null);
  const callbacks = useRef({ onSelectBooth, onDeselectBooth, onEngineReady, onMapPoint });
  useEffect(() => { callbacks.current = { onSelectBooth, onDeselectBooth, onEngineReady, onMapPoint }; }, [onSelectBooth, onDeselectBooth, onEngineReady, onMapPoint]);
  const [crosshair, setCrosshair] = useState({ x: 0.5, y: 0.5 });
  const [internalSelection, setInternalSelection] = useState<string | null>(null);
  const showLabels = true;
  const [backdropFailed, setBackdropFailed] = useState(false);
  // Mount labels for the displayed and upcoming view during zoom/pan.
  // The engine deduplicates view changes and handles per-frame CSS culling.
  const [view, setView] = useState<{ level: number; visibleIds: ReadonlySet<string> } | null>(null);
  const settle = useCallback((next: SettledView) => setView({ level: next.level, visibleIds: new Set(next.visibleIds) }), []);
  const selectedId = selectedBoothId === undefined ? internalSelection : selectedBoothId;
  const companies = useMemo(() => new Map(data.companies.map((company) => [company.id, company])), [data]);
  const shapes = useMemo(() => data.booths.map((booth) => { const bounds = getBounds(booth.polygons); return { booth, bounds, tier: boothLabelTier(bounds, data.area) }; }), [data]);
  const labelShapes = useMemo(() => showLabels && view ? shapes.filter(({ booth, tier }) => tier <= view.level && view.visibleIds.has(booth.id)) : [], [shapes, showLabels, view]);
  const selected = useMemo(() => data.booths.find((booth) => booth.id === selectedId), [data, selectedId]);
  const sceneBounds = useMemo(() => unionBounds([
    data.bounds,
    ...(data.hallStructure?.regions ?? []).map((region) => getBounds(region.polygons)),
    ...(data.hallStructure?.labels ?? []).map((label) => ({ x: label.x - label.size, y: label.y - label.size, width: label.size * 2, height: label.size * 2 })),
  ]), [data]);
  const viewBox = useMemo(() => fittedViewBox(sceneBounds), [sceneBounds]);
  const viewBoxAttr = `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`;
  // The venue PNG is an HTML <img> (not an SVG <image>), clipped in map units.
  const backdrop = data.hallStructure?.backdrop ?? null;
  const imageClip = data.areaClip ?? backdrop?.bounds ?? null;
  const select = useCallback((id: string) => { setInternalSelection(id); callbacks.current.onSelectBooth?.(id); }, []);
  const deselect = useCallback(() => { setInternalSelection(null); callbacks.current.onDeselectBooth?.(); }, []);
  useEffect(() => {
    if (!stage.current || !camera.current || !fit.current || !boothLayer.current || !backdropLayer.current || !labelLayer.current || !zoomInButton.current || !zoomOutButton.current) return;
    const controller = createD3ZoomEngine(stage.current, camera.current, {
      bounds: sceneBounds, minZoom, maxZoom, detailThreshold, onSelectBooth: select, onDeselectBooth: deselect, onViewSettle: settle,
      onMapPoint: (point, scale) => callbacks.current.onMapPoint?.(point, scale),
      fit: fit.current, booths: boothLayer.current, backdrop: backdropLayer.current, labels: labelLayer.current,
      controls: { zoomIn: zoomInButton.current, zoomOut: zoomOutButton.current },
    });
    engine.current = controller;
    callbacks.current.onEngineReady?.(controller);
    return () => { controller.destroy(); engine.current = null; callbacks.current.onEngineReady?.(null); };
  }, [sceneBounds, minZoom, maxZoom, detailThreshold, select, deselect, settle]);
  useEffect(() => {
    engine.current?.setPointSelection(pointSelection);
    if (pointSelection) stage.current?.focus({ preventScroll: true });
  }, [pointSelection, sceneBounds, minZoom, maxZoom, detailThreshold]);
  useEffect(() => {
    if (!focusRequest) return;
    const shape = shapes.find(({ booth }) => booth.id === focusRequest.boothId);
    if (!shape) return;
    const { x, y, width, height } = shape.bounds;
    // Frame the booth's neighborhood instead of filling the map with one booth.
    const padding = Math.max(35, Math.max(width, height) * 0.75);
    engine.current?.fitBounds(x - padding, y - padding, x + width + padding, y + height + padding);
  }, [focusRequest, shapes, sceneBounds, minZoom, maxZoom, detailThreshold]);
  useEffect(() => {
    if (!routePoints?.length) return;
    const xs = routePoints.map(p => p[0]), ys = routePoints.map(p => p[1]);
    engine.current?.fitBounds(Math.min(...xs) - 25, Math.min(...ys) - 25, Math.max(...xs) + 25, Math.max(...ys) + 25);
  }, [routePoints, routeFitRevision]);

  return <div className={styles.container} data-selected={Boolean(selected)} data-show-labels={showLabels}>
    <div className={styles.controls} role="group" aria-label="Floor plan controls">
      <button ref={zoomInButton} onClick={() => engine.current?.zoomIn()} aria-label="Zoom In (+)" title="Zoom In (+)">+</button>
      <button ref={zoomOutButton} onClick={() => engine.current?.zoomOut()} aria-label="Zoom Out (-)" title="Zoom Out (-)">&minus;</button>
      <button onClick={() => engine.current?.resetView()} aria-label="Recenter map" title="Recenter map">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /></svg>
      </button>
    </div>
    {/* D3 listens on the stage (CSS-pixel extent). Only the camera div is transformed;
        it is an HTML box, so the browser composites it rather than re-laying-out SVG. */}
    <div id="floorplan-stage" ref={stage} className={styles.stage} data-placing={pointSelection} role="group" aria-label={`${data.area === "interview" ? "WE26 interview booths" : "WE26 main booths"} floor plan. ${pointSelection ? "Tap inside a booth or near an aisle to place a point. Arrow keys move the crosshair; Enter confirms; Escape cancels." : "Drag to pan, scroll or pinch to zoom. Tab to booths; Enter selects. Arrow keys pan."}`} tabIndex={0} onKeyDownCapture={event => {
      if (!pointSelection) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancelPlacement?.(); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const rect = stage.current!.getBoundingClientRect();
        if (event.key === "Enter") {
          const point = engine.current?.screenToMap(crosshair.x * rect.width, crosshair.y * rect.height);
          if (point) onMapPoint?.(point, engine.current!.getDisplayedPixelsPerUnit());
        } else setCrosshair(p => ({ x: Math.max(0, Math.min(1, p.x + (event.key === "ArrowLeft" ? -12 : event.key === "ArrowRight" ? 12 : 0) / Math.max(1, rect.width))), y: Math.max(0, Math.min(1, p.y + (event.key === "ArrowUp" ? -12 : event.key === "ArrowDown" ? 12 : 0) / Math.max(1, rect.height))) }));
      }
    }}>
      <div ref={camera} className={styles.camera}>
        <div ref={fit} className={styles.fit}>
          {backdrop && imageClip && !backdropFailed && <div className={styles.imageClip} style={percentBox(imageClip, viewBox)} aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element -- static venue raster positioned in map units */}
            <img className={styles.venueImage} src={safeImageUrl(backdrop.href)} alt="" draggable={false} decoding="async" style={percentBox(backdrop.bounds, imageClip)} onError={() => setBackdropFailed(true)} />
          </div>}
          {/* Static venue content is its own layer and never receives pointer events. */}
          <svg id="venue-backdrop" ref={backdropLayer} className={`${styles.layer} ${styles.backdrop}`} viewBox={viewBoxAttr} preserveAspectRatio="none" aria-hidden="true">
            <g id="hall-structure" className={styles.structure}>
              {data.hallStructure?.regions.map((region, index) => <g key={index}>{region.polygons.map((polygon, i) => <polygon key={i} points={polygon.map((p) => p.join(",")).join(" ")} className={styles.region} />)}</g>)}
              <g>{data.hallStructure?.labels.filter(label => !/^[0oO]$/.test(label.text.trim())).map((label, index) => <text key={index} className={majorLandmark.test(label.text) ? styles.landmark : styles.annotations} x={label.x} y={label.y} fontSize={label.size} transform={`rotate(${label.rotation} ${label.x} ${label.y})`} textAnchor="middle" dominantBaseline="central">{label.text}</text>)}</g>
            </g>
          </svg>
          <svg id="viewport-matrix" ref={boothLayer} className={`${styles.layer} ${styles.viewport}`} viewBox={viewBoxAttr} preserveAspectRatio="none">
            {shapes.map(({ booth, bounds }) => <BoothRect key={booth.id} booth={booth} bounds={bounds} company={booth.companyId ? companies.get(booth.companyId) : undefined} selected={booth.id === selectedId} related={Boolean(selected?.companyId && booth.companyId === selected.companyId)} visited={Boolean(booth.companyId && visitedCompanyIds?.has(booth.companyId))} dimmed={Boolean(matchingBoothIds && !matchingBoothIds.has(booth.id))} onSelect={select} />)}
          </svg>
          <svg id="booth-labels" ref={labelLayer} className={`${styles.layer} ${styles.viewport} ${styles.labelViewport}`} viewBox={viewBoxAttr} preserveAspectRatio="none" aria-hidden="true">
            {labelShapes.map(({ booth, bounds, tier }) => <BoothLabel key={booth.id} booth={booth} bounds={bounds} tier={tier} company={booth.companyId ? companies.get(booth.companyId) : undefined} visited={Boolean(booth.companyId && visitedCompanyIds?.has(booth.companyId))} dimmed={Boolean(matchingBoothIds && !matchingBoothIds.has(booth.id))} />)}
          </svg>
          <svg id="booth-status" className={`${styles.layer} ${styles.labelViewport}`} viewBox={viewBoxAttr} preserveAspectRatio="none" aria-hidden="true">
            {shapes.filter(({ booth }) => booth.companyId && (savedCompanyIds?.has(booth.companyId) || visitedCompanyIds?.has(booth.companyId))).map(({ booth, bounds }) => <circle key={booth.id} data-company-marker={booth.companyId} className={`${styles.mapMarker} ${visitedCompanyIds?.has(booth.companyId!) ? styles.visitedMarker : styles.savedMarker} ${matchingBoothIds && !matchingBoothIds.has(booth.id) ? styles.dimmed : ""}`} cx={bounds.x + bounds.width / 2} cy={bounds.y + bounds.height * .84} r="4" />)}
          </svg>
          <svg id="walking-route" className={`${styles.layer} ${styles.labelViewport}`} viewBox={viewBoxAttr} preserveAspectRatio="none" aria-hidden="true">
            {routePoints && routePoints.length > 0 && <>
              <polyline points={routePoints.map(p => p.join(",")).join(" ")} fill="none" stroke="white" strokeWidth="9" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={routePoints.map(p => p.join(",")).join(" ")} fill="none" stroke="#165dcc" strokeWidth="5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              <circle data-route-marker="start" className={`${styles.mapMarker} ${styles.routeMarker} ${styles.routeStart}`} cx={routePoints[0][0]} cy={routePoints[0][1]} r="7" />
              <circle data-route-marker="end" className={`${styles.mapMarker} ${styles.routeMarker} ${styles.routeEnd}`} cx={routePoints.at(-1)![0]} cy={routePoints.at(-1)![1]} r="7" />
            </>}
            {mapOverlay}
          </svg>
        </div>
      </div>
      {pointSelection && <span className={styles.placementCrosshair} style={{ left: `${crosshair.x * 100}%`, top: `${crosshair.y * 100}%` }} aria-hidden="true">+</span>}
    </div>
    {(!data.hallStructure?.backdrop || backdropFailed) && <p className={styles.warning} role="status">Venue backdrop unavailable. Booth geometry remains visible.</p>}
  </div>;
}

/** Position `box` inside `frame` with percentages, so no JS runs on resize. */
function percentBox(box: Bounds, frame: Bounds) {
  const pct = (value: number) => `${value * 100}%`;
  return { left: pct((box.x - frame.x) / frame.width), top: pct((box.y - frame.y) / frame.height), width: pct(box.width / frame.width), height: pct(box.height / frame.height) };
}

type ShapeProps = { booth: Booth; bounds: ReturnType<typeof getBounds>; company?: Company; selected: boolean; related: boolean; visited: boolean; dimmed: boolean; onSelect: (id: string) => void };
const BoothRect = memo(function BoothRect({ booth, bounds, company, selected, related, visited, dimmed, onSelect }: ShapeProps) {
  const name = booth.spaceLabel ?? company?.name ?? "Available";
  const status = booth.status ?? (company ? "rented" : "available");
  return <rect {...bounds} data-booth-id={booth.id} className={`booth-shape booth-rect ${styles.boundary} ${styles.booth} ${styles[status]} ${visited ? styles.visited : ""} ${selected ? styles.selected : related ? styles.related : ""} ${dimmed ? styles.dimmed : ""}`} role="button" tabIndex={0} aria-label={`Booth ${booth.number}, ${name}, ${status}${visited ? ", visited" : ""}${booth.spaceType === "queue" ? ", queue space" : ""}`} aria-pressed={selected} onClick={(event) => { if (event.detail === 0) onSelect(booth.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelect(booth.id); } }} />;
});

type LabelProps = Pick<ShapeProps, "booth" | "bounds" | "company" | "dimmed" | "visited"> & { tier: number };
/** One <text> per booth. Lines are measured to fit, so no per-booth clipPath
 * (three extra nodes and a GPU clip per frame) is needed. */
const BoothLabel = memo(function BoothLabel({ booth, bounds, tier, company, dimmed, visited }: LabelProps) {
  const cx = bounds.x + bounds.width / 2;
  const padding = Math.min(bounds.width, bounds.height) * 0.07;
  const fontSize = Math.max(0.35, Math.min(2, bounds.height * 0.13, bounds.width * 0.17));
  const nameSize = fontSize * 0.8;
  const nameLines = company ? wrapName(company.name, Math.max(5, Math.floor((bounds.width - padding * 2) / (nameSize * 0.62))), Math.max(1, Math.min(3, Math.floor((bounds.height * 0.57 - padding) / (nameSize * 1.15))))) : [];
  return <g className={`${styles.labels} ${dimmed ? styles.dimmed : ""}`} data-booth-label-id={booth.id} data-label-tier={tier}>
    <text className={`booth-label ${styles.mainLabel} ${visited ? styles.visitedLabel : ""}`} textAnchor="middle" fontSize={nameSize}>
      <tspan className="booth-number" x={cx} y={bounds.y + padding + fontSize} fontSize={fontSize} fontWeight="700">{booth.number}</tspan>
      {nameLines.map((line, index) => <tspan key={index} className="booth-company-name" x={cx} y={bounds.y + bounds.height * 0.43 + index * nameSize * 1.15}>{line}</tspan>)}
    </text>
  </g>;
});

function wrapName(name: string, characters: number, maxLines: number) {
  const lines: string[] = [];
  for (const word of name.split(/\s+/)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + word.length + 1 <= characters) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  const shown = lines.slice(0, maxLines).map((line) => line.length > characters ? `${line.slice(0, characters - 1)}…` : line);
  if (lines.length > maxLines) shown[maxLines - 1] = `${shown[maxLines - 1].slice(0, characters - 1)}…`;
  return shown;
}
