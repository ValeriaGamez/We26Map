import type { Bounds } from "./floorplan-types";

/** Booth-size tiers, with tolerance for EXPOCAD drawing-unit conversion. */
export function boothLabelTier(bounds: Bounds) {
  const area = bounds.width * bounds.height;
  return area >= 900 * 0.995 ? 0 : area >= 600 * 0.995 ? 1 : area >= 400 * 0.995 ? 2 : area >= 200 * 0.995 ? 3 : 4;
}
