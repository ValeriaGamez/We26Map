import type { Bounds, FloorplanData, Point } from "./floorplan-types";

export type FloorplanArea = "main" | "interview";
function boundsOf(polygons: Point[][]): Bounds {
  const points = polygons.flat(), xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function insidePolygon([x, y]: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) < 1e-7 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** Split from official region geometry, not company name or booth-number ranges. */
export function selectFloorplanArea(data: FloorplanData, area: FloorplanArea): FloorplanData {
  const interviewRegions = data.hallStructure?.regions.filter((region) => /\binterview\b/i.test(region.name)) ?? [];
  const polygons = interviewRegions.flatMap((region) => region.polygons);
  if (!polygons.length) throw new Error("The official interview region is missing; the map cannot be split reliably.");
  const interviewBounds = boundsOf(polygons);
  const booths = data.booths.filter((booth) => {
    const bounds = boundsOf(booth.polygons);
    const interview = polygons.some((polygon) => insidePolygon([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], polygon));
    return area === "interview" ? interview : !interview;
  });
  if (!booths.length) throw new Error(`No ${area} booths were found in the source map.`);
  const ids = new Set(booths.map((booth) => booth.id));
  const companies = data.companies.map((company) => ({ ...company, boothIds: company.boothIds.filter((id) => ids.has(id)) })).filter((company) => company.boothIds.length);
  const boothBounds = boundsOf(booths.flatMap((booth) => booth.polygons));
  // WE26's official interview region is the upper hall band. Keep the original
  // image coordinate system and clip its unrelated hall portion, never stretch it.
  const sourceBounds = data.hallStructure?.backdrop?.bounds ?? data.bounds;
  const splitY = interviewBounds.y + interviewBounds.height;
  const clipY = area === "interview" ? sourceBounds.y : splitY;
  const clipBottom = area === "interview" ? splitY : sourceBounds.y + sourceBounds.height;
  const areaClip = { x: sourceBounds.x, y: clipY, width: sourceBounds.width, height: clipBottom - clipY };
  if (areaClip.height <= 0 || booths.some((booth) => booth.polygons.flat().some((point) => point[1] < clipY - 1e-5 || point[1] > clipBottom + 1e-5))) throw new Error("Source geometry no longer supports the WE26 upper/lower hall split.");
  const regions = area === "interview" ? interviewRegions : data.hallStructure?.regions.filter((region) => !interviewRegions.includes(region)) ?? [];
  const labels = data.hallStructure?.labels.filter((label) => label.y >= clipY && label.y <= clipBottom) ?? [];
  return { ...data, bounds: boothBounds, booths, companies, area, areaClip, hallStructure: data.hallStructure ? { ...data.hallStructure, regions, labels } : undefined };
}
