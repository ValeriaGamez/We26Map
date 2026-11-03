import type { Bounds } from "./floorplan-types";
import type { FloorplanArea } from "./floorplan-area";

/** Booth-size tiers, with tolerance for EXPOCAD drawing-unit conversion. */
export function boothLabelTier(bounds: Bounds, floorplanArea: FloorplanArea = "main") {
  const area = bounds.width * bounds.height;
  const tier = area >= 900 * 0.995 ? 0 : area >= 600 * 0.995 ? 1 : area >= 400 * 0.995 ? 2 : area >= 200 * 0.995 ? 3 : 4;
  // The interview view frames a smaller area, so its small booths are readable
  // much sooner: reveal every label by level 1 (1.8x zoom).
  return floorplanArea === "interview" ? Math.max(0, tier - 3) : tier;
}
