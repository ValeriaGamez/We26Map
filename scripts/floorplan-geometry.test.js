import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fitTransform, getBounds, safeCareerUrl, safeImageUrl, validateFloorplan, zoomAt } from '../src/lib/floorplan-geometry.ts';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);

test('fits nonzero-origin geometry in portrait and landscape viewports', () => {
  const box = { x: -170, y: 30, width: 420, height: 910 };
  for (const [width, height] of [[390, 550], [1200, 800]]) {
    const transform = fitTransform(box, width, height, 24);
    close((box.x + box.width / 2) * transform.scale + transform.x, width / 2);
    close((box.y + box.height / 2) * transform.scale + transform.y, height / 2);
    assert.ok(box.width * transform.scale <= width - 48 + 1e-8);
    assert.ok(box.height * transform.scale <= height - 48 + 1e-8);
  }
});
test('wheel/pinch zoom keeps the source coordinate under its anchor, including clamping', () => {
  const camera = { x: -700, y: 230, scale: 2 };
  const anchor = [137, 409];
  for (const factor of [0.01, 0.8, 1.3, 100]) {
    const next = zoomAt(camera, factor, anchor, 0.5, 8);
    close((anchor[0] - camera.x) / camera.scale, (anchor[0] - next.x) / next.scale);
    close((anchor[1] - camera.y) / camera.scale, (anchor[1] - next.y) / next.scale);
    assert.ok(next.scale >= 0.5 && next.scale <= 8);
  }
});
test('preserves irregular and multi-part polygons when computing display bounds', () => {
  const polygons = [[[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]], [[20, 20], [25, 20], [20, 25]]];
  const before = JSON.stringify(polygons);
  assert.deepEqual(getBounds(polygons), { x: 0, y: 0, width: 25, height: 25 });
  assert.equal(JSON.stringify(polygons), before);
});
test('only permits ordinary local or HTTP(S) image URLs', () => {
  assert.equal(safeImageUrl('/data/logo.png'), '/data/logo.png');
  assert.equal(safeImageUrl('https://example.com/logo.png'), 'https://example.com/logo.png');
  assert.equal(safeImageUrl('javascript:alert(1)'), undefined);
  assert.equal(safeImageUrl('//untrusted.example/logo.png'), undefined);
});

test('careers links accept only absolute web URLs without embedded credentials', () => {
  assert.equal(safeCareerUrl('https://example.com/careers'), 'https://example.com/careers');
  for (const url of [null, '', '/careers', '//example.com/jobs', 'javascript:alert(1)', 'data:text/html,bad', 'https://name:secret@example.com']) assert.equal(safeCareerUrl(url), undefined);
});
test('generated snapshot maps every assigned booth and has aligned structural assets', () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/booths.json', import.meta.url), 'utf8'));
  validateFloorplan(data);
  for (const booth of data.booths) {
    const bounds = getBounds(booth.polygons);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds[key] - booth.bounds[key]) <= 0.000002);
    assert.ok(['rented', 'held', 'available'].includes(booth.status));
    assert.ok(!Object.hasOwn(booth, 'logoUrl'));
    const company = data.companies.find(company => company.id === booth.companyId);
    assert.equal(booth.url, company?.url ?? null);
    if (booth.url) assert.ok(['https:', 'http:'].includes(new URL(booth.url).protocol));
  }
  const backdrop = data.hallStructure.backdrop;
  assert.ok(existsSync(new URL(`../public${backdrop.href}`, import.meta.url)));
  close(backdrop.bounds.width / backdrop.bounds.height, 17280 / 11112);
  assert.ok(data.hallStructure.labels.some((label) => /exit/i.test(label.text)));
  const broken = structuredClone(data);
  broken.booths.find((booth) => booth.companyId).companyId = 'missing';
  assert.throws(() => validateFloorplan(broken), /assignment/);
});
