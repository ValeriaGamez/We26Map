import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createD3ZoomEngine, fittedViewBox } from '../src/utils/d3ZoomEngine.ts';

function setup(width=900,height=600){
  const dom=new JSDOM('<div id="stage"><div id="camera"><div id="fit"><svg><rect data-booth-id="booth" x="20" y="30" width="10" height="10" /></svg></div></div></div>',{pretendToBeVisual:true});
  const win=dom.window,stage=win.document.getElementById('stage'),camera=win.document.getElementById('camera'),fit=win.document.getElementById('fit');
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  let size={width,height};stage.getBoundingClientRect=()=>({left:40,top:70,...size,right:40+size.width,bottom:70+size.height});
  const frames=new Map();let frameId=0,time=0;
  win.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};win.cancelAnimationFrame=id=>frames.delete(id);
  const points=[],selected=[],bounds={x:-50,y:20,width:200,height:100};
  const engine=createD3ZoomEngine(stage,camera,{bounds,fit,booths:stage.querySelector('svg'),onMapPoint:(point,scale)=>points.push({point,scale}),onSelectBooth:id=>selected.push(id)});
  const flush=()=>{const batch=[...frames.values()];frames.clear();time+=16;batch.forEach(callback=>callback(time));};flush();
  return{win,stage,camera,fit,engine,points,selected,bounds,flush,resize(width,height){size={width,height};win.dispatchEvent(new win.Event('resize'));flush();},close(){engine.destroy();dom.window.close();}};
}
function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);}
function checkProjection(f,x,y){
  const view=fittedViewBox(f.bounds),map=f.engine.screenToMap(x,y),scale=f.engine.getDisplayedPixelsPerUnit();
  const translation=/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(f.camera.style.transform);
  const displayedWidth=Number.parseFloat(f.fit.style.width),displayedLeft=Number.parseFloat(f.fit.style.left),displayedTop=Number.parseFloat(f.fit.style.top);
  near((map[0]-view.x)*displayedWidth/view.width+displayedLeft+Number(translation[1]),x);
  near((map[1]-view.y)*scale+displayedTop+Number(translation[2]),y);
  near(scale,displayedWidth/view.width);
}

test('pin coordinates follow the displayed camera through zoom easing, panning, letterboxing and resize',()=>{
  for(const [width,height] of [[900,600],[390,700]]){
    const f=setup(width,height);
    try{
      checkProjection(f,100,200);
      f.engine.fitBounds(0,30,60,70,{animate:false});f.flush();checkProjection(f,150,250);
      f.stage.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
      f.flush();checkProjection(f,150,250); // camera is still easing toward its target
      f.resize(height,width);checkProjection(f,100,200);
      f.engine.setPointSelection(true);
      f.stage.dispatchEvent(new f.win.MouseEvent('click',{bubbles:true,detail:1,clientX:140,clientY:270}));
      assert.equal(f.points.length,1);const expected=f.engine.screenToMap(100,200);
      near(f.points[0].point[0],expected[0]);near(f.points[0].point[1],expected[1]);near(f.points[0].scale,f.engine.getDisplayedPixelsPerUnit());
    }finally{f.close();}
  }
});
test('placement consumes booth clicks, normal mode selects booths, and dragging suppresses placement',()=>{
  const f=setup();
  try{
    const booth=f.stage.querySelector('rect');
    f.engine.setPointSelection(true);
    booth.dispatchEvent(new f.win.MouseEvent('click',{bubbles:true,detail:1,clientX:200,clientY:200}));
    assert.equal(f.points.length,1);assert.equal(f.selected.length,0);
    f.engine.setPointSelection(false);
    booth.dispatchEvent(new f.win.MouseEvent('click',{bubbles:true,detail:1}));assert.deepEqual(f.selected,['booth']);
    f.engine.setPointSelection(true);
    f.stage.dispatchEvent(new f.win.MouseEvent('mousedown',{bubbles:true,view:f.win,clientX:200,clientY:200,button:0}));
    f.win.dispatchEvent(new f.win.MouseEvent('mousemove',{bubbles:true,view:f.win,clientX:250,clientY:230,buttons:1}));
    f.win.dispatchEvent(new f.win.MouseEvent('mouseup',{bubbles:true,view:f.win,clientX:250,clientY:230}));
    f.stage.dispatchEvent(new f.win.MouseEvent('click',{bubbles:true,detail:1,clientX:250,clientY:230}));
    assert.equal(f.points.length,1);
  }finally{f.close();}
});
