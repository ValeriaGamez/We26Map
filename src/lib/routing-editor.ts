import type { Point } from "./floorplan-types";
import { length, pointOf, projectToSegment, segmentIntersection, splitEdge } from "./routing.ts";
import type { RoutingGraph, RoutingNode } from "./routing.ts";

export function moveNode(graph: RoutingGraph, id: string, point: Point): RoutingGraph {
  return { ...graph, nodes: graph.nodes.map(n => n.id === id ? { ...n, x: point[0], y: point[1], reviewed: false } : n), edges: graph.edges.map(e => e.from === id || e.to === id ? { ...e, reviewed: false } : e) };
}
export function deleteNode(graph: RoutingGraph, id: string): RoutingGraph {
  return { ...graph, nodes: graph.nodes.filter(n => n.id !== id), edges: graph.edges.filter(e => e.from !== id && e.to !== id) };
}

/** Add a straight segment, splitting all intersections into shared nodes. */
export function connectAisles(graph: RoutingGraph, from: string, to: string, uniqueId: () => string): RoutingGraph {
  const a = graph.nodes.find(n => n.id === from), b = graph.nodes.find(n => n.id === to);
  if (!a || !b || a.boothId || b.boothId || length(pointOf(a), pointOf(b)) < 1e-6) throw Error("Choose two different aisle nodes.");
  if (graph.edges.some(e => (e.from === from && e.to === to) || (e.from === to && e.to === from))) throw Error("These nodes are already connected.");
  const added = { id: uniqueId(), from, to, reviewed: false };
  const all = [...graph.edges, added], nodes = [...graph.nodes], lookup = new Map(nodes.map(n => [n.id, n]));
  const cuts = new Map(all.map(e => [e.id, [e.from, e.to]]));
  for (const e of graph.edges) {
    const c = lookup.get(e.from)!, d = lookup.get(e.to)!;
    const hit = segmentIntersection(pointOf(a), pointOf(b), pointOf(c), pointOf(d));
    if (!hit) continue;
    let node = nodes.find(n => length(pointOf(n), hit) < 1e-6);
    if (node?.boothId) throw Error("An aisle cannot pass through a booth endpoint.");
    if (!node) { node = { id: uniqueId(), x: hit[0], y: hit[1] }; nodes.push(node); lookup.set(node.id, node); }
    cuts.get(e.id)!.push(node.id); cuts.get(added.id)!.push(node.id);
  }
  const edges = all.flatMap(e => {
    const start = pointOf(lookup.get(e.from)!), end = pointOf(lookup.get(e.to)!);
    const ids = [...new Set(cuts.get(e.id))].sort((x, y) => projectToSegment(pointOf(lookup.get(x)!), start, end).t - projectToSegment(pointOf(lookup.get(y)!), start, end).t);
    return ids.slice(1).map((id, i) => ({ ...e, id: ids.length === 2 ? e.id : uniqueId(), from: ids[i], to: id }));
  });
  return { ...graph, nodes, edges };
}

export function attachBooth(graph: RoutingGraph, boothId: string, access: Point, edgeId: string, uniqueId: () => string): RoutingGraph {
  const edge = graph.edges.find(e => e.id === edgeId);
  if (!edge) throw Error("Select an aisle segment first.");
  const a = graph.nodes.find(n => n.id === edge.from)!, b = graph.nodes.find(n => n.id === edge.to)!;
  if (a.boothId || b.boothId) throw Error("Attach booths to an aisle segment.");
  const cleaned = { ...graph, nodes: graph.nodes.filter(n => n.boothId !== boothId), edges: graph.edges.filter(e => !graph.nodes.some(n => n.boothId === boothId && (n.id === e.from || n.id === e.to))) };
  // A coincident aisle junction and booth access still need distinct node IDs.
  const split = splitEdge(cleaned, edgeId, access, uniqueId());
  const node: RoutingNode = { id: uniqueId(), x: access[0], y: access[1], boothId, reviewed: false };
  const junction = split.graph.nodes.find(n => n.id === split.nodeId)!;
  if (length(access, pointOf(junction)) < 1e-6) throw Error("Place the access on the booth boundary, away from the aisle centerline.");
  return { ...split.graph, nodes: [...split.graph.nodes, node], edges: [...split.graph.edges, { id: uniqueId(), from: split.nodeId, to: node.id, reviewed: false }] };
}
