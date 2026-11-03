import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const rootPath = path.resolve('src');
const rect = (x,y) => [[[x,y],[x+10,y],[x+10,y+10],[x,y+10]]];
const data = {
  source:{ lastSaved:'2026-11-01' },
  booths:[{ id:'a',number:'101',companyId:'one',polygons:rect(20,80),spaceType:'unclassified' },{ id:'b',number:'102',companyId:'one',polygons:rect(20,30),spaceType:'unclassified' },{ id:'c',number:'201',companyId:'two',polygons:rect(0,80),spaceType:'unclassified' }],
  companies:[{ id:'one',name:'First company with a long descriptive name',aliases:['Alpha'],boothIds:['a','b'],url:'https://careers.example.com/jobs' },{ id:'two',name:'Second company',aliases:['Beta'],boothIds:['c'],url:null }],
};

async function setup({phone=false,seed,blocked=false}={}) {
  const dom = new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost'});
  const previous=new Map();
  class Observer { observe(){} disconnect(){} }
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,ResizeObserver:Observer,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  dom.window.matchMedia = query => ({matches:query.includes('max-width')?phone:false,addEventListener(){},removeEventListener(){}});
  if(seed)dom.window.localStorage.setItem('we26.company-preferences.v1',seed);
  if(blocked)Object.defineProperty(dom.window,'localStorage',{get(){throw Error('Storage blocked')}});
  let mounts=0,mapProps;
  function MapStub(props){mapProps=props;const{onDataLoad}=props;React.useEffect(()=>{mounts++;onDataLoad(data)},[onDataLoad]);return React.createElement('div',{id:'map-instance'});}
  const cache=new Map();
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
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root'));
  await act(async()=>root.render(React.createElement(Component)));
  return{
    find:selector=>dom.window.document.querySelector(selector),
    all:selector=>[...dom.window.document.querySelectorAll(selector)],
    get mapProps(){return mapProps},get mounts(){return mounts},
    async click(node){assert.ok(node,'click target exists');await act(async()=>{node.focus();node.click()})},
    async type(node,text){await act(async()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set.call(node,text);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})},
    storage:()=>dom.window.localStorage.getItem('we26.company-preferences.v1'),
    async close(){await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
  };
}

test('company place card saves notes/status and Back returns to the previous tab without remounting the map',async()=>{
  const f=await setup();try{
    const map=f.find('#map-instance');await f.click(f.find('.result'));
    assert.equal(f.mapProps.focusRequest.boothId,'a');
    await f.click(f.find('.actions button:first-child'));
    await f.click(f.find('.actions button:last-child'));
    await f.type(f.find('#company-notes'),'Ada · follow up about robotics\nSend résumé');
    assert.ok(f.mapProps.savedCompanyIds.has('one'));assert.ok(f.mapProps.visitedCompanyIds.has('one'));
    const saved=JSON.parse(f.storage()).companies.one;assert.equal(saved.saved,true);assert.equal(saved.visited,true);assert.match(saved.notes,/Ada/);
    await f.click(f.find('.back'));await f.click(f.find('#company-tab-saved'));
    assert.equal(f.all('.result').length,1);await f.click(f.find('.result'));assert.match(f.find('.back').textContent,/Saved/);
    await f.click(f.find('.locations button:last-child'));assert.equal(f.mapProps.focusRequest.boothId,'b');
    await f.click(f.find('.back'));assert.equal(f.find('#company-tab-saved').getAttribute('aria-selected'),'true');
    assert.equal(f.find('#map-instance'),map);assert.equal(f.mounts,1);
  }finally{await f.close()}
});

test('selected company title opens its careers page while unlinked companies remain plain text',async()=>{
  const f=await setup();try{
    await f.click(f.find('.result'));
    const link=f.find('.placeCard h1 a');
    assert.equal(link.href,'https://careers.example.com/jobs');
    assert.equal(link.target,'_blank');
    assert.match(link.rel,/noopener/);assert.match(link.rel,/noreferrer/);
    assert.match(link.getAttribute('aria-label'),/careers.*new tab/);
    await f.click(f.find('.locations button:last-child'));
    assert.equal(f.find('.placeCard h1 a').href,'https://careers.example.com/jobs');
    await f.click(f.find('.back'));await f.click(f.all('.result')[1]);
    assert.equal(f.find('.placeCard h1 a'),null);assert.equal(f.find('.placeCard h1').textContent,'Second company');
  }finally{await f.close()}
});

test('saved Route is a coordinate-ordered checklist and visiting keeps checked rows in place',async()=>{
  const f=await setup();try{
    for(let index=0;index<2;index++){await f.click(f.all('.result')[index]);await f.click(f.find('.actions button:first-child'));await f.click(f.find('.back'))}
    await f.click(f.find('#company-tab-route'));
    assert.match(f.find('.result').textContent,/Second company/);
    assert.match(f.find('.routeCaption').textContent,/2 of 2 left/);
    await f.click(f.find('[role="checkbox"]'));assert.equal(f.find('[role="checkbox"]').getAttribute('aria-checked'),'true');
    assert.match(f.find('.routeCaption').textContent,/1 of 2 left/);assert.equal(f.all('.result').length,2);
  }finally{await f.close()}
});

test('search matches aliases and booth numbers; map selection and outside deselection update the card',async()=>{
  const f=await setup();try{
    await f.type(f.find('input[type="search"]'),'alpha');assert.equal(f.all('.result').length,1);assert.deepEqual([...f.mapProps.matchingBoothIds],['a','b']);
    await f.type(f.find('input[type="search"]'),'102');await f.click(f.find('.result'));assert.equal(f.mapProps.selectedBoothId,'b');
    await act(async()=>f.mapProps.onDeselectBooth());assert.equal(f.find('.placeCard'),null);
    await act(async()=>f.mapProps.onSelectBooth('c'));assert.match(f.find('.placeCard h1').textContent,/Second company/);
    assert.equal(f.mounts,1);
  }finally{await f.close()}
});

test('saved/visited/notes restore after reload and blocked storage falls back to session memory',async()=>{
  let seed;let f=await setup();try{
    await f.click(f.find('.result'));await f.click(f.find('.actions button:first-child'));await f.type(f.find('#company-notes'),'Recruiter note');seed=f.storage();
  }finally{await f.close()}
  f=await setup({seed});try{assert.ok(f.mapProps.savedCompanyIds.has('one'));await f.click(f.find('.result'));assert.equal(f.find('#company-notes').value,'Recruiter note')}finally{await f.close()}
  f=await setup({blocked:true});try{await f.click(f.find('.result'));await f.click(f.find('.actions button:first-child'));await f.type(f.find('#company-notes'),'Session note');assert.ok(f.mapProps.savedCompanyIds.has('one'));assert.equal(f.find('#company-notes').value,'Session note');assert.match(f.find('[role="status"]').textContent,/this session/)}finally{await f.close()}
});

test('phone sheet expands/collapses with an accessible handle while retaining the map instance',async()=>{
  const f=await setup({phone:true});try{
    const map=f.find('#map-instance'),handle=f.find('.sheetHandle');assert.equal(handle.getAttribute('aria-expanded'),'false');
    await f.click(handle);assert.equal(handle.getAttribute('aria-expanded'),'true');
    await f.click(f.find('.result'));assert.equal(handle.getAttribute('aria-expanded'),'false');
    await f.click(handle);assert.equal(handle.getAttribute('aria-expanded'),'true');
    assert.equal(f.find('#map-instance'),map);assert.equal(f.mounts,1);
  }finally{await f.close()}
});
