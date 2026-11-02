import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = 'https://swe.expocad.com';
export const sources = {
  geometry: `${host}/we26/webdrawing?requestedWidth=17280`,
  companies: `${host}/we26/webdrawing/Lists?includeDeleted=false`,
  config: `${host}/we26/webdrawing/Config?requestedWidth=17280`,
  viewer: `${host}/Events/we26/index.html`,
  loader: `${host}/Events/util/expofx-min.js`,
  backdrop: `${host}/Events/we26/we26.png`,
  structuralLabels: `${host}/we26/webdrawing/bldgText?requestedWidth=17280`,
};
const round = (value) => Math.round(value * 1e6) / 1e6;
export function polygonBounds(polygons) {
  const points = polygons.flat();
  const x = Math.min(...points.map((p) => p[0])), y = Math.min(...points.map((p) => p[1]));
  return { x, y, width: round(Math.max(...points.map((p) => p[0])) - x), height: round(Math.max(...points.map((p) => p[1])) - y) };
}
function imageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = new URL(value, sources.viewer);
  return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const first = (value) => Array.isArray(value) ? value[0] : value;

// EXPOCAD's public viewer uses this same display transformation. Never execute
// the downloaded loader or ship its configuration/contact fields to the client.
export function makeDecoder(loader, encrypted) {
  if (!encrypted) return (value) => String(value ?? '').trim();
  const key = loader.match(/contactEmail:"([a-z]{23})"/)?.[1];
  if (!key) throw new Error('Public viewer text format changed: decoding key not found.');
  const offsets = [...key].map((char) => char.charCodeAt(0) - 97);
  return (value) => {
    if (!value) return '';
    const codes = String(value).split(',');
    if (codes.some((code) => !/^\d+$/.test(code))) throw new Error('Unexpected encoded company text.');
    return codes.map((code, index) => String.fromCharCode(Number(code) - offsets[index % offsets.length])).join('').trim();
  };
}

export function cleanPolygon(corners) {
  if (!Array.isArray(corners)) throw new Error('Missing polygon corners.');
  const points = [];
  for (const point of corners) {
    const x = Number(point.x), y = Number(point.y);
    if (point.x == null || point.y == null || String(point.x).trim() === '' || String(point.y).trim() === '' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid polygon coordinate.');
    if (!points.length || points.at(-1)[0] !== x || points.at(-1)[1] !== y) points.push([x, y]);
  }
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  const area = Math.abs(points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  if (points.length < 3 || area < 0.001) throw new Error('Degenerate polygon.');
  return points;
}

export function inferScale(booths) {
  const candidates = [];
  for (const booth of booths) {
    // Only known square 10x10-foot footprints calibrate the drawing. Dimensions
    // from larger, queue, or interview spaces must not influence the estimate.
    if (!/^\s*10\s*['′]\s*[x×]\s*10\s*['′]\s*$/i.test(booth.dimSqFt ?? '')) continue;
    if (booth.geometry?.length !== 1) continue;
    const points = cleanPolygon(booth.geometry[0].corners);
    if (points.length !== 4) continue;
    const edges = points.map((point, i) => Math.hypot(point[0] - points[(i + 1) % 4][0], point[1] - points[(i + 1) % 4][1]));
    const typical = median(edges);
    if (typical <= 0 || edges.some((edge) => Math.abs(edge / typical - 1) > 0.03)) continue;
    // Reject skewed parallelograms even if all edge lengths match.
    const a = [points[1][0] - points[0][0], points[1][1] - points[0][1]];
    const b = [points[2][0] - points[1][0], points[2][1] - points[1][1]];
    if (Math.abs((a[0] * b[0] + a[1] * b[1]) / (edges[0] * edges[1])) > 0.03) continue;
    candidates.push(typical / 10);
  }
  if (candidates.length < 3) throw new Error('Need at least three valid 10x10-foot booths to calibrate scale.');
  const unitsPerFoot = median(candidates);
  const inliers = candidates.filter((value) => Math.abs(value / unitsPerFoot - 1) <= 0.02);
  if (inliers.length / candidates.length < 0.9) throw new Error('Inconsistent source scale across standard booths.');
  return { unitsPerFoot, method: 'median edge length of source-labeled 10x10 ft square booths', calibrationBooths: candidates.length, inlierBooths: inliers.length, tolerancePercent: 2 };
}

export function normalizeFloorplan(rawGeometry, rawLists, rawConfig, loader, fetchedAt = new Date().toISOString(), structuralLabels = []) {
  const geometry = first(rawGeometry), lists = first(rawLists), config = first(rawConfig);
  if (!geometry?.booths?.length || !Array.isArray(lists?.exhibitors)) throw new Error('Unexpected EXPOCAD dataset shape.');
  const decode = makeDecoder(loader, config?.bDataEncrypted);
  const scale = inferScale(geometry.booths);
  const records = geometry.booths.map((booth) => ({ source: booth, polygons: (booth.geometry ?? []).map((shape) => cleanPolygon(shape.corners)) }));
  if (records.some((record) => !record.polygons.length)) throw new Error('Booth missing geometry.');
  const points = records.flatMap((record) => record.polygons.flat());
  const minX = Math.min(...points.map((p) => p[0])), minY = Math.min(...points.map((p) => p[1]));
  const maxX = Math.max(...points.map((p) => p[0])), maxY = Math.max(...points.map((p) => p[1]));
  const toFeet = ([x, y]) => [round((x - minX) / scale.unitsPerFoot), round((y - minY) / scale.unitsPerFoot)];
  const assignments = new Map();
  const namesByCompany = new Map();
  for (const item of lists.exhibitors) {
    if (!item.customerId) continue;
    const index = String(item.boothIndex);
    if (assignments.has(index)) throw new Error(`Multiple assignments for source booth index ${index}.`);
    assignments.set(index, item);
    const name = decode(item.displayName);
    if (!namesByCompany.has(String(item.customerId))) namesByCompany.set(String(item.customerId), new Map());
    const variants = namesByCompany.get(String(item.customerId));
    variants.set(name, (variants.get(name) ?? 0) + 1);
  }
  const companies = new Map(), numbers = new Set();
  const overlays = new Map((geometry.overlays?.eventOverlays ?? []).filter((overlay) => overlay.type === 3 && overlay.boothNum && overlay.img).map((overlay) => [String(overlay.boothNum), imageUrl(overlay.img)]));
  const booths = records.map(({ source, polygons }) => {
    const number = String(source.boothNumber ?? '').trim();
    if (!number || numbers.has(number)) throw new Error(`Missing or duplicate booth number: ${number}`);
    numbers.add(number);
    const assignment = assignments.get(String(source.boothIndex));
    if (assignment && String(assignment.boothNumber) !== number) throw new Error(`Booth index/number mismatch: ${number}`);
    if (assignment) assignments.delete(String(source.boothIndex));
    const companyId = assignment ? String(assignment.customerId) : null;
    const name = assignment ? decode(assignment.displayName) : '';
    if (companyId && !name) throw new Error(`Missing name for assigned booth ${number}.`);
    const id = `we26-${number}`;
    if (companyId) {
      if (!companies.has(companyId)) {
        const variants = [...namesByCompany.get(companyId)].sort((a, b) => {
          const queue = (value) => /\b(queue|line space|line-up)\b/i.test(value);
          return Number(queue(a[0])) - Number(queue(b[0])) || b[1] - a[1] || a[0].localeCompare(b[0]);
        });
        companies.set(companyId, { id: companyId, name: variants[0][0], aliases: variants.slice(1).map(([variant]) => variant), logoUrl: imageUrl(assignment.companyLogo), boothIds: [] });
      }
      companies.get(companyId).boothIds.push(id);
    }
    const feetPolygons = polygons.map((polygon) => polygon.map(toFeet));
    const status = ({ '0': 'available', '1': 'held', '2': 'rented' })[String(source.status)] ?? (companyId ? 'rented' : 'available');
    return { id, number, companyId, status, bounds: polygonBounds(feetPolygons), logoUrl: overlays.get(number) ?? imageUrl(assignment?.companyLogo), ...(companyId && name !== companies.get(companyId).name ? { spaceLabel: name } : {}), spaceType: /\b(queue|line space|line-up)\b/i.test(name) ? 'queue' : 'unclassified', polygons: feetPolygons };
  });
  if (assignments.size) throw new Error(`${assignments.size} company assignments have no matching geometry.`);
  booths.sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
  const sortedCompanies = [...companies.values()].sort((a, b) => a.name.localeCompare(b.name));
  sortedCompanies.forEach((company) => company.boothIds.sort());
  return {
    schemaVersion: 1, event: 'WE26', location: 'Boston', units: 'ft',
    bounds: { x: 0, y: 0, width: round((maxX - minX) / scale.unitsPerFoot), height: round((maxY - minY) / scale.unitsPerFoot) },
    source: { viewer: sources.viewer, geometry: sources.geometry, companies: sources.companies, fetchedAt, lastSaved: config?.lastSaved ?? null },
    calibration: { ...scale, originDrawingUnits: [minX, minY], coordinateAxes: 'source x/y preserved; translated to booth bounds', precisionFeet: 0.000001 },
    hallStructure: {
      backdrop: geometry.Extent ? { href: '/data/venue.png', sourceUrl: sources.backdrop, bounds: { x: round(-minX / scale.unitsPerFoot), y: round(-minY / scale.unitsPerFoot), width: round(Number(geometry.Extent.x) / scale.unitsPerFoot), height: round(Number(geometry.Extent.y) / scale.unitsPerFoot) } } : null,
      labels: structuralLabels.map((label) => {
        const [x, y] = toFeet([Number(label.X), Number(label.Y)]);
        const size = Number(label.size) / scale.unitsPerFoot;
        const rotation = Number(label.rotationRads || 0) * 180 / Math.PI;
        if (![x, y, size, rotation].every(Number.isFinite) || size <= 0) throw new Error('Invalid structural label.');
        return { x, y, text: String(label.text ?? ''), size: round(size), rotation: round(rotation) };
      }),
      regions: (geometry.pavilions ?? []).map((region) => ({ name: String(region.name ?? ''), polygons: (region.geometry ?? []).map((shape) => cleanPolygon(shape.corners).map(toFeet)) })),
    },
    notes: ['Feet are estimated from source-labeled 10x10 ft booths, not surveyed measurements.', 'Separate booth records are retained for multi-space companies. Unclassified spaces may include exhibits or interviews.', 'Queue type is assigned only when explicitly named in source company text. No walking routes are implied.'],
    companies: sortedCompanies, booths,
  };
}

async function request(url, method = 'GET', json = true) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(60000), headers: { Accept: json ? 'application/json' : 'text/javascript' } });
  if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

export async function ingest() {
  const [geometry, lists, config, loader, structuralLabels] = await Promise.all([
    request(sources.geometry), request(sources.companies, 'POST'), request(sources.config), request(sources.loader, 'GET', false), request(sources.structuralLabels),
  ]);
  const output = normalizeFloorplan(geometry, lists, config, loader, new Date().toISOString(), structuralLabels);
  const target = resolve(root, 'public/data/booths.json');
  await mkdir(dirname(target), { recursive: true });
  async function saveImage(url, name) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpeg|webp|gif)(;|$)/i.test(type)) throw new Error(`Unsupported image content type: ${type}`);
    const extension = type.includes('jpeg') ? 'jpg' : type.split('/')[1].split(';')[0].toLowerCase();
    const path = resolve(root, `public/data/${name}.${extension}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, new Uint8Array(await response.arrayBuffer()));
    await rename(`${path}.tmp`, path);
    return `/data/${name}.${extension}`;
  }
  if (output.hallStructure.backdrop) output.hallStructure.backdrop.href = await saveImage(sources.backdrop, 'venue');
  const imageUrls = [...new Set([...output.booths, ...output.companies].map((item) => item.logoUrl).filter(Boolean))];
  const localImages = new Map();
  // Bounded batches keep the public source load low. An unavailable logo falls
  // back to its booth label and cannot prevent the complete map from loading.
  for (let i = 0; i < imageUrls.length; i += 5) {
    await Promise.all(imageUrls.slice(i, i + 5).map(async (url) => {
      try { localImages.set(url, await saveImage(url, `logos/${createHash('sha256').update(url).digest('hex').slice(0, 16)}`)); }
      catch (error) { console.warn(`Skipping unavailable booth image: ${error.message}`); localImages.set(url, null); }
    }));
  }
  for (const item of [...output.booths, ...output.companies]) if (item.logoUrl) item.logoUrl = localImages.get(item.logoUrl) ?? null;
  // Replace only after the entire dataset passes validation. Failed ingestion
  // leaves the previous usable snapshot in place.
  await writeFile(`${target}.tmp`, `${JSON.stringify(output)}\n`, 'utf8');
  await rename(`${target}.tmp`, target);
  console.log(`Saved ${output.booths.length} booths / ${output.companies.length} companies to ${target}`);
  console.log(`Scale: ${output.calibration.unitsPerFoot} drawing units/ft (${output.calibration.calibrationBooths} standard booths).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ingest().catch((error) => { console.error(`Floor-plan ingestion failed: ${error.message}`); process.exitCode = 1; });
}
