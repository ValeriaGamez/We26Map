export type Point = [number, number];
export type Bounds = { x: number; y: number; width: number; height: number };
export type Transform = { x: number; y: number; scale: number };
export type Company = { id: string; name: string; aliases: string[]; boothIds: string[]; logoUrl?: string | null };
export type Booth = {
  id: string;
  number: string;
  companyId: string | null;
  status?: "rented" | "available" | "held";
  bounds?: Bounds;
  polygons: Point[][];
  logoUrl?: string | null;
  spaceType: string;
  spaceLabel?: string;
};
export type StructuralLabel = { x: number; y: number; text: string; size: number; rotation: number };
export type FloorplanData = {
  area?: "main" | "interview";
  areaClip?: Bounds;
  schemaVersion: number;
  units: string;
  bounds: Bounds;
  source: { lastSaved: string | null };
  companies: Company[];
  booths: Booth[];
  hallStructure?: {
    backdrop: { href: string; sourceUrl?: string; bounds: Bounds } | null;
    labels: StructuralLabel[];
    regions: { name: string; polygons: Point[][] }[];
  };
};
