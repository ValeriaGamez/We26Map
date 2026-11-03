import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectFloorplanArea } from '../src/lib/floorplan-area.ts';
import { attachBooth, connectAisles, deleteNode, moveNode } from '../src/lib/routing-editor.ts';
import { crossesBooth, dijkstra, geometryKey, parseRoutingGraph, projectToSegment, routeFromPin, snapToAisle, splitEdge, startFromPoint, validateRoutingGraph } from '../src/lib/routing.ts';

const node = (id,x,y,boothId) => ({id,x,y,...(boothId?{boothId,reviewed:true}:{})});
const edge = (from,to) => ({id:`${from}-${to}`,from,to,reviewed:true});
const graph = (nodes,edges) => ({schemaVersion:1,area:'main',geometryKey:'test',nodes,edges});
const rectangle = (x,y,width=10,height=10) => [[[x,y],[x+width,y],[x+width,y+height],[x,y+height]]];
const booth = {id:'booth',number:'101',companyId:'company',status:'rented',spaceType:'unclassified',polygons:rectangle(20,0)};
const data = {booths:[booth],companies:[],area:'main'};
const fixture = () => ({...graph([node('a',0,15),node('b',25,15),node('access',25,10,'booth')],[edge('a','b'),edge('b','access')]),geometryKey:geometryKey(data)});

test('Dijkstra chooses total geometric distance, handles ties, endpoints, reverse travel, and disconnected graphs',()=>{
  const g=graph([node('a',0,0),node('b',3,0),node('c',3,4),node('d',0,20),node('isolated',100,100)],[edge('a','b'),edge('b','c'),edge('a','d'),edge('d','c')]);
  assert.deepEqual(dijkstra(g,'a','c').route.nodeIds,['a','b','c']);
  assert.equal(dijkstra(g,'a','c').route.distance,7);
  assert.equal(dijkstra(g,'c','a').route.distance,7);
  assert.deepEqual(dijkstra(g,'a','a').route,{points:[[0,0]],nodeIds:['a'],distance:0});
  assert.equal(dijkstra(g,'a','isolated').ok,false);
  assert.equal(dijkstra(g,'missing','c').ok,false);
  const tied=graph([node('a',0,0),node('b',1,1),node('c',1,-1),node('d',2,0)],[edge('a','b'),edge('a','c'),edge('b','d'),edge('c','d')]);
  assert.equal(dijkstra(tied,'a','d').route.distance,2*Math.SQRT2);
});
test('booth nodes cannot act as intermediate shortcuts',()=>{
  const g=graph([node('a',0,0),node('b',2,0),node('shop',1,0,'shop')],[edge('a','shop'),edge('shop','b')]);
  assert.equal(dijkstra(g,'a','b').ok,false);
  assert.equal(dijkstra(g,'shop','b').ok,true);
});
test('invalid networks reject duplicate IDs, zero or infinite distances, missing nodes and malformed review flags',()=>{
  const good=fixture();
  for(const mutate of [g=>g.nodes.push(g.nodes[0]),g=>g.nodes[0].x=NaN,g=>g.edges[0].to='unknown',g=>g.nodes[1].x=0,g=>g.edges[0].reviewed='yes',g=>g.edges.push({...g.edges[0],id:'duplicate'}),g=>{g.nodes[0].x=-1e308;g.nodes[1].x=1e308;}]){
    const bad=structuredClone(good);mutate(bad);assert.throws(()=>parseRoutingGraph(bad));assert.equal(dijkstra(bad,'a','b').ok,false);
  }
});
test('segment projection clamps to endpoints and snapping uses displayed CSS pixel scale',()=>{
  assert.deepEqual(projectToSegment([-10,10],[0,0],[20,0]).point,[0,0]);
  assert.deepEqual(projectToSegment([30,10],[0,0],[20,0]).point,[20,0]);
  const g=fixture();
  for(const scale of [.5,1,2,8]){
    assert.ok(snapToAisle(g,[10,15+24/scale],scale));
    assert.equal(snapToAisle(g,[10,15+24.1/scale],scale),null);
  }
  assert.equal(snapToAisle(g,[25,11],100),null,'booth connectors are not pin-placement aisles');
  assert.equal(snapToAisle(g,[0,15],0),null);
});
test('temporary start splits an edge, reuses endpoints, and leaves the authored graph unchanged',()=>{
  const g=fixture(),original=JSON.stringify(g),snap=snapToAisle(g,[10,16],1);
  for(let i=0;i<3;i++){
    const result=routeFromPin(g,snap,'booth');assert.equal(result.ok,true);assert.equal(result.route.distance,20);assert.deepEqual(result.route.points[0],[10,15]);
  }
  assert.equal(JSON.stringify(g),original);
  assert.equal(splitEdge(g,'a-b',[0,15],'temp').nodeId,'a');
  assert.equal(splitEdge(g,'a-b',[25,15],'temp').nodeId,'b');
  assert.equal(routeFromPin(g,{...snap,edgeId:'missing'},'booth').ok,false);
  assert.equal(routeFromPin(g,snap,'unknown').ok,false);
});

test('booth starts preserve the exact pin, use their access, include the interior distance, and never mutate the network',()=>{
  const other={...booth,id:'other',polygons:rectangle(40,0)};
  const g=graph([node('origin',25,10,'booth'),node('a',25,15),node('b',45,15),node('destination',45,10,'other')],[edge('origin','a'),edge('a','b'),edge('b','destination')]);
  const original=JSON.stringify(g),booths=[booth,other];
  const picked=startFromPoint(g,booths,[25,5],100);
  assert.deepEqual(picked,{ok:true,start:{boothId:'booth',point:[25,5]}});
  const result=routeFromPin(g,picked.start,'other',booths);
  assert.equal(result.ok,true);assert.deepEqual(result.route.points,[[25,5],[25,10],[25,15],[45,15],[45,10]]);
  assert.equal(result.route.distance,35);assert.equal(result.route.points.length,result.route.nodeIds.length);
  assert.equal(routeFromPin(g,picked.start,'booth',booths).route.distance,5);
  const atAccess=routeFromPin(g,{boothId:'booth',point:[25,10]},'booth',booths);
  assert.equal(atAccess.route.distance,0);assert.deepEqual(atAccess.route.points,[[25,10]]);
  assert.equal(JSON.stringify(g),original);
});

test('pin placement prioritizes booth boundaries and rejects unmapped booths instead of snapping across them',()=>{
  const g=fixture(),unmapped={...booth,id:'unmapped',polygons:rectangle(0,0)};
  assert.equal(startFromPoint(g,[booth],[25,10],1).start.boothId,'booth');
  assert.equal(startFromPoint(g,[booth,unmapped],[5,9],1).ok,false);
  assert.equal(startFromPoint(g,[booth],[NaN,5],1).ok,false);
  const aisle=startFromPoint(g,[booth],[10,16],1);assert.equal(aisle.ok,true);assert.equal(aisle.start.edgeId,'a-b');
  assert.equal(routeFromPin(g,{boothId:'booth',point:[100,100]},'booth',[booth]).ok,false);
});

test('inside-booth paths follow concave corners and reject disconnected parts and overlapping obstacles',()=>{
  const concave={...booth,polygons:[[[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]]]};
  const other={...booth,id:'other',polygons:rectangle(20,5)};
  const g=graph([node('origin',10,1,'booth'),node('a',15,1),node('b',15,10),node('destination',20,10,'other')],[edge('origin','a'),edge('a','b'),edge('b','destination')]);
  const start={boothId:'booth',point:[1,9]};
  const route=routeFromPin(g,start,'other',[concave,other]);
  assert.equal(route.ok,true);assert.deepEqual(route.route.points.slice(0,3),[[1,9],[3,3],[10,1]]);
  assert.ok(Math.abs(route.route.distance-(Math.sqrt(40)+Math.sqrt(53)+19))<1e-8);
  const multipart={...concave,polygons:[...concave.polygons,...rectangle(-20,0)]};
  assert.equal(routeFromPin(g,{boothId:'booth',point:[-15,5]},'other',[multipart,other]).ok,false);
  const blocker={...booth,id:'blocker',polygons:rectangle(-1,4,5,2)};
  assert.equal(routeFromPin(g,start,'other',[concave,other,blocker]).ok,false);
});
test('obstacle checks detect interior crossings including concave polygons but allow boundary access',()=>{
  assert.equal(crossesBooth([25,15],[25,10],booth),false);
  assert.equal(crossesBooth([0,5],[40,5],booth),true);
  assert.equal(crossesBooth([20,0],[30,0],booth),false);
  const concave={...booth,polygons:[[[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]]]};
  assert.equal(crossesBooth([4,5],[9,5],concave),false);
  assert.equal(crossesBooth([-1,5],[9,5],concave),true);
});
test('release validation enforces automatic checks while human reviews remain optional',()=>{
  const g=fixture();assert.equal(validateRoutingGraph(g,data).ready,true);
  const pending=structuredClone(g);pending.edges[0].reviewed=false;
  assert.equal(validateRoutingGraph(pending,data).ready,true);assert.equal(validateRoutingGraph(pending,data).pending.length,1);
  const stale={...g,geometryKey:'old'};assert.match(validateRoutingGraph(stale,data).errors.join(' '),/does not match/);
  const missing={...g,nodes:g.nodes.filter(n=>!n.boothId),edges:[g.edges[0]]};assert.match(validateRoutingGraph(missing,data).errors.join(' '),/Missing access/);
  const invalid=moveNode(g,'access',[25,5]);assert.match(validateRoutingGraph(invalid,data).errors.join(' '),/boundary|crosses/);
  const disconnected={...g,nodes:[...g.nodes,node('lost',100,100)]};assert.match(validateRoutingGraph(disconnected,data).errors.join(' '),/connected/);
  const blocked={...g,nodes:[...g.nodes,node('x',0,5),node('y',40,5)],edges:[...g.edges,edge('x','y')]};assert.match(validateRoutingGraph(blocked,data).errors.join(' '),/crosses booth/);
});
test('editor splits crossings into a shared junction and invalidates moved segments',()=>{
  let i=0;const id=()=>`n${++i}`;
  const g=graph([node('a',0,5),node('b',10,5),node('c',5,0),node('d',5,10)],[edge('a','b')]);
  const connected=connectAisles(g,'c','d',id);
  assert.equal(connected.nodes.length,5);assert.equal(connected.edges.length,4);
  assert.equal(dijkstra(connected,'a','d').route.distance,10);
  assert.equal(moveNode(connected,'a',[0,6]).edges.find(e=>e.from==='a'||e.to==='a').reviewed,false);
  const removed=deleteNode(connected,'a');assert.ok(!removed.edges.some(e=>e.from==='a'||e.to==='a'));
});
test('booth attachment splits an aisle and creates an unreviewed leaf; unsplit crossings are rejected',()=>{
  let i=0;const base={...fixture(),nodes:fixture().nodes.filter(n=>!n.boothId),edges:[edge('a','b')]};
  const attached=attachBooth(base,'booth',[25,10],'a-b',()=>`new${++i}`);
  const access=attached.nodes.find(n=>n.boothId);assert.equal(access.reviewed,false);
  assert.equal(attached.edges.filter(e=>e.from===access.id||e.to===access.id).length,1);
  const crossing={...fixture(),nodes:[...fixture().nodes,node('c',10,0),node('d',10,30)],edges:[...fixture().edges,edge('c','d')]};
  assert.match(validateRoutingGraph(crossing,data).errors.join(' '),/Split crossing/);
});
test('checked-in network covers every occupied Main Floor booth and passes automatic release checks',()=>{
  const source=JSON.parse(readFileSync(new URL('../public/data/booths.json',import.meta.url)));
  const main=selectFloorplanArea(source,'main');
  const g=parseRoutingGraph(JSON.parse(readFileSync(new URL('../public/data/routing-main.json',import.meta.url))));
  const report=validateRoutingGraph(g,main);
  assert.deepEqual(report.errors,[]);assert.equal(report.ready,true);
  assert.equal(g.nodes.filter(n=>n.boothId).length,main.booths.filter(b=>b.companyId&&b.status!=='available'&&b.spaceType!=='queue').length);
});
