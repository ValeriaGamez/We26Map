"use client";

import { useEffect, useMemo, useState } from "react";
import type { FloorplanData, Point } from "@/lib/floorplan-types";
import type { FloorplanArea } from "@/lib/floorplan-area";
import { parseRoutingGraph, routeFromPin, startFromPoint, validateRoutingGraph } from "@/lib/routing";
import type { RoutingGraph, RoutingStart } from "@/lib/routing";

export function useBoothDirections(data: FloorplanData | null, area: FloorplanArea) {
  const [network, setNetwork] = useState<{ data: FloorplanData; graph?: RoutingGraph; error?: string } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [start, setStart] = useState<RoutingStart | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placementError, setPlacementError] = useState("");
  const [fitRevision, setFitRevision] = useState(0);
  useEffect(() => {
    if (!data || area !== "main") return;
    const controller = new AbortController();
    fetch("/data/routing-main.json", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error("Walking directions are unavailable while the aisle map is being prepared.");
      const graph = parseRoutingGraph(await response.json());
      const report = validateRoutingGraph(graph, data);
      if (report.errors.length) throw Error("Walking directions are unavailable because the aisle map needs updating.");
      if (!controller.signal.aborted) setNetwork({ data, graph });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNetwork({ data, error: error instanceof Error ? error.message : "Walking directions could not be loaded." });
    });
    return () => controller.abort();
  }, [data, area]);
  const graph = area === "main" && network?.data === data ? network?.graph : undefined;
  const availability = area !== "main" ? "Walking directions are not available on the Interviews map yet." : network?.data === data ? network?.error ?? "" : "Loading walking directions…";
  const result = useMemo(() => graph && start && target ? routeFromPin(graph, start, target, data?.booths) : null, [graph, start, target, data]);
  const route = result?.ok ? result.route : undefined;
  const destination = data?.booths.find(b => b.id === target);
  const destinationName = data?.companies.find(company => company.id === destination?.companyId)?.name ?? destination?.spaceLabel ?? "your destination";
  function supported(id: string) { return Boolean(graph?.nodes.some(n => n.boothId === id)); }
  function begin(id: string) {
    setTarget(id); setPlacementError("");
    if (supported(id)) { setPlacing(!start); setFitRevision(v => v + 1); }
    else setPlacing(false);
  }
  function place(point: Point, pixelsPerUnit: number) {
    if (!graph) return;
    const placement = startFromPoint(graph, data?.booths ?? [], point, pixelsPerUnit);
    if (!placement.ok) { setPlacementError(placement.reason); return; }
    const nextRoute = routeFromPin(graph, placement.start, target ?? "", data?.booths);
    if (!nextRoute.ok) { setPlacementError(nextRoute.reason); return; }
    setStart(placement.start); setPlacing(false); setPlacementError(""); setFitRevision(v => v + 1);
  }
  function clear() { setTarget(null); setStart(null); setPlacing(false); setPlacementError(""); }
  const message = placementError || (placing ? "Place your starting pin inside a booth or near an aisle. Arrow keys move the crosshair; Enter places it; Escape cancels." : result && !result.ok ? result.reason : target && !supported(target) ? availability || "Directions are not available for this booth." : route ? `To ${destinationName}` : "");
  return { supported, availability, active: target !== null, route, placing, message, fitRevision, begin, place, clear,
    moveStart: () => { setPlacementError(""); setPlacing(true); },
    cancelPlacement: () => { setPlacementError(""); setPlacing(false); if (!start) setTarget(null); },
    fitRoute: () => setFitRevision(v => v + 1),
  };
}
