import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import React, { act } from 'react';
import { selectFloorplanArea } from '../src/lib/floorplan-area.ts';

test('map surface supports keyboard pin placement and an independent noninteractive SVG route',async()=>{
  const require=createRequire(import.meta.url),rootPath=path.resolve('src');
  const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost'}),previous=new Map();
  const source=JSON.parse(readFileSync(new URL('../public/data/booths.json',import.meta.url)));
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true,fetch:async()=>({ok:true,json:async()=>source})})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const clicks=[],modes=[];let cancelled=0,onViewSettle;
  const fakeEngine={setPointSelection:value=>modes.push(value),screenToMap:(x,y)=>[x/2,y/2],getDisplayedPixelsPerUnit:()=>2,fitBounds(){},destroy(){}};
  const cache=new Map();
  function load(filename){
    if(cache.has(filename))return cache.get(filename).exports;
    const compiledModule={exports:{}};cache.set(filename,compiledModule);
    const code=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    const localRequire=name=>{
      if(name==='@/utils/d3ZoomEngine')return{createD3ZoomEngine:(_stage,_camera,options)=>{onViewSettle=options.onViewSettle;return fakeEngine;},fittedViewBox:bounds=>bounds};
      if(name.endsWith('.css'))return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
      if(name.startsWith('.')||name.startsWith('@/')){
        const base=name.startsWith('@/')?path.join(rootPath,name.slice(2)):path.resolve(path.dirname(filename),name);
        return load(existsSync(base)&&/\.tsx?$/.test(base)?base:existsSync(base+'.tsx')?base+'.tsx':base+'.ts');
      }
      return require(name);
    };
    new Function('require','module','exports',code)(localRequire,compiledModule,compiledModule.exports);return compiledModule.exports;
  }
  const Component=load(path.join(rootPath,'components/FloorPlan.tsx')).default;
  const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root'));
  const savedCompany=selectFloorplanArea(source,'main').companies[0].id;
  const props={pointSelection:true,onMapPoint:(point,scale)=>clicks.push({point,scale}),onCancelPlacement:()=>cancelled++,routePoints:[[10,20],[30,40]],savedCompanyIds:new Set([savedCompany])};
  try{
    await act(async()=>root.render(React.createElement(Component,props)));
    const stage=document.getElementById('floorplan-stage');assert.ok(stage);stage.getBoundingClientRect=()=>({width:600,height:400});
    assert.equal(document.activeElement,stage);assert.equal(modes.at(-1),true);
    await act(async()=>stage.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    await act(async()=>stage.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
    await act(async()=>stage.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
    assert.deepEqual(clicks,[{point:[156,106],scale:2}]);
    await act(async()=>stage.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(cancelled,1);
    const overlay=document.getElementById('walking-route');assert.equal(overlay.getAttribute('aria-hidden'),'true');assert.ok(overlay.classList.contains('labelViewport'));
    assert.equal(overlay.getAttribute('viewBox'),document.getElementById('viewport-matrix').getAttribute('viewBox'));
    assert.equal(overlay.querySelectorAll('polyline').length,2);
    assert.equal(overlay.querySelector('polyline').getAttribute('points'),'10,20 30,40');
    assert.equal(overlay.querySelector('polyline').getAttribute('vector-effect'),'non-scaling-stroke');
    assert.equal(document.querySelectorAll('#booth-labels .labels').length,0,'route does not depend on mounted booth labels');
    const savedMarker=document.querySelector('[data-company-marker]');
    const startMarker=overlay.querySelector('[data-route-marker="start"]'),endMarker=overlay.querySelector('[data-route-marker="end"]');
    assert.ok(savedMarker,'status marker exists before any label-view callback');
    assert.equal(savedMarker.getAttribute('r'),'4');assert.equal(savedMarker.getAttribute('vector-effect'),null);
    assert.equal(startMarker.getAttribute('r'),'7');assert.equal(endMarker.getAttribute('r'),'7');
    for(const level of [0,4,1]){
      await act(async()=>onViewSettle({scale:1+level,level,visibleIds:[]}));
      assert.equal(document.querySelector('[data-company-marker]'),savedMarker,'offscreen/zoom-tier updates retain the same status node');
      assert.equal(overlay.querySelector('[data-route-marker="start"]'),startMarker);
      assert.equal(overlay.querySelector('[data-route-marker="end"]'),endMarker);
    }
    await act(async()=>root.render(React.createElement(Component,{...props,pointSelection:false,visitedCompanyIds:new Set([savedCompany])})));
    assert.equal(modes.at(-1),false);assert.equal(document.querySelector('.placementCrosshair'),null);
    assert.equal(document.querySelector('[data-company-marker]'),savedMarker,'visiting updates the existing marker');
    assert.equal(savedMarker.classList.contains('visitedMarker'),true);
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
