import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createD3ZoomEngine, focusTransform, labelLevel, visibleMapBounds, intersectsBounds, textCullBounds, frameFor, fittedViewBox, ZOOM_MAX, EASE_TAU_MS } from '../src/utils/d3ZoomEngine.ts';

// Mirrors FloorPlan.tsx: an HTML stage (gesture surface) > camera (the only
// transformed element) > fit (letterboxed frame) > three sibling SVG layers.
function setup(configure = () => ({})) {
  const dom = new JSDOM('<div id="floorplan-stage"><div id="camera"><div id="fit"><svg id="venue-backdrop"><text x="10" y="10" font-size="2">EXIT</text></svg><svg id="viewport-matrix"><rect data-booth-id="a" width="20" height="20"/></svg><svg id="booth-labels"><g data-booth-label-id="a"><text>A</text></g></svg></div></div></div>', { pretendToBeVisual: true });
  const win = dom.window, svg = win.document.querySelector('#floorplan-stage'), group = svg.querySelector('#camera');
  const fit = svg.querySelector('#fit'), booths = svg.querySelector('#viewport-matrix');
  const backdrop = svg.querySelector('#venue-backdrop');
  const labels = svg.querySelector('#booth-labels');
  let reduced = false;
  const listeners = new Set();
  win.matchMedia = () => ({ get matches() { return reduced; }, addEventListener(type, callback) { listeners.add(callback); }, removeEventListener(type, callback) { listeners.delete(callback); } });
  svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
  const selected = [], deselected = [];
  const options = { bounds: { x: 0, y: 0, width: 1000, height: 600 }, fit, booths, backdrop, labels, onSelectBooth: (id) => selected.push(id), onDeselectBooth: () => deselected.push(true), ...configure(svg) };
  const request = win.requestAnimationFrame.bind(win), cancel = win.cancelAnimationFrame.bind(win);
  const initial = new Map(); let initialId = 0;
  win.requestAnimationFrame = (callback) => { initial.set(++initialId, callback); return initialId; };
  win.cancelAnimationFrame = (id) => initial.delete(id);
  const engine = createD3ZoomEngine(svg, group, options);
  const mount = [...initial.values()]; initial.clear(); mount.forEach((callback) => callback(win.performance.now()));
  win.requestAnimationFrame = request; win.cancelAnimationFrame = cancel;
  // `svg` is the stage (event target) and `group` the camera, keeping the older test names.
  return { dom, win, svg, stage: svg, group, camera: group, fit, booths, backdrop, labels, selected, deselected, engine, options, listeners, reduce() { reduced = true; listeners.forEach((callback) => callback()); }, close() { engine.destroy(); dom.window.close(); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} vs ${b}`);
test('frustum inversion handles nonzero origins, letterboxing and a 100px buffer', () => {
  // CSS-pixel camera inverted through the letterboxed frame into map units.
  const box = visibleMapBounds({ x: -50, y: 20, width: 1000, height: 600 }, 1000, 600, { x: 200, y: -100, k: 2 });
  assert.deepEqual(box, { x: -200, y: 20, width: 600, height: 400 });
  const square = visibleMapBounds({ x: 10, y: 20, width: 1000, height: 500 }, 500, 500, { x: 0, y: 0, k: 2 });
  assert.deepEqual(square, { x: -90, y: -330, width: 700, height: 700 });
  const frame = frameFor({ x: 10, y: 20, width: 1000, height: 500 }, 500, 500);
  assert.deepEqual(frame, { width: 500, height: 500, pixelsPerUnit: 0.5, offsetX: 0, offsetY: 125 });
  assert.deepEqual(fittedViewBox({ x: 0, y: 0, width: 1000, height: 600 }), { x: -24, y: -24, width: 1048, height: 648 });
  const padded = visibleMapBounds({ x: 0, y: 0, width: 100, height: 100 }, 100, 100, { x: 0, y: 0, k: 1 });
  assert.equal(intersectsBounds(padded, { x: 199, y: 0, width: 1, height: 1 }), true);
  assert.equal(intersectsBounds(padded, { x: 201, y: 0, width: 1, height: 1 }), false);
  assert.equal(visibleMapBounds({ x: 0, y: 0, width: 100, height: 100 }, 0, 0, { x: 0, y: 0, k: 1 }), null);
});

test('offscreen rectangles, labels and structural text cull only in RAF and restore after reset/cleanup', () => {
  const f = setup(svg => {
    svg.querySelector('#viewport-matrix').insertAdjacentHTML('beforeend', '<rect data-booth-id="far" x="900" y="500" width="20" height="20"/>');
    svg.querySelector('#booth-labels').insertAdjacentHTML('beforeend', '<g data-booth-label-id="far"><text>Far company</text></g>');
    svg.querySelector('#venue-backdrop').insertAdjacentHTML('beforeend', '<text id="far-note" x="950" y="550" font-size="1">AED</text>');
    return {};
  });
  const frames = new Map(); let id = 0;
  f.win.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = key => frames.delete(key);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(f.win.performance.now())); };
  const far = f.group.querySelector('[data-booth-id="far"]'), label = f.labels.querySelector('[data-booth-label-id="far"]'), note = f.backdrop.querySelector('#far-note'), exit = f.backdrop.querySelector('text');
  try {
    f.engine.fitBounds(-10, -10, 30, 30, { animate: false });
    assert.equal(far.style.display, '');
    flush();
    assert.equal(far.style.display, 'none');
    assert.equal(label.style.display, 'none');
    assert.equal(note.style.display, 'none');
    assert.equal(exit.style.display, '');
    assert.equal(f.group.querySelector('[data-booth-id="a"]').style.display, '');
    // Selection/search class updates must not undo engine-owned culling.
    far.setAttribute('class', 'selected boundary');
    assert.equal(far.style.display, 'none');
    // Labels React mounts later are culled on the next frame without re-setup.
    f.labels.insertAdjacentHTML('beforeend', '<g data-booth-label-id="far"><text>Mounted later</text></g>');
    const late = f.labels.lastElementChild;
    f.win.dispatchEvent(new f.win.Event('resize')); flush();
    assert.equal(late.style.display, 'none');
    f.engine.resetView({ animate: false }); flush();
    assert.equal(far.style.display, '');
    assert.equal(label.style.display, '');
    assert.equal(late.style.display, '');
    assert.equal(note.style.display, '');
    f.engine.fitBounds(-10, -10, 30, 30, { animate: false }); flush();
    f.engine.destroy();
    assert.equal(far.style.display, '');
    assert.equal(label.style.display, '');
    assert.equal(note.style.display, '');
    f.win.dispatchEvent(new f.win.Event('resize'));
    assert.equal(frames.size, 0);
  } finally { f.close(); }
});

test('structural text bounds enclose rotated text of any length', () => {
  assert.deepEqual(textCullBounds(100, 50, 2, 1), { x: 97, y: 47, width: 6, height: 6 });
  const long = textCullBounds(100, 50, 2, 10);
  assert.ok(long.width >= 12 && long.x <= 94 && long.x + long.width >= 106);
  assert.equal(long.width, long.height);
});

test('label views update in the next animation frame without waiting for gesture-end timers', () => {
  const settled = [];
  const f = setup(svg => {
    svg.querySelector('#viewport-matrix').insertAdjacentHTML('beforeend', '<rect data-booth-id="far" x="900" y="500" width="20" height="20"/>');
    return { onViewSettle: view => settled.push(view) };
  });
  const frames = new Map(), timers = new Map(); let id = 0;
  f.win.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = key => frames.delete(key);
  f.win.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id; };
  f.win.clearTimeout = key => timers.delete(key);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(f.win.performance.now())); };
  try {
    assert.equal(settled.length, 1);
    assert.deepEqual(settled[0], { scale: 1, level: 0, visibleIds: ['a', 'far'] });
    f.win.dispatchEvent(new f.win.Event('resize')); flush();
    assert.equal(settled.length, 1, 'unchanged views do not re-report');
    f.engine.fitBounds(-10, -10, 30, 30, { animate: false }); flush();
    assert.equal(settled.length, 2);
    assert.equal(settled[1].level, 4);
    assert.deepEqual(settled[1].visibleIds, ['a']);
    assert.ok(settled[1].scale <= ZOOM_MAX);
    assert.ok([...timers.values()].every(t => t.delay === 150), 'only annotation restoration remains delayed');
    f.engine.resetView({ animate: false }); flush();
    const last = settled.at(-1);
    assert.equal(last.level, 0);
    assert.deepEqual(last.visibleIds, ['a', 'far']);
    assert.equal(f.group.style.transform, 'translate3d(0px, 0px, 0px)');
  } finally { f.close(); }
});

test('continuous wheel zoom prefetches labels while retaining the displayed view and deduplicating frames', () => {
  const views=[];
  const f=setup(stage=>{
    stage.querySelector('#viewport-matrix').insertAdjacentHTML('beforeend','<rect data-booth-id="far" x="900" y="500" width="20" height="20"/>');
    return {onViewSettle:view=>views.push(view)};
  });
  const frames=new Map();let id=0,time=0;
  f.win.requestAnimationFrame=callback=>{frames.set(++id,callback);return id;};
  f.win.cancelAnimationFrame=key=>frames.delete(key);
  const flush=()=>{const batch=[...frames.values()];frames.clear();time+=16;batch.forEach(callback=>callback(time));};
  try{
    f.stage.dispatchEvent(new f.win.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-500,clientX:500,clientY:300}));
    assert.equal(views.length,1,'input handler does not update React');
    flush();
    assert.ok(views.at(-1).level>=1,'new label tier prepared before the wheel gesture ends');
    assert.equal(f.labels.getAttribute('data-label-level'),'0','displayed camera is still easing toward the new tier');
    const target=visibleMapBounds(fittedViewBox(f.options.bounds),1000,600,f.engine.getTransform());
    assert.equal(intersectsBounds({x:0,y:0,width:20,height:20},target),false);
    assert.ok(views.at(-1).visibleIds.includes('a'),'keep labels still in the displayed view even when absent from the target');
    for(let step=0;step<80;step++)flush();
    assert.equal(views.at(-1).visibleIds.includes('a'),false,'old labels leave when the camera catches up');
    const count=views.length;
    f.win.dispatchEvent(new f.win.Event('resize'));flush();
    assert.equal(views.length,count,'unchanged label membership does not trigger a React update');
    f.stage.dispatchEvent(new f.win.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:500,clientX:500,clientY:300}));flush();
    assert.ok(views.at(-1).level>=1,'keep the displayed tier while zooming out');
    for(let step=0;step<80;step++)flush();
    assert.equal(views.at(-1).level,0,'drop the old tier after zoom-out finishes');
  }finally{f.close();}
});

test('camera ease is frame-rate independent: slow frames converge in fewer frames', () => {
  const framesToConverge = (frameMs) => {
    const f = setup(), frames = new Map(); let id = 0, time = 1000;
    f.win.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
    f.win.cancelAnimationFrame = key => frames.delete(key);
    try {
      f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaY: -300, clientX: 250, clientY: 200, bubbles: true, cancelable: true }));
      let count = 0;
      while (frames.size && count < 500) { time += frameMs; const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(time)); count++; }
      return count;
    } finally { f.close(); }
  };
  const fast = framesToConverge(1000 / 60), slow = framesToConverge(60);
  assert.ok(slow < fast / 2, `60 ms frames (${slow}) should converge in far fewer frames than 16 ms frames (${fast})`);
  // The per-frame factor at 60 fps matches the former constant 0.18 within rounding.
  assert.ok(Math.abs((1 - Math.exp(-(1000 / 60) / EASE_TAU_MS)) - 0.18) < 0.01);
});

test('all controls and explicit focus requests remain within 0.5–8x even with extreme options', () => {
  const f = setup(svg => {
    const doc = svg.ownerDocument;
    const controls = { zoomIn: doc.createElement('button'), zoomOut: doc.createElement('button'), indicator: doc.createElement('output') };
    doc.body.append(controls.zoomIn, controls.zoomOut, controls.indicator);
    return { minZoom: 0.01, maxZoom: 90, controls };
  });
  const frames = new Map(); let id = 0;
  f.win.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = key => frames.delete(key);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(f.win.performance.now())); };
  try {
    f.engine.fitBounds(0, 0, 0.1, 0.1, { animate: false }); flush();
    near(f.engine.getZoom(), 8);
    assert.equal(f.options.controls.zoomIn.disabled, true);
    assert.equal(f.options.controls.indicator.textContent, '8.0×');
    for (let i = 0; i < 40; i++) f.engine.zoomOut({ animate: false });
    flush(); near(f.engine.getZoom(), 0.5);
    assert.equal(f.options.controls.zoomOut.disabled, true);
    assert.equal(f.options.controls.indicator.textContent, '0.5×');
    f.engine.destroy(); assert.equal(f.options.controls.zoomOut.disabled, false);
  } finally { f.close(); }
});
test('progressive label levels cross at 1.8, 2.5, 3.5 and 5x, all below the 8x ceiling', () => {
  for (const [scale, level] of [[1, 0], [1.799, 0], [1.8, 1], [2.499, 1], [2.5, 2], [3.499, 2], [3.5, 3], [4.999, 3], [5, 4], [8, 4], [24, 4]]) assert.equal(labelLevel(scale), level);
  assert.equal(ZOOM_MAX, 8);
});
test('real D3 controls use zoom transforms, scale extents, and identity reset', async () => {
  const f = setup();
  near(f.engine.getZoom(), 1);
  f.engine.zoomIn({ animate: false }); near(f.engine.getZoom(), 1.25);
  f.engine.zoomOut({ animate: false }); near(f.engine.getZoom(), 1);
  for (let i = 0; i < 30; i++) f.engine.zoomIn({ animate: false });
  near(f.engine.getZoom(), 8);
  f.engine.resetView({ animate: false });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(f.group.getAttribute('transform'), null);
  assert.equal(f.group.style.transform, 'translate3d(0px, 0px, 0px)');
  f.close();
});
test('wheel events run through d3-zoom and preserve the cursor focal point', async () => {
  const f = setup();
  const before = f.engine.getTransform();
  f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaY: -100, clientX: 250, clientY: 200, bubbles: true, cancelable: true, view: f.win }));
  near(f.engine.getZoom(), 1);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const after = f.engine.getTransform();
  assert.ok(after.k > before.k);
  near(after.k / before.k, 1.15);
  near((250 - after.x) / after.k, (250 - before.x) / before.k);
  near((200 - after.y) / after.k, (200 - before.y) / before.k);
  f.close();
});
test('wheel pixel, line, and page notches have equivalent reciprocal zoom steps', async () => {
  for (const [deltaMode, deltaY] of [[0, 100], [1, 3], [2, 1]]) {
    const f = setup();
    const wheel = (direction) => f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaMode, deltaY: deltaY * direction, clientX: 250, clientY: 200, bubbles: true, cancelable: true }));
    wheel(-1); await new Promise((resolve) => setTimeout(resolve, 750)); near(f.engine.getZoom(), 1.15);
    wheel(1); await new Promise((resolve) => setTimeout(resolve, 750)); near(f.engine.getZoom(), 1);
    assert.match(f.group.style.transform, /^translate3d\(.+px, .+px, 0px\)$/);
    assert.equal(f.group.getAttribute('transform'), null);
    f.close();
  }
});
test('wheel bursts accumulate without jumping to the target immediately', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 3; i++) f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaY: -100, clientX: 250, clientY: 200, bubbles: true, cancelable: true }));
    near(f.engine.getZoom(), 1);
    await new Promise((resolve) => setTimeout(resolve, 750));
    near(f.engine.getZoom(), 1.15 ** 3);
  } finally { f.close(); }
});
test('wheel bursts queue one frame and never write a transform in the input handler', () => {
  const f = setup(), frames = new Map();
  let id = 0, time = f.win.performance.now();
  f.win.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = (key) => frames.delete(key);
  try {
    const initial = f.group.style.transform;
    for (let i = 0; i < 3; i++) f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaY: -100, clientX: 250, clientY: 200, bubbles: true, cancelable: true }));
    assert.equal(frames.size, 1);
    assert.equal(f.group.style.transform, initial);
    const before = f.engine.getTransform();
    for (let i = 0; i < 120 && frames.size; i++) {
      time += 1000 / 120;
      const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(time));
      const current = f.engine.getTransform();
      near((250 - current.x) / current.k, (250 - before.x) / before.k);
      near((200 - current.y) / current.k, (200 - before.y) / before.k);
      assert.ok(frames.size <= 1);
    }
    near(f.engine.getZoom(), 1.15 ** 3);
    assert.equal(frames.size, 0);
    f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    f.engine.destroy();
    assert.equal(frames.size, 0);
  } finally { f.close(); }
});
test('background double-click clears eligible routes without zooming and captures first-click eligibility', () => {
  let eligible = true, cleared = 0;
  const f = setup(() => ({ canClearRoute: () => eligible, onClearRoute: () => cleared++ }));
  const click = (type, detail, x = 500) => f.stage.dispatchEvent(new f.win.MouseEvent(type, { bubbles: true, cancelable: true, view: f.win, detail, clientX: x, clientY: 300 }));
  try {
    const before = f.engine.getTransform();
    click('click', 1); click('click', 2); click('dblclick', 2);
    assert.equal(cleared, 1); assert.deepEqual(f.engine.getTransform(), before);
    eligible = false; click('click', 1);
    eligible = true; click('click', 2); click('dblclick', 2);
    assert.equal(cleared, 1, 'deselecting on the first click does not make that gesture eligible');
    eligible = false; click('click', 1); click('dblclick', 2);
    assert.equal(cleared, 1, 'an ineligible point preserves the route');
    f.engine.setPointSelection(true); eligible = true;
    click('click', 1); click('dblclick', 2);
    assert.equal(cleared, 1, 'placement never clears a route');
  } finally { f.close(); }
});

test('double-click zoom remains available through the D3 behavior', async () => {
  const f = setup();
  try {
    f.svg.dispatchEvent(new f.win.MouseEvent('dblclick', { clientX: 300, clientY: 200, bubbles: true, cancelable: true, view: f.win }));
    await new Promise((resolve) => setTimeout(resolve, 380));
    near(f.engine.getZoom(), 2);
  } finally { f.close(); }
});

test('booth double-click requests directions once without zoom; single click still selects', () => {
  const requested=[];
  const f=setup(()=>({onDirectionsBooth:id=>requested.push(id)}));
  const event=(type,detail)=>new f.win.MouseEvent(type,{bubbles:true,cancelable:true,view:f.win,detail,clientX:10,clientY:10});
  try{
    const booth=f.booths.querySelector('rect'),before=f.engine.getTransform();
    booth.dispatchEvent(event('click',1));booth.dispatchEvent(event('click',2));booth.dispatchEvent(event('dblclick',2));
    assert.deepEqual(f.selected,['a']);assert.deepEqual(requested,['a']);assert.equal(f.engine.getTransform(),before);
    // A focusing animation can move the booth before the second click lands.
    booth.dispatchEvent(event('click',1));f.stage.dispatchEvent(event('click',2));f.stage.dispatchEvent(event('dblclick',2));
    assert.deepEqual(requested,['a','a']);
    f.stage.dispatchEvent(event('click',1));
    assert.equal(f.deselected.length,1,'normal background clicks remain available');
  }finally{f.close();}
});

test('a double-click used for pin placement does not activate directions after placement exits', () => {
  const requested=[];let f;
  f=setup(()=>({onDirectionsBooth:id=>requested.push(id),onMapPoint:()=>f.engine.setPointSelection(false)}));
  try{
    const booth=f.booths.querySelector('rect'),before=f.engine.getTransform();
    const event=(type,detail)=>new f.win.MouseEvent(type,{bubbles:true,cancelable:true,view:f.win,detail});
    f.engine.setPointSelection(true);
    booth.dispatchEvent(event('click',1));booth.dispatchEvent(event('click',2));booth.dispatchEvent(event('dblclick',2));
    assert.deepEqual(requested,[]);assert.deepEqual(f.selected,[]);assert.equal(f.engine.getTransform(),before);
  }finally{f.close();}
});
test('D3 mouse drag pans and suppresses the resulting booth click', () => {
  const f = setup();
  const event = (type, x, y) => new f.win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: f.win, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
  f.svg.dispatchEvent(event('mousedown', 200, 100));
  f.win.dispatchEvent(event('mousemove', 240, 130));
  f.win.dispatchEvent(event('mouseup', 240, 130));
  near(f.engine.getTransform().x, 40); near(f.engine.getTransform().y, 30);
  f.group.querySelector('rect').dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: f.win }));
  assert.deepEqual(f.selected, []);
  f.svg.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: f.win }));
  assert.deepEqual(f.deselected, []);
  f.close();
});

test('empty map clicks deselect without changing the camera; booth clicks only select', () => {
  const f = setup();
  try {
    const before = f.engine.getTransform();
    f.group.querySelector('rect').dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, detail: 1 }));
    assert.deepEqual(f.selected, ['a']); assert.deepEqual(f.deselected, []);
    f.svg.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, detail: 1 }));
    assert.deepEqual(f.deselected, [true]);
    assert.equal(f.engine.getTransform(), before);
  } finally { f.close(); }
});
test('two-finger touch gestures use D3 pinch zoom around the midpoint', () => {
  const f = setup();
  const touch = (identifier, clientX) => ({ identifier, clientX, clientY: 200 });
  const send = (type, touches, changedTouches = touches) => {
    const event = new f.win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
    f.svg.dispatchEvent(event);
  };
  send('touchstart', [touch(1, 400), touch(2, 600)]);
  send('touchmove', [touch(1, 300), touch(2, 700)]);
  const transform = f.engine.getTransform();
  near(transform.k, 2);
  near((500 - transform.x) / transform.k, 500);
  near((200 - transform.y) / transform.k, 200);
  send('touchend', [], [touch(1, 300), touch(2, 700)]);
  f.close();
});
test('drag bursts transform only the HTML camera once per frame without repeated LOD or layer writes', () => {
  const f = setup(), frames = new Map(); let id = 0;
  f.win.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = (key) => frames.delete(key);
  const event = (type, x, y) => new f.win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: f.win, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(f.win.performance.now())); };
  let detailWrites = 0;
  const setAttribute = f.booths.setAttribute.bind(f.booths);
  f.booths.setAttribute = (name, value) => { if (name === 'data-detail') detailWrites++; setAttribute(name, value); };
  try {
    // Static venue layer and interactive booth layer are sibling SVGs inside the
    // camera; neither contains the other's nodes, and the camera is an HTML element.
    assert.equal(f.camera.tagName, 'DIV');
    assert.equal(f.camera.contains(f.backdrop) && f.camera.contains(f.booths) && f.camera.contains(f.labels), true);
    assert.equal(f.booths.contains(f.backdrop) || f.backdrop.contains(f.booths), false);
    assert.equal(f.backdrop.querySelector('[data-booth-id]'), null);
    assert.equal(f.booths.querySelector('text, image, polygon'), null);
    // The fit frame letterboxes the 1048x648 viewBox into the 1000x600 stage.
    near(parseFloat(f.fit.style.height), 600);
    near(parseFloat(f.fit.style.width), 1048 * (600 / 648));
    near(parseFloat(f.fit.style.left), (1000 - 1048 * (600 / 648)) / 2);
    const initial = f.camera.style.transform;
    f.svg.dispatchEvent(event('mousedown', 200, 100));
    f.win.dispatchEvent(event('mousemove', 220, 120));
    f.win.dispatchEvent(event('mousemove', 240, 130));
    assert.equal(frames.size, 1);
    assert.equal(f.camera.style.transform, initial);
    assert.equal(f.svg.classList.contains('is-interacting'), false);
    flush();
    // The ease is time-based, so assert direction/proportion rather than a fixed factor.
    const eased = f.camera.style.transform.match(/^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0px\)$/);
    assert.ok(eased, f.camera.style.transform);
    const [ex, ey] = [Number(eased[1]), Number(eased[2])];
    assert.ok(ex > 0 && ex < 40 && ey > 0 && ey < 30);
    near(ey / ex, 30 / 40);
    // SVG layers are never transformed individually; the camera carries the matrix.
    assert.equal(f.backdrop.style.transform, '');
    assert.equal(f.booths.style.transform, '');
    assert.equal(f.labels.style.transform, '');
    assert.equal(f.svg.classList.contains('is-interacting'), true);
    assert.equal(f.svg.hasAttribute('data-composited'), false);
    f.win.dispatchEvent(event('mousemove', 260, 150)); flush();
    assert.equal(detailWrites, 0);
    f.win.dispatchEvent(event('mouseup', 260, 150));
    f.engine.destroy();
    assert.equal(f.camera.style.transform, '');
    assert.equal(f.svg.classList.contains('is-interacting'), false);
    assert.equal(frames.size, 0);
  } finally { f.close(); }
});

test('marker radius compensation follows displayed zoom and resize, with stable size during pan', () => {
  const f=setup(stage=>{stage.style.setProperty('--map-unit-per-pixel','2');return {};});
  const frames=new Map();let id=0,time=0;
  f.win.requestAnimationFrame=callback=>{frames.set(++id,callback);return id;};
  f.win.cancelAnimationFrame=key=>frames.delete(key);
  const flush=()=>{const batch=[...frames.values()];frames.clear();time+=16;batch.forEach(callback=>callback(time));};
  const check=()=>{
    const unit=Number(f.stage.style.getPropertyValue('--map-unit-per-pixel'));
    const displayedScale=parseFloat(f.fit.style.width)/fittedViewBox(f.options.bounds).width;
    assert.ok(unit>0&&Number.isFinite(unit));
    assert.ok(Math.abs(4*unit*displayedScale-4)<1e-6,'saved/visited radius stays at 4 screen pixels');
    assert.ok(Math.abs(7*unit*displayedScale-7)<1e-6,'route endpoint radius stays at 7 screen pixels');
    assert.ok(Math.abs(2*unit*displayedScale-2)<1e-6,'circle outlines stay at 2 screen pixels');
  };
  try{
    check();
    f.stage.dispatchEvent(new f.win.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-500,clientX:500,clientY:300}));
    flush();check();
    const targetUnit=1/(f.engine.getFrame().pixelsPerUnit*f.engine.getZoom());
    assert.ok(Math.abs(Number(f.stage.style.getPropertyValue('--map-unit-per-pixel'))-targetUnit)>.001,'uses the displayed camera, not the target');
    for(let step=0;step<80;step++){flush();check();}
    f.stage.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:390,bottom:800,width:390,height:800});
    f.win.dispatchEvent(new f.win.Event('resize'));flush();check();
    const before=f.stage.style.getPropertyValue('--map-unit-per-pixel');
    f.stage.dispatchEvent(new f.win.KeyboardEvent('keydown',{bubbles:true,key:'ArrowLeft'}));flush();check();
    assert.equal(f.stage.style.getPropertyValue('--map-unit-per-pixel'),before,'pan leaves marker sizes unchanged');
    f.engine.zoomOut({animate:false});flush();check();
    f.engine.resetView({animate:false});flush();check();
    f.engine.destroy();assert.equal(f.stage.style.getPropertyValue('--map-unit-per-pixel'),'2','cleanup restores the original inherited variable');
  }finally{f.close();}
});

test('stroke scale and fit size track the displayed zoom every frame so borders stay sharp', () => {
  const f = setup(), frames = new Map(); let id = 0;
  f.win.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = (key) => frames.delete(key);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(f.win.performance.now())); };
  const identityWidth = parseFloat(f.fit.style.width), identityHeight = parseFloat(f.fit.style.height);
  try {
    assert.equal(f.svg.style.getPropertyValue('--sw'), '1.0000');
    assert.equal(f.camera.style.transform, 'translate3d(0px, 0px, 0px)');
    f.engine.zoomIn({ animate: false }); flush();
    assert.equal(f.svg.hasAttribute('data-composited'), false);
    assert.equal(f.svg.style.getPropertyValue('--sw'), (1 / 1.25).toFixed(4));
    near(parseFloat(f.fit.style.width), identityWidth * 1.25);
    near(parseFloat(f.fit.style.height), identityHeight * 1.25);
    assert.match(f.camera.style.transform, /^translate3d\(.+px, .+px, 0px\)$/);
    assert.equal(f.camera.style.transform.includes('scale('), false);
    f.engine.destroy();
    assert.equal(f.svg.style.getPropertyValue('--sw'), '');
  } finally { f.close(); }
});
test('pinch bursts buffer visual transforms and classes until one shared frame', () => {
  const f = setup(), frames = new Map(); let id = 0;
  f.win.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = (key) => frames.delete(key);
  const send = (type, touches, changedTouches = touches) => {
    const event = new f.win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
    f.svg.dispatchEvent(event);
  };
  const point = (identifier, clientX) => ({ identifier, clientX, clientY: 200 });
  try {
    const before = f.group.style.transform;
    send('touchstart', [point(1, 400), point(2, 600)]);
    send('touchmove', [point(1, 350), point(2, 650)]);
    send('touchmove', [point(1, 300), point(2, 700)]);
    assert.equal(f.group.style.transform, before);
    assert.equal(f.svg.classList.contains('is-zooming'), false);
    assert.equal(frames.size, 1);
    const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(f.win.performance.now()));
    assert.notEqual(f.group.style.transform, before);
    assert.equal(f.svg.classList.contains('is-zooming'), true);
    assert.equal(f.booths.getAttribute('data-detail'), 'low');
    assert.equal(f.booths.classList.contains('is-low-detail'), true);
    // Advance a realistic 16 ms per frame; the ease is time-based.
    for (let i = 0, time = f.win.performance.now(); i < 100 && frames.size; i++) {
      time += 1000 / 60;
      const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(time));
    }
    assert.equal(f.booths.getAttribute('data-detail'), 'high');
    assert.equal(f.booths.classList.contains('is-low-detail'), false);
    assert.equal(frames.size, 0);
    send('touchend', [], [point(1, 300), point(2, 700)]);
  } finally { f.close(); }
});
test('annotation restoration waits 150 ms and commits only in a frame', () => {
  const f = setup(), frames = new Map(), timers = new Map(); let id = 0;
  f.win.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  f.win.cancelAnimationFrame = (key) => frames.delete(key);
  f.win.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id; };
  f.win.clearTimeout = (key) => timers.delete(key);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(f.win.performance.now())); };
  try {
    f.engine.zoomIn({ animate: false });
    assert.equal(f.svg.classList.contains('is-zooming'), false);
    flush();
    assert.equal(f.svg.classList.contains('is-zooming'), true);
    assert.equal(f.svg.classList.contains('is-interacting'), true);
    const timer = [...timers.values()].find(t => t.delay === 150);
    assert.ok(timer, 'annotation restore timer scheduled');
    timer.callback();
    assert.equal(f.svg.classList.contains('is-zooming'), true);
    assert.equal(frames.size, 1);
    flush();
    assert.equal(f.svg.classList.contains('is-zooming'), false);
    assert.equal(f.svg.classList.contains('is-interacting'), false);
    assert.equal(f.svg.hasAttribute('data-moving'), false);
  } finally { f.close(); }
});
test('LOD changes only at scale thresholds and taps preserve selection callbacks', async () => {
  const f = setup();
  assert.equal(f.booths.getAttribute('data-detail'), 'low');
  assert.equal(f.svg.classList.contains('is-low-detail'), true);
  for (let i = 0; i < 3; i++) f.engine.zoomIn({ animate: false });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(f.booths.getAttribute('data-detail'), 'high');
  assert.equal(f.svg.classList.contains('is-low-detail'), false);
  f.group.querySelector('rect').dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.deepEqual(f.selected, ['a']);
  f.close();
});
test('fit transforms clamp explicit transform requests and center nonzero bounds', () => {
  const t = focusTransform({ x: -50, y: 20, width: 1000, height: 600 }, { x: 10, y: 20, width: 10, height: 10 }, 0.5, 8);
  near(t.k, 8); near(t.applyX(15), 450); near(t.applyY(25), 320);
});
test('reduced motion bypasses transitions and cleanup permits Strict Mode replay', () => {
  const f = setup();
  f.reduce(); f.engine.zoomIn(); near(f.engine.getZoom(), 1.25);
  f.engine.destroy();
  assert.equal(f.svg.__on, undefined);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.group.getAttribute('transform'), null);
  const replay = createD3ZoomEngine(f.svg, f.group, f.options);
  near(replay.getZoom(), 1); replay.destroy();
  f.close();
});
test('D3 transition controls finish at their requested scales', async () => {
  const f = setup();
  try {
    f.engine.zoomIn();
    await new Promise((resolve) => setTimeout(resolve, 380)); near(f.engine.getZoom(), 1.25);
    f.engine.zoomOut();
    await new Promise((resolve) => setTimeout(resolve, 380)); near(f.engine.getZoom(), 1);
    f.engine.zoomIn({ animate: false }); f.engine.resetView();
    await new Promise((resolve) => setTimeout(resolve, 580)); near(f.engine.getZoom(), 1);
  } finally { f.close(); }
});
