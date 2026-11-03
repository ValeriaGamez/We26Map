import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPolygon, inferScale, makeDecoder, normalizeFloorplan } from './ingest-floorplan.js';

const square = (x, y, size = 100) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
const fixture = () => {
  const booths = Array.from({ length: 4 }, (_, i) => ({ boothNumber: `${100 + i}`, boothIndex: `${i}`, dimSqFt: "10' x 10'", geometry: [{ corners: square(1000 + i * 150, 2000) }] }));
  const exhibitors = booths.slice(0, 2).map((booth) => ({ boothNumber: booth.boothNumber, boothIndex: booth.boothIndex, customerId: 'same-company', displayName: 'Example Company' }));
  return [{ booths }, { exhibitors }, { bDataEncrypted: false }];
};
test('calibrates using square 10x10 booths and excludes other sizes', () => {
  const [geometry] = fixture();
  geometry.booths.push({ dimSqFt: "20' x 20'", geometry: [{ corners: square(0, 0, 900) }] });
  assert.equal(inferScale(geometry.booths).unitsPerFoot, 10);
  assert.throws(() => inferScale(geometry.booths.slice(0, 2)), /at least three/);
});
test('rejects mixed drawing scales instead of silently distorting booth sizes', () => {
  const [geometry] = fixture();
  geometry.booths[0].geometry[0].corners = square(0, 0, 200);
  assert.throws(() => inferScale(geometry.booths), /Inconsistent source scale/);
});
test('cleans duplicate vertices and rejects invalid geometry', () => {
  const corners = square(0, 0);
  assert.equal(cleanPolygon([...corners, corners[0], corners[0]]).length, 4);
  assert.throws(() => cleanPolygon([{ x: 0, y: 0 }, { x: Infinity, y: 0 }, { x: 1, y: 1 }]), /Invalid/);
  assert.throws(() => cleanPolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]), /Degenerate/);
});
test('preserves multiple spaces, unassigned booths, and local feet coordinates', () => {
  const data = normalizeFloorplan(...fixture(), '', '2026-11-01T00:00:00Z');
  assert.equal(data.booths.length, 4);
  assert.equal(data.companies.length, 1);
  assert.deepEqual(data.companies[0].boothIds, ['we26-100', 'we26-101']);
  assert.deepEqual(data.booths[0].polygons[0], [[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(data.booths[2].companyId, null);
  assert.equal(data.booths[0].spaceType, 'unclassified');
  assert.equal(data.booths[0].status, 'rented');
  assert.equal(data.booths[2].status, 'available');
  assert.deepEqual(data.booths[0].bounds, { x: 0, y: 0, width: 10, height: 10 });
});

test('uses the curated careers URL for every company booth and rejects unsafe links', () => {
  const data = normalizeFloorplan(...fixture(), '', 'test', [], { 'same-company': 'https://example.com/careers' });
  assert.equal(data.companies[0].url, 'https://example.com/careers');
  assert.equal(data.booths[0].url, data.companies[0].url);
  assert.equal(data.booths[1].url, data.companies[0].url);
  assert.equal(data.booths[2].url, null);
  for (const item of [...data.companies, ...data.booths]) assert.ok(!Object.hasOwn(item, 'logoUrl'));
  assert.equal(normalizeFloorplan(...fixture(), '', 'test').companies[0].url, null);
  for (const url of ['javascript:alert(1)', '/careers', 'https://user:password@example.com']) assert.throws(() => normalizeFloorplan(...fixture(), '', 'test', [], { 'same-company': url }), /Invalid careers URL/);
});
test('converts venue labels and imagery with the same origin and scale as booths', () => {
  const args = fixture();
  args[0].Extent = { x: 3000, y: 4000 };
  const data = normalizeFloorplan(...args, '', 'test', [{ X: 1100, Y: 2100, text: 'EXIT', size: 20, rotationRads: '0' }]);
  assert.deepEqual(data.hallStructure.backdrop.bounds, { x: -100, y: -200, width: 300, height: 400 });
  assert.deepEqual(data.hallStructure.labels[0], { x: 10, y: 10, text: 'EXIT', size: 2, rotation: 0 });
});
test('retains every irregular source vertex to sub-microfoot precision', () => {
  const args = fixture();
  args[0].booths[3].dimSqFt = "20' x 20'";
  const corners = [{ x: 1450.25, y: 2000.75 }, { x: 1650.25, y: 2000.75 }, { x: 1650.25, y: 2040.75 }, { x: 1490.25, y: 2040.75 }, { x: 1490.25, y: 2200.75 }, { x: 1450.25, y: 2200.75 }];
  args[0].booths[3].geometry[0].corners = corners;
  const data = normalizeFloorplan(...args, '');
  const polygon = data.booths[3].polygons[0];
  assert.equal(polygon.length, corners.length);
  corners.forEach((point, index) => {
    assert.ok(Math.abs(polygon[index][0] - (point.x - 1000) / 10) <= 0.0000005);
    assert.ok(Math.abs(polygon[index][1] - (point.y - 2000) / 10) <= 0.0000005);
  });
});
test('groups queue-name variants by company ID without merging their polygons', () => {
  const args = fixture();
  args[1].exhibitors[0].displayName = 'Example Company - Line Space';
  const data = normalizeFloorplan(...args, '');
  assert.equal(data.companies[0].name, 'Example Company');
  assert.deepEqual(data.companies[0].aliases, ['Example Company - Line Space']);
  assert.equal(data.booths[0].spaceType, 'queue');
  assert.equal(data.booths[0].spaceLabel, 'Example Company - Line Space');
  assert.equal(data.booths[1].spaceType, 'unclassified');
});
test('rejects orphan assignments, mismatched numbers, and duplicate booth numbers', () => {
  const args = fixture();
  args[1].exhibitors[0].boothNumber = 'wrong';
  assert.throws(() => normalizeFloorplan(...args, ''), /mismatch/);
  args[1].exhibitors[0].boothNumber = '100';
  args[1].exhibitors[0].boothIndex = 'missing';
  assert.throws(() => normalizeFloorplan(...args, ''), /no matching geometry/);
  const duplicate = fixture();
  duplicate[0].booths[1].boothNumber = '100';
  assert.throws(() => normalizeFloorplan(...duplicate, ''), /duplicate booth/);
});
test('decodes public-viewer text without evaluating remote scripts', () => {
  const key = 'abcdefghijklmnopqrstuvw', text = 'Acme & Co';
  const encoded = [...text].map((char, i) => char.charCodeAt(0) + i).join(',');
  assert.equal(makeDecoder(`contactEmail:"${key}"`, true)(encoded), text);
  assert.throws(() => makeDecoder('changed format', true), /format changed/);
});
