import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createD3ZoomEngine, focusTransform } from '../src/utils/d3ZoomEngine.ts';

function setup() {
  const dom = new JSDOM('<svg id="floorplan-svg"><g id="viewport-matrix"><g data-booth-id="a"><rect width="20" height="20"/></g></g></svg>', { pretendToBeVisual: true });
  const win = dom.window, svg = win.document.querySelector('svg'), group = svg.querySelector('#viewport-matrix');
  let reduced = false;
  const listeners = new Set();
  win.matchMedia = () => ({ get matches() { return reduced; }, addEventListener(type, callback) { listeners.add(callback); }, removeEventListener(type, callback) { listeners.delete(callback); } });
  svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
  const selected = [];
  const options = { bounds: { x: 0, y: 0, width: 1000, height: 600 }, onSelectBooth: (id) => selected.push(id) };
  const engine = createD3ZoomEngine(svg, group, options);
  return { dom, win, svg, group, selected, engine, options, listeners, reduce() { reduced = true; listeners.forEach((callback) => callback()); }, close() { engine.destroy(); dom.window.close(); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8);
test('real D3 controls use zoom transforms, scale extents, and identity reset', () => {
  const f = setup();
  near(f.engine.getZoom(), 1);
  f.engine.zoomIn({ animate: false }); near(f.engine.getZoom(), 1.25);
  f.engine.zoomOut({ animate: false }); near(f.engine.getZoom(), 1);
  for (let i = 0; i < 30; i++) f.engine.zoomIn({ animate: false });
  near(f.engine.getZoom(), 8);
  f.engine.resetView({ animate: false });
  assert.equal(f.group.getAttribute('transform'), null);
  assert.equal(f.group.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
  f.close();
});
test('wheel events run through d3-zoom and preserve the cursor focal point', () => {
  const f = setup();
  const before = f.engine.getTransform();
  f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaY: -100, clientX: 250, clientY: 200, bubbles: true, cancelable: true, view: f.win }));
  const after = f.engine.getTransform();
  assert.ok(after.k > before.k);
  near(after.k / before.k, 1.15);
  near((250 - after.x) / after.k, (250 - before.x) / before.k);
  near((200 - after.y) / after.k, (200 - before.y) / before.k);
  f.close();
});
test('wheel pixel, line, and page notches have equivalent reciprocal zoom steps', () => {
  for (const [deltaMode, deltaY] of [[0, 100], [1, 3], [2, 1]]) {
    const f = setup();
    const wheel = (direction) => f.svg.dispatchEvent(new f.win.WheelEvent('wheel', { deltaMode, deltaY: deltaY * direction, clientX: 250, clientY: 200, bubbles: true, cancelable: true }));
    wheel(-1); near(f.engine.getZoom(), 1.15);
    wheel(1); near(f.engine.getZoom(), 1);
    assert.match(f.group.style.transform, /^translate3d\(.+px, .+px, 0px\) scale\(/);
    assert.equal(f.group.getAttribute('transform'), null);
    f.close();
  }
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
  f.close();
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
test('LOD changes only at scale thresholds and taps preserve selection callbacks', () => {
  const f = setup();
  assert.equal(f.group.getAttribute('data-detail'), 'low');
  for (let i = 0; i < 3; i++) f.engine.zoomIn({ animate: false });
  assert.equal(f.group.getAttribute('data-detail'), 'high');
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
