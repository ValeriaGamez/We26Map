import type { Booth, Company } from "./floorplan-types";

/** A front-to-back booth-column checklist, not obstacle-aware pathfinding.
 * WE26's main entrance is on the high-Y side of the source floor plan. */
export function walkingOrder(companies: Company[], booths: Booth[]) {
  const positions = new Map(booths.map(booth => {
    const points = booth.polygons.flat();
    const left = Math.min(...points.map(point => point[0]));
    const front = Math.max(...points.map(point => point[1]));
    return [booth.id, { left, front, queue: booth.spaceType === "queue" }];
  }));
  const representative = (company: Company) => company.boothIds.map(id => positions.get(id)).filter(item => !!item)
    .sort((a, b) => Number(a.queue) - Number(b.queue) || b.front - a.front || a.left - b.left)[0];
  return companies.map(company => ({ company, position: representative(company) }))
    .sort((a, b) => {
      if (!a.position) return b.position ? 1 : a.company.name.localeCompare(b.company.name);
      if (!b.position) return -1;
      return Math.round(a.position.left / 20) - Math.round(b.position.left / 20) || b.position.front - a.position.front || a.company.name.localeCompare(b.company.name);
    }).map(item => item.company);
}
