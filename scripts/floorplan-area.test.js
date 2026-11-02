import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insidePolygon, selectFloorplanArea } from '../src/lib/floorplan-area.ts';

const data = JSON.parse(readFileSync(new URL('../public/data/booths.json', import.meta.url), 'utf8'));
test('official interview region partitions every booth once with unchanged geometry', () => {
  const main = selectFloorplanArea(data, 'main'), interview = selectFloorplanArea(data, 'interview');
  const mainIds = new Set(main.booths.map((booth) => booth.id));
  assert.ok(main.booths.length > 0 && interview.booths.length > 0);
  assert.equal(main.booths.length + interview.booths.length, data.booths.length);
  assert.ok(interview.booths.every((booth) => !mainIds.has(booth.id)));
  for (const booth of [...main.booths, ...interview.booths]) assert.equal(booth, data.booths.find((item) => item.id === booth.id));
  console.log(`Map split: ${main.booths.length} main booths; ${interview.booths.length} interview booths.`);
});
test('company search lists and multi-location details contain only booths in that view', () => {
  for (const area of ['main', 'interview']) {
    const selected = selectFloorplanArea(data, area), ids = new Set(selected.booths.map((booth) => booth.id));
    for (const company of selected.companies) {
      assert.ok(company.boothIds.length > 0);
      assert.ok(company.boothIds.every((id) => ids.has(id)));
    }
  }
  const main = selectFloorplanArea(data, 'main'), interview = selectFloorplanArea(data, 'interview');
  const shared = main.companies.find((company) => interview.companies.some((item) => item.id === company.id));
  assert.ok(shared, 'Expected an exhibitor with locations in both areas.');
  assert.ok(!shared.boothIds.some((id) => interview.companies.find((item) => item.id === shared.id).boothIds.includes(id)));
});
test('backdrop clipping and structural labels stay inside the selected hall band', () => {
  const before = JSON.stringify(data);
  for (const area of ['main', 'interview']) {
    const selected = selectFloorplanArea(data, area), clip = selected.areaClip;
    assert.ok(selected.hallStructure.labels.every((label) => label.y >= clip.y && label.y <= clip.y + clip.height));
    assert.ok(selected.booths.every((booth) => booth.polygons.flat().every((point) => point[1] >= clip.y - 1e-5 && point[1] <= clip.y + clip.height + 1e-5)));
  }
  assert.equal(JSON.stringify(data), before);
});
test('classification uses source polygons and refuses to guess without interview geometry', () => {
  assert.ok(insidePolygon([5, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.ok(!insidePolygon([15, 5], [[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.throws(() => selectFloorplanArea({ ...data, hallStructure: { ...data.hallStructure, regions: [] } }, 'interview'), /region is missing/);
});
