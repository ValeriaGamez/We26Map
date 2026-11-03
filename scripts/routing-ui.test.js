import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import React, { act } from 'react';
import { geometryKey } from '../src/lib/routing.ts';

const require = createRequire(import.meta.url);
const rect = x => [[[x,0],[x+10,0],[x+10,10],[x,10]]];
const data = {area:'main',units:'ft',source:{lastSaved:'test'},booths:[
  {id:'a',number:'101',companyId:'one',status:'rented',spaceType:'unclassified',polygons:rect(40)},
  {id:'b',number:'102',companyId:'one',status:'rented',spaceType:'unclassified',polygons:rect(80)}
],companies:[{id:'one',name:'One company',aliases:[],boothIds:['a','b']}]};
const network = () => ({schemaVersion:1,area:'main',geometryKey:geometryKey(data),nodes:[
  {id:'left',x:0,y:20},{id:'middle',x:45,y:20},{id:'right',x:85,y:20},
  {id:'access-a',x:45,y:10,boothId:'a',reviewed:true},{id:'access-b',x:85,y:10,boothId:'b',reviewed:true}
],edges:[['left','middle'],['middle','right'],['middle','access-a'],['right','access-b']].map(([from,to])=>({id:`${from}-${to}`,from,to,reviewed:true}))});

async function setup({graph=network(),fetchError=false,area='main'}={}){
  const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost'}), previous=new Map();
  class Observer{observe(){} disconnect(){}}
  let requests=0,mapProps;
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,ResizeObserver:Observer,IS_REACT_ACT_ENVIRONMENT:true,fetch:async()=>{requests++;if(fetchError)throw Error('Network unavailable');return{ok:true,json:async()=>graph};}})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  function MapStub(props){mapProps=props;const {onDataLoad}=props;React.useEffect(()=>onDataLoad(data),[onDataLoad]);return React.createElement('div',{id:'map'});}
  const rootPath=path.resolve('src'),cache=new Map();
  function load(filename){
    if(cache.has(filename))return cache.get(filename).exports;
    const compiledModule={exports:{}};cache.set(filename,compiledModule);
    const code=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    const localRequire=name=>{
      if(name==='./FloorPlan')return{__esModule:true,default:MapStub};
      if(name==='next/link')return{__esModule:true,default:props=>React.createElement('a',props,props.children)};
      if(name.endsWith('.css'))return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
      if(name.startsWith('.')||name.startsWith('@/')){
        const base=name.startsWith('@/')?path.join(rootPath,name.slice(2)):path.resolve(path.dirname(filename),name);
        return load(existsSync(base)&&/\.tsx?$/.test(base)?base:existsSync(base+'.tsx')?base+'.tsx':base+'.ts');
      }
      return require(name);
    };
    new Function('require','module','exports',code)(localRequire,compiledModule,compiledModule.exports);return compiledModule.exports;
  }
  const Component=load(path.join(rootPath,'components/floor-map.tsx')).default;
  const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root'));
  await act(async()=>{root.render(React.createElement(Component,{area}));});
  return{
    get props(){return mapProps},get requests(){return requests},
    find:selector=>document.querySelector(selector),text:()=>document.body.textContent,
    button:label=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(label)),
    async click(button){assert.ok(button);await act(async()=>button.click());},
    async select(id){await act(async()=>mapProps.onSelectBooth(id));},
    async place(point,scale){await act(async()=>mapProps.onMapPoint(point,scale));},
    async close(){await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
  };
}

test('directions target the exact booth, snap the start, recalculate, move, fit, and clear without changing saves',async()=>{
  const f=await setup();
  try{
    await f.select('a');assert.equal(f.button('Directions here').disabled,false);
    await f.click(f.button('Save'));const saved=window.localStorage.getItem('we26.company-preferences.v1');
    await f.click(f.button('Directions here'));assert.equal(f.props.pointSelection,true);assert.match(f.text(),/Place your starting pin/);
    await f.place([10,33],2);assert.equal(f.props.pointSelection,true);assert.match(f.text(),/closer to a mapped aisle/);
    await f.place([10,32],2);assert.equal(f.props.pointSelection,false);assert.deepEqual(f.props.routePoints,[[10,20],[45,20],[45,10]]);
    assert.match(f.text(),/To booth 101.*45 ft/);
    const revision=f.props.routeFitRevision;await f.click(f.button('Fit route'));assert.ok(f.props.routeFitRevision>revision);
    await f.select('b');assert.deepEqual(f.props.routePoints.at(-1),[85,10]);assert.match(f.text(),/To booth 102.*85 ft/);
    await f.click(f.button('Move start'));assert.equal(f.props.pointSelection,true);
    await act(async()=>f.props.onCancelPlacement());assert.equal(f.props.pointSelection,false);assert.ok(f.props.routePoints);
    await f.click(f.button('Clear route'));assert.equal(f.props.routePoints,undefined);
    assert.equal(window.localStorage.getItem('we26.company-preferences.v1'),saved);assert.equal(f.requests,1);
  }finally{await f.close();}
});
test('cancelling the first placement leaves no active route',async()=>{
  const f=await setup();try{await f.select('a');await f.click(f.button('Directions here'));await act(async()=>f.props.onCancelPlacement());assert.equal(f.props.pointSelection,false);assert.equal(f.button('Clear route'),undefined);}finally{await f.close();}
});

test('users can pin inside a booth, retain that start across destinations, and move back onto an aisle',async()=>{
  const f=await setup();try{
    await f.select('b');await f.click(f.button('Directions here'));
    assert.match(f.text(),/inside a booth or near an aisle/);
    await f.place([45,5],100);
    assert.equal(f.props.pointSelection,false);
    assert.deepEqual(f.props.routePoints,[[45,5],[45,10],[45,20],[85,20],[85,10]]);
    assert.match(f.text(),/65 ft/);
    await f.select('a');assert.deepEqual(f.props.routePoints,[[45,5],[45,10]]);assert.match(f.text(),/5 ft/);
    await f.click(f.button('Move start'));await f.place([10,20],2);
    assert.deepEqual(f.props.routePoints,[[10,20],[45,20],[45,10]]);
  }finally{await f.close();}
});
test('an automatically valid network enables directions without individual reviews',async()=>{
  const graph=network();graph.edges.forEach(e=>e.reviewed=false);graph.nodes.filter(n=>n.boothId).forEach(n=>n.reviewed=false);
  const f=await setup({graph});
  try{await f.select('a');assert.equal(f.button('Directions here').disabled,false);await f.click(f.button('Directions here'));await f.place([10,20],2);assert.deepEqual(f.props.routePoints,[[10,20],[45,20],[45,10]]);}finally{await f.close();}
});
test('stale, invalid, and failed networks disable directions but preserve browsing',async()=>{
  for(const kind of ['stale','invalid','failed']){
    const graph=network();if(kind==='stale')graph.geometryKey='old';if(kind==='invalid')graph.edges[0].to='missing';
    const f=await setup({graph,fetchError:kind==='failed'});
    try{await f.select('a');assert.equal(f.button('Directions here').disabled,true);assert.ok(f.button('Save'));assert.ok(f.find('#company-notes'));assert.equal(f.props.routePoints,undefined);}finally{await f.close();}
  }
});
test('Interviews do not fetch a Main Floor network and explain unavailability',async()=>{
  const f=await setup({area:'interview'});try{await f.select('a');assert.equal(f.requests,0);assert.equal(f.button('Directions here').disabled,true);assert.match(f.text(),/Interviews map/);}finally{await f.close();}
});
