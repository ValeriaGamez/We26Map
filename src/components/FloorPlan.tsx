"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Booth, Company, FloorplanData } from "@/lib/floorplan-types";
import { getBounds, safeImageUrl, unionBounds, validateFloorplan } from "@/lib/floorplan-geometry";
import { createD3ZoomEngine } from "@/utils/d3ZoomEngine";
import type { D3ZoomEngine } from "@/utils/d3ZoomEngine";
import { selectFloorplanArea } from "@/lib/floorplan-area";
import type { FloorplanArea } from "@/lib/floorplan-area";
import styles from "./FloorPlan.module.css";

export type FloorPlanProps = {
  area?: FloorplanArea;
  dataUrl?: string;
  selectedBoothId?: string | null;
  focusRequest?: { boothId: string; revision: number } | null;
  matchingBoothIds?: ReadonlySet<string>;
  minZoom?: number;
  maxZoom?: number;
  detailThreshold?: number;
  onSelectBooth?: (boothId: string) => void;
  onDataLoad?: (data: FloorplanData) => void;
  onEngineReady?: (engine: D3ZoomEngine | null) => void;
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

function MapSurface({ data, selectedBoothId, onSelectBooth, focusRequest, matchingBoothIds, minZoom = 1.0, maxZoom = 24, detailThreshold = 1.8, onEngineReady }: Omit<FloorPlanProps, "dataUrl" | "onDataLoad"> & { data: FloorplanData }) {
  const svg = useRef<SVGSVGElement>(null);
  const cameraGroup = useRef<SVGGElement>(null);
  const engine = useRef<D3ZoomEngine | null>(null);
  const callbacks = useRef({ onSelectBooth, onEngineReady });
  useEffect(() => { callbacks.current = { onSelectBooth, onEngineReady }; }, [onSelectBooth, onEngineReady]);
  const [internalSelection, setInternalSelection] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showLogos, setShowLogos] = useState(true);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const prefix = useId().replaceAll(":", "");
  const selectedId = selectedBoothId === undefined ? internalSelection : selectedBoothId;
  const companies = useMemo(() => new Map(data.companies.map((company) => [company.id, company])), [data]);
  const shapes = useMemo(() => data.booths.map((booth) => ({ booth, bounds: getBounds(booth.polygons) })), [data]);
  const selected = useMemo(() => data.booths.find((booth) => booth.id === selectedId), [data, selectedId]);
  const sceneBounds = useMemo(() => unionBounds([
    data.bounds,
    ...(data.hallStructure?.regions ?? []).map((region) => getBounds(region.polygons)),
    ...(data.hallStructure?.labels ?? []).map((label) => ({ x: label.x - label.size, y: label.y - label.size, width: label.size * 2, height: label.size * 2 })),
  ]), [data]);
  const select = useCallback((id: string) => { setInternalSelection(id); callbacks.current.onSelectBooth?.(id); }, []);
  useEffect(() => {
    if (!svg.current || !cameraGroup.current) return;
    const surface = svg.current;
    const controller = createD3ZoomEngine(surface, cameraGroup.current, {
      bounds: sceneBounds, minZoom, maxZoom, detailThreshold, onSelectBooth: select,
    });
    engine.current = controller;
    callbacks.current.onEngineReady?.(controller);
    return () => { controller.destroy(); engine.current = null; callbacks.current.onEngineReady?.(null); };
  }, [sceneBounds, minZoom, maxZoom, detailThreshold, select]);
  useEffect(() => {
    if (!focusRequest) return;
    const shape = shapes.find(({ booth }) => booth.id === focusRequest.boothId);
    if (!shape) return;
    const { x, y, width, height } = shape.bounds;
    engine.current?.fitBounds(x - 5, y - 5, x + width + 5, y + height + 5);
  }, [focusRequest, shapes, sceneBounds, minZoom, maxZoom, detailThreshold]);

  return <div className={styles.container} data-selected={Boolean(selected)}>
    <div className={styles.controls} role="group" aria-label="Floor plan controls">
      <button onClick={() => engine.current?.zoomIn()} aria-label="Zoom In (+)" title="Zoom In (+)">+</button>
      <button onClick={() => engine.current?.zoomOut()} aria-label="Zoom Out (-)" title="Zoom Out (-)">&minus;</button>
      <button onClick={() => engine.current?.resetView()}>Reset View</button>
      <button aria-pressed={showLogos} onClick={() => setShowLogos((value) => !value)}>Logos</button>
      <button aria-pressed={showLabels} onClick={() => setShowLabels((value) => !value)}>Labels</button>
    </div>
    <svg id="floorplan-svg" ref={svg} className={styles.svg} aria-label="WE26 floor plan. Drag to pan, scroll or pinch to zoom. Tab to booths; Enter selects. Arrow keys pan." tabIndex={0}>
      <title>{data.area === "interview" ? "WE26 interview booths" : "WE26 main booths"}</title>
      {data.areaClip && <defs><clipPath id={`${prefix}-area`}><rect {...data.areaClip} /></clipPath></defs>}
      <g id="viewport-matrix" ref={cameraGroup} className={styles.viewport}>
      <g id="venue-context" className={styles.backdrop} clipPath={data.areaClip ? `url(#${prefix}-area)` : undefined}>
        <g id="hall-structure" className={styles.structure} aria-label="Official venue structure">
          {data.hallStructure?.backdrop && !backdropFailed && <image href={safeImageUrl(data.hallStructure.backdrop.href)} {...data.hallStructure.backdrop.bounds} preserveAspectRatio="none" onError={() => setBackdropFailed(true)} />}
          {data.hallStructure?.regions.map((region, index) => <g key={index}><title>{region.name}</title>{region.polygons.map((polygon, i) => <polygon key={i} points={polygon.map((p) => p.join(",")).join(" ")} className={styles.region} vectorEffect="non-scaling-stroke" />)}</g>)}
          <g className={styles.annotations}>{data.hallStructure?.labels.map((label, index) => <text key={index} x={label.x} y={label.y} fontSize={label.size} transform={`rotate(${label.rotation} ${label.x} ${label.y})`} textAnchor="middle" dominantBaseline="central">{label.text}</text>)}</g>
        </g>
      </g>
        <g id="booths">{shapes.map(({ booth, bounds }) => <BoothShape key={booth.id} prefix={prefix} booth={booth} bounds={bounds} company={booth.companyId ? companies.get(booth.companyId) : undefined} selected={booth.id === selectedId} related={Boolean(selected?.companyId && booth.companyId === selected.companyId)} dimmed={Boolean(matchingBoothIds && !matchingBoothIds.has(booth.id))} showLabels={showLabels} showLogos={showLogos} onSelect={select} />)}</g>
      </g>
    </svg>
    <div className={styles.legend}><span><i /> Rented</span><span><i className={styles.availableSwatch} /> Available</span><span><i className={styles.selectedSwatch} /> Selected</span><span>Source geometry / estimated feet</span></div>
    {(!data.hallStructure?.backdrop || backdropFailed) && <p className={styles.warning} role="status">Venue backdrop unavailable. Booth geometry remains visible.</p>}
  </div>;
}

type ShapeProps = { prefix: string; booth: Booth; bounds: ReturnType<typeof getBounds>; company?: Company; selected: boolean; related: boolean; dimmed: boolean; showLabels: boolean; showLogos: boolean; onSelect: (id: string) => void };
const BoothShape = memo(function BoothShape({ prefix, booth, bounds, company, selected, related, dimmed, showLabels, showLogos, onSelect }: ShapeProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = safeImageUrl(booth.logoUrl ?? company?.logoUrl);
  const hasLogo = showLogos && logo && !logoFailed;
  const clipId = `${prefix}-${booth.id}-clip`;
  const cx = bounds.x + bounds.width / 2;
  const padding = Math.min(bounds.width, bounds.height) * 0.07;
  const fontSize = Math.max(0.35, Math.min(2, bounds.height * 0.13, bounds.width * 0.17));
  const name = booth.spaceLabel ?? company?.name ?? "Available";
  const characters = Math.max(5, Math.floor((bounds.width - padding * 2) / (fontSize * 0.55)));
  const words = name.split(/\s+/), lines: string[] = [];
  for (const word of words) {
    if (lines.length && (lines.at(-1)!.length + word.length + 1) <= characters) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  const displayedLines = lines.slice(0, 3);
  if (lines.length > 3) displayedLines[2] += "…";
  const status = booth.status ?? (company ? "rented" : "available");
  return <g data-booth-id={booth.id} className={`${styles.booth} ${styles[status]} ${selected ? styles.selected : related ? styles.related : ""} ${dimmed ? styles.dimmed : ""}`} role="button" tabIndex={0} aria-label={`Booth ${booth.number}, ${name}, ${status}${booth.spaceType === "queue" ? ", queue space" : ""}`} aria-pressed={selected} onClick={(event) => { if (event.detail === 0) onSelect(booth.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelect(booth.id); } }}>
    <title>{name} · Booth {booth.number} · {status}</title>
    <defs><clipPath id={clipId}>{booth.polygons.map((polygon, i) => <polygon key={i} points={polygon.map((p) => p.join(",")).join(" ")} />)}</clipPath></defs>
    {booth.polygons.map((polygon, i) => <polygon key={i} className={styles.boundary} points={polygon.map((p) => p.join(",")).join(" ")} vectorEffect="non-scaling-stroke" />)}
    <text className={styles.mainLabel} clipPath={`url(#${clipId})`} textAnchor="middle" fontSize={fontSize} x={cx} y={bounds.y + padding + fontSize} fontWeight="700">{booth.number}</text>
    <g clipPath={`url(#${clipId})`} className={styles.content}>
      {hasLogo && <image href={logo} x={bounds.x + padding} y={showLabels ? bounds.y + bounds.height * 0.3 : bounds.y + padding} width={Math.max(0.1, bounds.width - padding * 2)} height={showLabels ? bounds.height * 0.4 : Math.max(0.1, bounds.height - padding * 2)} preserveAspectRatio="xMidYMid meet" onError={() => setLogoFailed(true)} />}
      {showLabels && <text textAnchor="middle" fontSize={fontSize}>
        {displayedLines.map((line, index) => <tspan key={index} x={cx} y={hasLogo ? bounds.y + bounds.height * 0.74 + index * fontSize * 1.15 : bounds.y + padding + fontSize * (2.6 + index * 1.15)}>{line}</tspan>)}
      </text>}
    </g>
  </g>;
});
