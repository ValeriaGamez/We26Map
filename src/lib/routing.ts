import type { Booth, FloorplanData, Point } from "./floorplan-types";
import { insidePolygon } from "./floorplan-area.ts";

export type RoutingNode = { id: string; x: number; y: number; boothId?: string; reviewed?: boolean };
export type RoutingEdge = { id: string; from: string; to: string; reviewed: boolean };
export type RoutingGraph = { schemaVersion: 1; area: "main"; geometryKey: string; nodes: RoutingNode[]; edges: RoutingEdge[] };
export type Snap = { edgeId: string; point: Point; t: number; distance: number };
export type BoothStart = { boothId: string; point: Point };
export type RoutingStart = Snap | BoothStart;
export type WalkingRoute = { points: Point[]; nodeIds: string[]; distance: number };
export type RouteResult = { ok: true; route: WalkingRoute } | { ok: false; reason: string };
const EPS = 1e-6;
export const pointOf = (node: RoutingNode): Point => [node.x, node.y];
export const length = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const routableBooths = (data: FloorplanData) => data.booths.filter(b => b.companyId && b.status !== "available" && b.spaceType !== "queue");

/** Includes occupancy as well as geometry so stale coverage cannot be published. */
export function geometryKey(data: FloorplanData) {
  const source = JSON.stringify(data.booths.map(b => [b.id, b.companyId, b.status, b.spaceType, b.polygons]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `main-${(hash >>> 0).toString(16)}`;
}
export const emptyGraph = (data: FloorplanData): RoutingGraph => ({ schemaVersion: 1, area: "main", geometryKey: geometryKey(data), nodes: [], edges: [] });

export function parseRoutingGraph(value: unknown): RoutingGraph {
  if (!value || typeof value !== "object") throw Error("Invalid routing file.");
  const g = value as RoutingGraph;
  if (g.schemaVersion !== 1 || g.area !== "main" || typeof g.geometryKey !== "string" || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw Error("Unsupported routing file.");
  const ids = new Set<string>(), edges = new Set<string>(), pairs = new Set<string>();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string" || !n.id || ids.has(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y) || (n.boothId !== undefined && (typeof n.boothId !== "string" || !n.boothId)) || (n.reviewed !== undefined && typeof n.reviewed !== "boolean")) throw Error("Invalid or duplicate routing node.");
    ids.add(n.id);
  }
  const nodes = new Map(g.nodes.map(n => [n.id, n]));
  for (const e of g.edges) {
    const pair = [e?.from, e?.to].sort().join("|");
    if (!e || typeof e.id !== "string" || !e.id || edges.has(e.id) || pairs.has(pair) || !ids.has(e.from) || !ids.has(e.to) || typeof e.reviewed !== "boolean") throw Error("Invalid or duplicate routing connection.");
    const distance = length(pointOf(nodes.get(e.from)!), pointOf(nodes.get(e.to)!));
    if (!Number.isFinite(distance) || distance <= EPS) throw Error("Invalid or zero-length routing connection.");
    edges.add(e.id); pairs.add(pair);
  }
  return g;
}

export function projectToSegment(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dy = b[1] - a[1], squared = dx * dx + dy * dy;
  const t = squared ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared)) : 0;
  const point: Point = [a[0] + t * dx, a[1] + t * dy];
  return { point, t, distance: length(p, point) };
}

export function snapToAisle(graph: RoutingGraph, point: Point, pixelsPerUnit: number, maxPixels = 24): Snap | null {
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0 || !point.every(Number.isFinite)) return null;
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  let best: Snap | null = null;
  for (const e of graph.edges) {
    const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
    if (a.boothId || b.boothId) continue;
    const projection = projectToSegment(point, pointOf(a), pointOf(b));
    if ((!best || projection.distance < best.distance) && projection.distance * pixelsPerUnit <= maxPixels + EPS) best = { ...projection, edgeId: e.id };
  }
  return best;
}

/** Booth hits take precedence over nearby aisles, preserving the exact pin. */
export function startFromPoint(graph: RoutingGraph, booths: Booth[], point: Point, pixelsPerUnit: number): { ok: true; start: RoutingStart } | { ok: false; reason: string } {
  if (!point.every(Number.isFinite) || !Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) return { ok: false, reason: "Choose a booth or tap near a mapped aisle." };
  const booth = booths.find(b => b.polygons.some(polygon => insidePolygon(point, polygon)));
  if (booth) {
    if (!graph.nodes.some(n => n.boothId === booth.id)) return { ok: false, reason: "This booth has no mapped aisle access. Choose another booth or tap near an aisle." };
    return { ok: true, start: { boothId: booth.id, point: [...point] } };
  }
  const snap = snapToAisle(graph, point, pixelsPerUnit);
  return snap ? { ok: true, start: snap } : { ok: false, reason: "Tap inside a mapped booth or closer to a mapped aisle (within 24 pixels)." };
}

class MinHeap {
  private items: { id: string; distance: number }[] = [];
  push(item: { id: string; distance: number }) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].distance <= item.distance) break;
      this.items[i] = this.items[parent]; i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (!this.items.length || !last) return first;
    let i = 0;
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].distance < this.items[child].distance) child++;
      if (last.distance <= this.items[child].distance) break;
      this.items[i] = this.items[child]; i = child;
    }
    this.items[i] = last;
    return first;
  }
}

export function dijkstra(graph: RoutingGraph, startId: string, endId: string): RouteResult {
  try { parseRoutingGraph(graph); } catch { return { ok: false, reason: "Invalid walking network." }; }
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  if (!nodes.has(startId) || !nodes.has(endId)) return { ok: false, reason: "This location is not mapped." };
  const adjacency = new Map(graph.nodes.map(n => [n.id, [] as { id: string; distance: number }[]]));
  for (const e of graph.edges) {
    const distance = length(pointOf(nodes.get(e.from)!), pointOf(nodes.get(e.to)!));
    adjacency.get(e.from)!.push({ id: e.to, distance }); adjacency.get(e.to)!.push({ id: e.from, distance });
  }
  const distances = new Map([[startId, 0]]), previous = new Map<string, string>(), heap = new MinHeap();
  heap.push({ id: startId, distance: 0 });
  for (let current = heap.pop(); current; current = heap.pop()) {
    if (current.distance !== distances.get(current.id)) continue;
    if (current.id === endId) {
      const nodeIds = [endId];
      while (nodeIds[0] !== startId) nodeIds.unshift(previous.get(nodeIds[0])!);
      return { ok: true, route: { nodeIds, points: nodeIds.map(id => pointOf(nodes.get(id)!)), distance: current.distance } };
    }
    // Booths may be origins/destinations, never intermediate shortcuts.
    if (nodes.get(current.id)!.boothId && current.id !== startId) continue;
    for (const next of adjacency.get(current.id)!) {
      const candidate = current.distance + next.distance;
      if (candidate < (distances.get(next.id) ?? Infinity)) {
        distances.set(next.id, candidate); previous.set(next.id, current.id); heap.push({ id: next.id, distance: candidate });
      }
    }
  }
  return { ok: false, reason: "No connected walking route to this booth." };
}

/** Splits only a copy; repeated directions never mutate the authored network. */
export function splitEdge(graph: RoutingGraph, edgeId: string, point: Point, id: string): { graph: RoutingGraph; nodeId: string } {
  if (graph.nodes.some(n => n.id === id)) throw Error("Node ID already exists.");
  const edge = graph.edges.find(e => e.id === edgeId);
  if (!edge) throw Error("Aisle connection no longer exists.");
  const a = graph.nodes.find(n => n.id === edge.from)!, b = graph.nodes.find(n => n.id === edge.to)!;
  const projection = projectToSegment(point, pointOf(a), pointOf(b));
  if (length(projection.point, pointOf(a)) <= EPS) return { graph, nodeId: a.id };
  if (length(projection.point, pointOf(b)) <= EPS) return { graph, nodeId: b.id };
  return { nodeId: id, graph: { ...graph, nodes: [...graph.nodes, { id, x: projection.point[0], y: projection.point[1] }], edges: [...graph.edges.filter(e => e.id !== edgeId), { id: `${id}:a`, from: a.id, to: id, reviewed: edge.reviewed }, { id: `${id}:b`, from: id, to: b.id, reviewed: edge.reviewed }] } };
}

export function routeFromPin(graph: RoutingGraph, snap: RoutingStart, boothId: string, booths: Booth[] = []): RouteResult {
  try { parseRoutingGraph(graph); } catch { return { ok: false, reason: "Invalid walking network." }; }
  const destination = graph.nodes.find(n => n.boothId === boothId);
  if (!destination) return { ok: false, reason: "Directions are not available for this booth." };
  if ("boothId" in snap) {
    const origin = graph.nodes.find(n => n.boothId === snap.boothId), booth = booths.find(b => b.id === snap.boothId);
    if (!origin || !booth || !snap.point.every(Number.isFinite)) return { ok: false, reason: "This starting booth has no mapped aisle access." };
    // Route inside the starting booth only, then leave via its existing access.
    // Visibility edges around polygon corners also handle nonrectangular booths.
    const polygon = booth.polygons.find(p => insidePolygon(snap.point, p) && insidePolygon(pointOf(origin), p));
    if (!polygon) return { ok: false, reason: "This part of the booth is not connected to its mapped access point. Choose another starting point." };
    const positions: Point[] = [pointOf(origin)];
    for (const p of [snap.point, ...polygon]) if (!positions.some(q => length(p, q) <= EPS)) positions.push(p);
    let prefix = "__booth-start";
    while (graph.nodes.some(n => n.id.startsWith(prefix))) prefix += "_";
    const localNodes = positions.map((p, i) => ({ id: i === 0 ? origin.id : `${prefix}-${i}`, x: p[0], y: p[1] }));
    const localEdges: RoutingEdge[] = [];
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i], b = positions[j];
      if (!segmentInPolygon(a, b, polygon) || booths.some(other => other.id !== booth.id && crossesBooth(a, b, other))) continue;
      localEdges.push({ id: `${prefix}-edge-${i}-${j}`, from: localNodes[i].id, to: localNodes[j].id, reviewed: false });
    }
    const pinIndex = positions.findIndex(p => length(p, snap.point) <= EPS);
    const inside = dijkstra({ ...graph, nodes: localNodes, edges: localEdges }, localNodes[pinIndex].id, origin.id);
    if (!inside.ok) return { ok: false, reason: "No clear connection from this pin to the booth access. Choose another starting point." };
    const walking = dijkstra(graph, origin.id, destination.id);
    if (!walking.ok) return walking;
    return { ok: true, route: {
      points: [...inside.route.points.slice(0, -1), ...walking.route.points],
      nodeIds: [...inside.route.nodeIds.slice(0, -1), ...walking.route.nodeIds],
      distance: inside.route.distance + walking.route.distance,
    } };
  }
  const e = graph.edges.find(e => e.id === snap.edgeId);
  if (!e || !snap.point.every(Number.isFinite)) return { ok: false, reason: "Place your starting pin again." };
  const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to);
  if (!a || !b || a.boothId || b.boothId || projectToSegment(snap.point, pointOf(a), pointOf(b)).distance > EPS) return { ok: false, reason: "Place your starting pin on an aisle." };
  let id = "__start";
  while (graph.nodes.some(n => n.id === id)) id += "_";
  const temporary = splitEdge(graph, e.id, snap.point, id);
  return dijkstra(temporary.graph, temporary.nodeId, destination.id);
}

function cross(a: Point, b: Point, c: Point) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function segmentInPolygon(a: Point, b: Point, polygon: Point[]) {
  const cuts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const hit = segmentIntersection(a, b, polygon[i], polygon[(i + 1) % polygon.length]);
    if (hit) cuts.push(projectToSegment(hit, a, b).t);
  }
  cuts.sort((a, b) => a - b);
  return cuts.slice(1).every((t, i) => {
    const mid = (t + cuts[i]) / 2;
    return insidePolygon([a[0] + mid * (b[0] - a[0]), a[1] + mid * (b[1] - a[1])], polygon);
  });
}
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(denominator) < EPS) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] : null;
}
function strictlyInside(p: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (Math.abs(cross(a, b, p)) < EPS && projectToSegment(p, a, b).distance < EPS) return false;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function crossesBooth(a: Point, b: Point, booth: Booth) {
  return booth.polygons.some(polygon => {
    const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
    if (Math.max(a[0], b[0]) <= Math.min(...xs) + EPS || Math.min(a[0], b[0]) >= Math.max(...xs) - EPS || Math.max(a[1], b[1]) <= Math.min(...ys) + EPS || Math.min(a[1], b[1]) >= Math.max(...ys) - EPS) return false;
    const cuts = [0, 1];
    for (let i = 0; i < polygon.length; i++) {
      const hit = segmentIntersection(a, b, polygon[i], polygon[(i + 1) % polygon.length]);
      if (hit) cuts.push(projectToSegment(hit, a, b).t);
    }
    cuts.sort((a, b) => a - b);
    return cuts.slice(1).some((t, i) => {
      const mid = (t + cuts[i]) / 2;
      return strictlyInside([a[0] + mid * (b[0] - a[0]), a[1] + mid * (b[1] - a[1])], polygon);
    });
  });
}

export function validateRoutingGraph(graph: RoutingGraph, data: FloorplanData) {
  const errors: string[] = [], pending: string[] = [];
  try { parseRoutingGraph(graph); } catch (e) { return { errors: [String(e)], pending, ready: false }; }
  if (graph.geometryKey !== geometryKey(data)) errors.push("Routing file does not match this floor-plan geometry or occupancy.");
  const nodes = new Map(graph.nodes.map(n => [n.id, n])), degree = new Map(graph.nodes.map(n => [n.id, 0]));
  const supported = new Map(routableBooths(data).map(b => [b.id, b]));
  const attached = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.boothId) continue;
    const booth = supported.get(n.boothId);
    if (!booth || attached.has(n.boothId)) errors.push(`Unknown, unsupported, or duplicate booth access: ${n.boothId}.`);
    attached.add(n.boothId);
    if (booth && !booth.polygons.some(p => p.some((a, i) => projectToSegment(pointOf(n), a, p[(i + 1) % p.length]).distance < 0.05))) errors.push(`Access for ${n.boothId} must lie on its booth boundary.`);
    if (!n.reviewed) pending.push(`Check aisle-facing access for ${n.boothId}.`);
  }
  for (const b of supported.values()) if (!attached.has(b.id)) errors.push(`Missing access for booth ${b.number}.`);
  for (const e of graph.edges) {
    const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
    degree.set(a.id, degree.get(a.id)! + 1); degree.set(b.id, degree.get(b.id)! + 1);
    if (a.boothId && b.boothId) errors.push(`Connection ${e.id} joins two booth endpoints.`);
    if (!e.reviewed) pending.push(`Check walking segment ${e.id} against walls and restricted space.`);
    for (const booth of data.booths) if (crossesBooth(pointOf(a), pointOf(b), booth)) { errors.push(`Connection ${e.id} crosses booth ${booth.number}.`); break; }
  }
  for (const n of graph.nodes) if (degree.get(n.id) === 0 || (n.boothId && degree.get(n.id) !== 1)) errors.push(`Node ${n.id} must ${n.boothId ? "have exactly one aisle connection" : "be connected"}.`);
  // Reject unsplit intersections and collinear overlaps; a visual crossing alone
  // does not create graph connectivity.
  for (let i = 0; i < graph.edges.length; i++) for (let j = i + 1; j < graph.edges.length; j++) {
    const e = graph.edges[i], f = graph.edges[j];
    const a = pointOf(nodes.get(e.from)!), b = pointOf(nodes.get(e.to)!), c = pointOf(nodes.get(f.from)!), d = pointOf(nodes.get(f.to)!);
    const shared = e.from === f.from || e.from === f.to || e.to === f.from || e.to === f.to;
    const hit = segmentIntersection(a, b, c, d);
    const overlap = [c, d].some(p => { const s = projectToSegment(p, a, b); return s.distance < EPS && s.t > EPS && s.t < 1 - EPS; }) || [a, b].some(p => { const s = projectToSegment(p, c, d); return s.distance < EPS && s.t > EPS && s.t < 1 - EPS; });
    if ((hit && !shared) || (!hit && overlap)) errors.push(`Split crossing/overlap between ${e.id} and ${f.id}.`);
  }
  const first = graph.nodes.find(n => !n.boothId);
  const seen = new Set(first ? [first.id] : []), stack = first ? [first.id] : [];
  const adjacency = new Map(graph.nodes.map(n => [n.id, [] as string[]]));
  for (const e of graph.edges) { adjacency.get(e.from)!.push(e.to); adjacency.get(e.to)!.push(e.from); }
  while (stack.length) for (const id of adjacency.get(stack.pop()!)!) if (!seen.has(id)) { seen.add(id); stack.push(id); }
  if (!first || seen.size !== graph.nodes.length) errors.push("All aisle and booth nodes must belong to one connected network.");
  // Review flags record optional human checks. Release readiness is determined
  // by the automatic geometry, coverage, and connectivity checks above.
  return { errors, pending, ready: !errors.length };
}
