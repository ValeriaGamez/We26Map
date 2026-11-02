import type { Bounds, Point, Transform } from "./floorplan-types";

export function getBounds(polygons: Point[][]): Bounds {
  const points = polygons.flat();
  const x = Math.min(...points.map((p) => p[0]));
  const y = Math.min(...points.map((p) => p[1]));
  return { x, y, width: Math.max(...points.map((p) => p[0])) - x, height: Math.max(...points.map((p) => p[1])) - y };
}

export function unionBounds(boxes: Bounds[]): Bounds {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

export function fitTransform(bounds: Bounds, width: number, height: number, padding = 24): Transform {
  const scale = Math.min(Math.max(1, width - 2 * padding) / Math.max(0.001, bounds.width), Math.max(1, height - 2 * padding) / Math.max(0.001, bounds.height));
  return { x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: (height - bounds.height * scale) / 2 - bounds.y * scale, scale };
}

/** Keep the same floor coordinate under the screen-space zoom anchor. */
export function zoomAt(current: Transform, factor: number, anchor: Point, min: number, max: number): Transform {
  const scale = Math.max(min, Math.min(max, current.scale * factor));
  const ratio = scale / current.scale;
  return { x: anchor[0] - (anchor[0] - current.x) * ratio, y: anchor[1] - (anchor[1] - current.y) * ratio, scale };
}

export function safeImageUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; }
  catch { return undefined; }
}

export function validateFloorplan(value: unknown): asserts value is import("./floorplan-types").FloorplanData {
  const data = value as import("./floorplan-types").FloorplanData;
  if (!data || data.schemaVersion !== 1 || data.units !== "ft" || !Array.isArray(data.booths) || !data.booths.length || !Array.isArray(data.companies) || !data.bounds || ![data.bounds.x, data.bounds.y, data.bounds.width, data.bounds.height].every(Number.isFinite) || data.bounds.width <= 0 || data.bounds.height <= 0) throw new Error("Invalid floor-plan snapshot.");
  const companies = new Map(data.companies.map((company) => [company.id, company]));
  const booths = new Map(data.booths.map((booth) => [booth.id, booth]));
  if (companies.size !== data.companies.length || booths.size !== data.booths.length) throw new Error("Duplicate map identifiers.");
  for (const booth of data.booths) {
    if (!booth.id || !booth.number || !Array.isArray(booth.polygons) || !booth.polygons.length || booth.polygons.some((polygon) => !Array.isArray(polygon) || polygon.length < 3 || polygon.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)))) throw new Error("Invalid booth geometry.");
    if (booth.companyId && !companies.get(booth.companyId)?.boothIds.includes(booth.id)) throw new Error("Missing company-to-booth assignment.");
  }
  for (const company of data.companies) {
    if (!company.name || !Array.isArray(company.boothIds) || !company.boothIds.length || company.boothIds.some((id) => booths.get(id)?.companyId !== company.id)) throw new Error("Invalid company booth list.");
  }
}
