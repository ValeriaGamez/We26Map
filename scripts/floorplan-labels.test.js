import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { boothLabelTier } from '../src/lib/booth-label-lod.ts';
import { selectFloorplanArea } from '../src/lib/floorplan-area.ts';
import { getBounds } from '../src/lib/floorplan-geometry.ts';

// Exercise the actual stylesheet, resolving CSS Modules' global escape syntax.
const css = readFileSync(new URL('../src/components/FloorPlan.module.css', import.meta.url), 'utf8')
  .replace(/:global\(([^)]+)\)/g, '$1');

function fixture(low, moving, labels = true, level = low ? 0 : 4) {
  const dom = new JSDOM(`<div class="container" data-show-labels="${labels}">
    <svg class="stage ${moving ? 'is-interacting' : ''} ${low ? 'is-low-detail' : ''}">
      <g class="structure"><text id="landmark" class="landmark">Lobby</text><text id="annotation" class="annotations">AED</text></g>
      <g id="viewport-matrix" data-label-level="${level}" class="viewport ${low ? 'is-low-detail' : ''}">
        <g class="detail">
          <g class="labels" data-label-tier="0"><text id="major" class="mainLabel">100</text><text id="majorCompany" class="mainLabel">Largest company</text></g>
          ${[1, 2, 3].map(tier => `<g class="labels" data-label-tier="${tier}"><text id="tier${tier}" class="mainLabel">Company ${tier}</text></g>`).join('')}
          <g class="labels" data-label-tier="4"><text id="minor" class="mainLabel">101</text><text id="company" class="booth-company-name mainLabel">Company</text></g>
        </g>
      </g>
    </svg></div>`);
  const style = dom.window.document.createElement('style');
  style.textContent = css; dom.window.document.head.append(style);
  const visible = (id) => {
    for (let node = dom.window.document.getElementById(id); node; node = node.parentElement) {
      if (dom.window.getComputedStyle(node).display === 'none') return false;
    }
    return true;
  };
  return { visible, close: () => dom.window.close() };
}

test('close zoom shows company names and numbers while moving and idle', () => {
  for (const moving of [false, true]) {
    const f = fixture(false, moving);
    try { for (const id of ['major', 'minor', 'company']) assert.equal(f.visible(id), true, `${id}, moving=${moving}`); }
    finally { f.close(); }
  }
});

test('overview keeps major numbers and culls fine labels while moving and idle', () => {
  for (const moving of [false, true]) {
    const f = fixture(true, moving);
    try {
      assert.equal(f.visible('major'), true);
      assert.equal(f.visible('majorCompany'), true);
      for (const id of ['minor', 'company']) assert.equal(f.visible(id), false, id);
    } finally { f.close(); }
  }
});

test('labels reveal cumulatively by booth size at five zoom levels, including during movement', () => {
  for (let level = 0; level <= 4; level++) for (const moving of [false, true]) {
    const f = fixture(level === 0, moving, true, level);
    try {
      assert.equal(f.visible('majorCompany'), true);
      for (let tier = 1; tier <= 3; tier++) assert.equal(f.visible(`tier${tier}`), tier <= level);
      assert.equal(f.visible('company'), level === 4);
    } finally { f.close(); }
  }
});

test('Labels off hides company names and all booth numbers', () => {
  const f = fixture(false, true, false);
  try {
    for (const id of ['major', 'minor', 'company']) assert.equal(f.visible(id), false, id);
  } finally { f.close(); }
});

test('major landmarks remain visible independently of annotation LOD and movement', () => {
  for (const low of [false, true]) for (const moving of [false, true]) {
    const f = fixture(low, moving);
    try {
      assert.equal(f.visible('landmark'), true);
      assert.equal(f.visible('annotation'), !low && !moving);
    } finally { f.close(); }
  }
});

test('overview CSS suppresses over 60% of booth rectangles/text elements in both actual datasets', () => {
  const source = JSON.parse(readFileSync(new URL('../public/data/booths.json', import.meta.url), 'utf8'));
  for (const area of ['main', 'interview']) {
    const { booths } = selectFloorplanArea(source, area);
    const dom = new JSDOM(`<svg class="stage is-low-detail"><g id="viewport-matrix" class="viewport is-low-detail">${booths.map(() => '<rect class="booth-shape"/>').join('')}</g><g class="viewport labelViewport is-low-detail" data-label-level="0">${booths.map(booth => `<g class="labels" data-label-tier="${boothLabelTier(getBounds(booth.polygons))}"><text>Number</text><text>Company</text></g>`).join('')}</g></svg>`);
    try {
      const style = dom.window.document.createElement('style'); style.textContent = css; dom.window.document.head.append(style);
      const labels = [...dom.window.document.querySelectorAll('.labels')];
      const hidden = labels.filter(node => dom.window.getComputedStyle(node).display === 'none').length;
      // Each real booth renders one rectangle and two text elements. Additional
      // tspans are excluded; this measures CSS suppression, not GPU frame time.
      const reduction = hidden * 2 / (booths.length * 3);
      assert.ok(reduction > 0.6, `${area}: ${(reduction * 100).toFixed(1)}%`);
      console.info(`${area}: ${booths.length} rectangles retained; ${hidden * 2} of ${booths.length * 2} label text elements hidden (${(reduction * 100).toFixed(1)}% of booth paint elements).`);
    } finally { dom.window.close(); }
  }
});
