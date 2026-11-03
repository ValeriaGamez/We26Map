// Geometry-only authoring aid. Every generated segment/access is UNREVIEWED.
// Automatic validation controls release; optional review flags remain honest.
import { readFileSync, writeFileSync } from 'node:fs';
import { selectFloorplanArea } from '../src/lib/floorplan-area.ts';
import { getBounds } from '../src/lib/floorplan-geometry.ts';
import { crossesBooth, emptyGraph, length, pointOf, projectToSegment, routableBooths, splitEdge, validateRoutingGraph } from '../src/lib/routing.ts';

const data = selectFloorplanArea(JSON.parse(readFileSync(new URL('../public/data/booths.json', import.meta.url))), 'main');
let graph = emptyGraph(data), count = 0;
const id = () => `draft-${++count}`;
const boxes = data.booths.map(b => ({ booth: b, bounds: getBounds(b.polygons) }));
const unique = values => [...new Set(values.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
const lanes = values => {
  const coordinates = unique(values);
  return [coordinates[0] - 6, ...coordinates.slice(1).flatMap((v, i) => v - coordinates[i] >= 4 ? [(v + coordinates[i]) / 2] : []), coordinates.at(-1) + 6];
};
const xs = lanes(boxes.flatMap(({bounds:b}) => [b.x, b.x + b.width]));
const ys = lanes(boxes.flatMap(({bounds:b}) => [b.y, b.y + b.height]));
const clear = (a, b) => !boxes.some(({booth,bounds:r}) => {
  if (Math.max(a[0], b[0]) <= r.x + 1e-5 || Math.min(a[0], b[0]) >= r.x + r.width - 1e-5 || Math.max(a[1], b[1]) <= r.y + 1e-5 || Math.min(a[1], b[1]) >= r.y + r.height - 1e-5) return false;
  return crossesBooth(a,b,booth);
});
const grid = new Map();
for (let x = 0; x < xs.length; x++) for (let y = 0; y < ys.length; y++) {
  const point = [xs[x], ys[y]];
  if (boxes.some(({bounds:b}) => point[0] > b.x - 1 && point[0] < b.x + b.width + 1 && point[1] > b.y - 1 && point[1] < b.y + b.height + 1)) continue;
  const node = {id:id(), x:point[0], y:point[1]}; graph.nodes.push(node); grid.set(`${x},${y}`,node);
  for (const key of [`${x-1},${y}`,`${x},${y-1}`]) {
    const neighbor = grid.get(key);
    if (neighbor && clear(point,pointOf(neighbor))) graph.edges.push({id:id(),from:node.id,to:neighbor.id,reviewed:false});
  }
}
// Keep the largest aisle component, dropping isolated geometric pockets.
const adjacency = new Map(graph.nodes.map(n=>[n.id,[]]));
for(const e of graph.edges){adjacency.get(e.from).push(e.to);adjacency.get(e.to).push(e.from);}
const visited = new Set(); let largest = new Set();
for(const node of graph.nodes){
  if(visited.has(node.id))continue;
  const component=new Set([node.id]),stack=[node.id];visited.add(node.id);
  while(stack.length)for(const next of adjacency.get(stack.pop()))if(!visited.has(next)){visited.add(next);component.add(next);stack.push(next);}
  if(component.size>largest.size)largest=component;
}
graph={...graph,nodes:graph.nodes.filter(n=>largest.has(n.id)),edges:graph.edges.filter(e=>largest.has(e.from)&&largest.has(e.to))};
// Collapse straight degree-two vertices; retain actual intersections/corners.
let changed=true;
while(changed){
  changed=false;
  for(const node of graph.nodes){
    const edges=graph.edges.filter(e=>e.from===node.id||e.to===node.id);
    if(edges.length!==2)continue;
    const others=edges.map(e=>graph.nodes.find(n=>n.id===(e.from===node.id?e.to:e.from)));
    if(Math.abs(length(pointOf(others[0]),pointOf(node))+length(pointOf(node),pointOf(others[1]))-length(pointOf(others[0]),pointOf(others[1])))>1e-5)continue;
    graph={...graph,nodes:graph.nodes.filter(n=>n.id!==node.id),edges:[...graph.edges.filter(e=>!edges.includes(e)),{id:id(),from:others[0].id,to:others[1].id,reviewed:false}]};changed=true;break;
  }
}
const missing=[];
for(const booth of routableBooths(data)){
  const bounds=getBounds(booth.polygons), nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  const accessCandidates=booth.polygons.flatMap(polygon=>polygon.map((a,i)=>{const b=polygon[(i+1)%polygon.length];return [(a[0]+b[0])/2,(a[1]+b[1])/2];}));
  let best=null;
  for(const access of accessCandidates)for(const edge of graph.edges){
    const a=nodes.get(edge.from),b=nodes.get(edge.to);if(a.boothId||b.boothId)continue;
    const projected=projectToSegment(access,pointOf(a),pointOf(b));
    if(projected.distance<.1||projected.distance>Math.max(bounds.width,bounds.height,40)||(best&&projected.distance>=best.distance))continue;
    if(clear(access,projected.point))best={...projected,access,edge};
  }
  if(!best){missing.push(booth.number);continue;}
  const split=splitEdge(graph,best.edge.id,best.point,id());graph=split.graph;
  const node={id:id(),x:best.access[0],y:best.access[1],boothId:booth.id,reviewed:false};
  graph.nodes.push(node);graph.edges.push({id:id(),from:split.nodeId,to:node.id,reviewed:false});
}
const report=validateRoutingGraph(graph,data);
const target=new URL('../public/data/routing-main.json',import.meta.url);
if(process.argv.includes('--write')){
  try { readFileSync(target); throw Error('Routing file exists. Export edits through the editor; the seed command will not overwrite it.'); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  writeFileSync(target,JSON.stringify(graph,null,2)+'\n');
}
console.log(JSON.stringify({nodes:graph.nodes.length,edges:graph.edges.length,attached:graph.nodes.filter(n=>n.boothId).length,missing,errors:report.errors.slice(0,15),errorCount:report.errors.length,pendingReviews:report.pending.length},null,2));
