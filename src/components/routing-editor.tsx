"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import FloorPlan from "./FloorPlan";
import type { FloorplanData, Point } from "@/lib/floorplan-types";
import { emptyGraph, geometryKey, length, parseRoutingGraph, pointOf, projectToSegment, routableBooths, routeFromPin, snapToAisle, splitEdge, startFromPoint, validateRoutingGraph } from "@/lib/routing";
import type { RoutingGraph, WalkingRoute } from "@/lib/routing";
import { attachBooth, connectAisles, deleteNode, moveNode } from "@/lib/routing-editor";
import styles from "./routing-editor.module.css";

type Mode = "select" | "add" | "move" | "connect" | "attach" | "preview";
const uniqueId = () => crypto.randomUUID();
const storageKey = "we26.routing-editor.draft.v1";

export default function RoutingEditor() {
  const [data, setData] = useState<FloorplanData | null>(null);
  const [graph, setGraph] = useState<RoutingGraph | null>(null);
  const [history, setHistory] = useState<RoutingGraph[]>([]);
  const [mode, setMode] = useState<Mode>("select");
  const [nodeId, setNodeId] = useState("");
  const [edgeId, setEdgeId] = useState("");
  const [boothId, setBoothId] = useState("");
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState("Loading floor plan and routing draft…");
  const [preview, setPreview] = useState<WalkingRoute>();
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    async function load() {
      let draft: RoutingGraph | null = null;
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) { const parsed = parseRoutingGraph(JSON.parse(stored)); if (parsed.geometryKey === geometryKey(data!)) draft = parsed; }
      } catch { /* A blocked or old browser draft must not prevent authoring. */ }
      if (!draft) {
        try { const response = await fetch("/data/routing-main.json", { signal: controller.signal }); if (response.ok) draft = parseRoutingGraph(await response.json()); }
        catch { /* Start with an empty network when there is no usable file. */ }
      }
      if (!controller.signal.aborted) { setGraph(draft ?? emptyGraph(data!)); setMessage("Trace aisle centers against the venue plan. Orange segments have no optional review recorded; green segments have been reviewed. Reviews are not required to export."); }
    }
    void load();
    return () => controller.abort();
  }, [data]);
  const report = useMemo(() => graph && data ? validateRoutingGraph(graph, data) : null, [graph, data]);
  const nodes = useMemo(() => new Map(graph?.nodes.map(n => [n.id, n]) ?? []), [graph]);
  const selectedNode = nodes.get(nodeId), selectedEdge = graph?.edges.find(e => e.id === edgeId);
  const booths = data ? routableBooths(data) : [];
  const attached = new Set(graph?.nodes.filter(n => n.boothId).map(n => n.boothId));
  function save(next: RoutingGraph) {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { setMessage("Browser draft storage is unavailable. Export JSON to keep your work."); }
  }
  function commit(next: RoutingGraph) {
    if (graph) setHistory(old => [...old.slice(-99), graph]);
    setGraph(next); setPreview(undefined); save(next);
  }
  function click(point: Point, scale: number) {
    if (!graph || !data) return;
    try {
      const nearest = graph.nodes.reduce<{ id: string; distance: number } | null>((best, n) => {
        const distance = length(point, pointOf(n)) * scale;
        return distance <= 14 && (!best || distance < best.distance) ? { id: n.id, distance } : best;
      }, null);
      if (mode === "select") {
        if (nearest) { setNodeId(nearest.id); setEdgeId(""); }
        else {
          const candidates = graph.edges.map(e => ({ id: e.id, distance: projectToSegment(point, pointOf(nodes.get(e.from)!), pointOf(nodes.get(e.to)!)).distance * scale })).sort((a, b) => a.distance - b.distance);
          setEdgeId(candidates[0]?.distance <= 14 ? candidates[0].id : ""); setNodeId("");
        }
      } else if (mode === "add") {
        const snap = snapToAisle(graph, point, scale, 10);
        if (snap) { const split = splitEdge(graph, snap.edgeId, snap.point, uniqueId()); commit(split.graph); setNodeId(split.nodeId); }
        else { const id = uniqueId(); commit({ ...graph, nodes: [...graph.nodes, { id, x: point[0], y: point[1] }] }); setNodeId(id); }
      } else if (mode === "move") {
        if (!selectedNode) throw Error("Select a node before choosing Move.");
        commit(moveNode(graph, nodeId, point)); setMode("select");
      } else if (mode === "connect") {
        if (!nearest || nodes.get(nearest.id)?.boothId) throw Error("Click an aisle node.");
        if (!selectedNode || selectedNode.boothId) setNodeId(nearest.id);
        else { commit(connectAisles(graph, nodeId, nearest.id, uniqueId)); setNodeId(nearest.id); }
      } else if (mode === "attach") {
        const booth = booths.find(b => b.id === boothId);
        if (!booth) throw Error("Choose a destination booth first.");
        if (!selectedEdge) throw Error("Select an aisle segment before attaching a booth.");
        const boundary = booth.polygons.flatMap(polygon => polygon.map((a, i) => projectToSegment(point, a, polygon[(i + 1) % polygon.length]))).sort((a, b) => a.distance - b.distance)[0];
        if (!boundary || boundary.distance * scale > 24) throw Error("Click the aisle-facing edge of the chosen booth.");
        commit(attachBooth(graph, boothId, boundary.point, edgeId, uniqueId)); setEdgeId(""); setMode("select");
      } else if (mode === "preview") {
        const placement = startFromPoint(graph, data.booths, point, scale);
        if (!placement.ok) throw Error(placement.reason);
        const result = routeFromPin(graph, placement.start, boothId, data.booths);
        if (!result.ok) throw Error(result.reason);
        setPreview(result.route); setMessage(`DRAFT route: approximately ${Math.round(result.route.distance)} ft. Verify it against walls and restrictions.`); return;
      }
      setMessage("Draft updated. Resolve any validation errors to export for release. Individual reviews are optional.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not edit this connection."); }
  }
  function download(release: boolean) {
    if (!graph || (release && !report?.ready)) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2) + "\n"], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = release ? "routing-main.json" : "routing-main-draft.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(release ? "Validated file exported. Replace public/data/routing-main.json and run npm run check:routing." : "Draft exported. Public directions require the automatic coverage, geometry, and connectivity checks to pass.");
  }
  return <main className={styles.editor}>
    <div className={styles.map}>
      <FloorPlan area="main" onDataLoad={setData} pointSelection onMapPoint={click} onCancelPlacement={() => setMode("select")} routePoints={preview?.points} mapOverlay={<>
        {graph?.edges.map(e => { const a = nodes.get(e.from)!, b = nodes.get(e.to)!; return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.id === edgeId ? "#165dcc" : e.reviewed ? "#087b43" : "#d46906"} strokeWidth={e.id === edgeId ? 6 : 3} vectorEffect="non-scaling-stroke" />; })}
        {graph?.nodes.map(n => <circle key={n.id} cx={n.x} cy={n.y} r=".01" stroke={n.id === nodeId ? "#165dcc" : n.boothId ? n.reviewed ? "#087b43" : "#b72e22" : "#36303d"} strokeWidth={n.id === nodeId ? 14 : n.boothId ? 8 : 6} vectorEffect="non-scaling-stroke" />)}
      </>} />
    </div>
    <aside className={styles.tools} aria-label="Routing network editor">
      <h1>Walking network editor</h1>
      <p>Development only · Main Floor · distances in feet</p>
      <p role="status" aria-live="polite">{message}</p>
      <fieldset><legend>Map tool</legend><div className={styles.buttons}>{(["select", "add", "move", "connect", "attach", "preview"] as Mode[]).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value); if (value === "connect") setNodeId(""); }}>{value}</button>)}</div></fieldset>
      <p className={styles.help}>Add points along aisle centers. Connect two nodes; crossings split automatically. Select a node then Move and tap its new location. To attach: select an aisle segment, choose a booth, choose Attach, then tap its aisle-facing boundary. Preview tests a route from a pin. Arrow keys move the crosshair; Enter confirms.</p>
      <label>Node<select value={selectedNode ? nodeId : ""} onChange={e => { setNodeId(e.target.value); setEdgeId(""); }}><option value="">Choose node</option>{graph?.nodes.map(n => <option key={n.id} value={n.id}>{n.boothId ?? n.id} ({n.x.toFixed(1)}, {n.y.toFixed(1)})</option>)}</select></label>
      {selectedNode && <>
        <button onClick={() => { commit(deleteNode(graph!, nodeId)); setNodeId(""); }}>Delete selected node</button>
        {selectedNode.boothId && <label><input type="checkbox" checked={selectedNode.reviewed === true} onChange={e => commit({ ...graph!, nodes: graph!.nodes.map(n => n.id === nodeId ? { ...n, reviewed: e.target.checked } : n) })} /> I checked this booth’s aisle-facing access.</label>}
      </>}
      <label>Connection<select value={selectedEdge ? edgeId : ""} onChange={e => { setEdgeId(e.target.value); setNodeId(""); }}><option value="">Choose connection</option>{graph?.edges.map(e => <option key={e.id} value={e.id}>{e.reviewed ? "✓" : "○"} {e.id}</option>)}</select></label>
      {selectedEdge && <>
        <label><input type="checkbox" checked={selectedEdge.reviewed} onChange={e => commit({ ...graph!, edges: graph!.edges.map(edge => edge.id === edgeId ? { ...edge, reviewed: e.target.checked } : edge) })} /> I checked this segment against booths, walls, and restricted spaces.</label>
        <button onClick={() => { commit({ ...graph!, edges: graph!.edges.filter(e => e.id !== edgeId) }); setEdgeId(""); }}>Delete connection</button>
      </>}
      <label>Find destination booth<input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Booth number or company" /></label>
      <label>Destination<select value={boothId} onChange={e => { setBoothId(e.target.value); setPreview(undefined); }}><option value="">Choose booth</option>{booths.filter(b => b.id === boothId || `${b.number} ${data?.companies.find(c => c.id === b.companyId)?.name}`.toLowerCase().includes(filter.toLowerCase())).map(b => <option key={b.id} value={b.id}>{attached.has(b.id) ? "✓" : "○"} {b.number} · {data?.companies.find(c => c.id === b.companyId)?.name}</option>)}</select></label>
      <div className={styles.buttons}>
        <button disabled={!history.length} onClick={() => { const old = history.at(-1)!; setHistory(h => h.slice(0, -1)); setGraph(old); setPreview(undefined); save(old); }}>Undo</button>
        <button disabled={!graph} onClick={() => download(false)}>Export draft</button>
        <button disabled={!report?.ready} onClick={() => download(true)}>Export release</button>
      </div>
      <label>Import routing JSON<input type="file" accept=".json,application/json" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { const imported = parseRoutingGraph(JSON.parse(await file.text())); commit(imported); setNodeId(""); setEdgeId(""); setMessage("Imported routing file. Review the validation report."); }
        catch (error) { setMessage(String(error)); }
        e.target.value = "";
      }} /></label>
      <h2>Validation</h2>
      <p>{attached.size}/{booths.length} booth access points · {report?.errors.length ?? 0} errors</p>
      {report?.ready && <p>Ready to export for release.</p>}
      <ul>{report?.errors.slice(0, 40).map((error, i) => <li key={i}>{error}</li>)}</ul>
      {!!report?.pending.length && <details><summary>Optional review notes ({report.pending.length})</summary><p>These notes do not block release export or walking directions.</p><ul>{report.pending.slice(0, 10).map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
      <Link href="/">Return to Main Floor</Link>
    </aside>
  </main>;
}
