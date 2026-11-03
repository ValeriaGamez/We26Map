# Walking directions

Directions run entirely in the browser. The Route tab remains the saved-company
checklist. A separate **Directions here** action targets the exact selected booth.
Users place a pin inside a mapped booth or within 24 CSS pixels of an aisle.
Aisle pins snap to the centerline. Booth pins stay at the clicked position and
connect through that booth's mapped access point. The approximate distance
includes this interior path, which stays within the booth polygon and avoids
other booths. Disconnected booth parts without a path to the access point cannot
be used as a start.
Dijkstra uses geometric segment lengths in the floor plan's estimated feet.

## Current network status

`public/data/routing-main.json` is a **geometry-generated, unreviewed draft**.
It connects all 297 occupied, non-queue Main Floor booths and passes polygon
collision, intersection, connectivity, coverage, and schema checks. It does **not**
establish that the paths avoid venue walls, pillars, or restricted areas, or that
every proposed access is on the public-facing side of a booth. Those features are
not provided as walkability geometry by the source data. Public directions and
release export require the automatic checks to pass. Individual human reviews
are optional; their flags are preserved without being marked complete in bulk.

## Author and review

1. Run `npm run dev` and open `http://localhost:3000/dev/routing`.
   This page returns 404 in production.
2. Orange segments are unreviewed; green segments are reviewed. Select a segment
   to check it against the venue plan. Delete or move paths crossing walls,
   pillars, or restricted space, and trace verified aisle centers instead.
3. **Add** creates a node, or splits an existing aisle when clicked within 10 CSS
   pixels. **Connect** takes two aisle-node clicks and automatically splits
   crossings into shared intersections. **Move** operates on the selected node;
   its incident segments lose their optional review flags. **Select** also works through the
   node and connection dropdowns. Arrow keys move the map crosshair; Enter applies
   the current tool; Escape returns to Select. Drag and pinch still pan/zoom.
4. To attach/reposition a booth access, select an aisle segment, choose a booth,
   choose **Attach**, and tap its public-facing boundary. The editor projects the
   access onto that boundary and splits the aisle at its connection. Confirm the
   access review separately if desired. Booth access nodes must have one connection.
5. Choose a destination and **Preview**, then tap near an aisle to test a draft
   route. Verify representative routes across the hall and around obstacles.
6. Changes autosave to this browser's developer draft storage. **Undo** retains
   the most recent 100 changes. **Export draft** and **Import routing JSON** provide
   portable backups; editor storage is separate from user saves and notes.
7. Resolve any automatic validation errors. Individual reviews are optional.
   **Export release** becomes available when the automatic checks pass. Replace
   `public/data/routing-main.json` with the exported file and run
   `npm run check:routing` before publishing.

## Validation commands

- `npm run test:routing`: algorithm, geometry, editor operations, directions UI,
  displayed-camera coordinate inversion, and drag suppression.
- `npm run test:floorplan`: existing map and saved-company regressions.
- `npm run check:routing`: structural, geometry, coverage, and connectivity checks.
  Optional human review flags never block it. The existing `--draft` argument
  remains accepted and runs the same checks.
- `npm run build`: production build; the editor is not publicly available.

`scripts/seed-routing.mjs` is a one-time authoring aid. Running it without arguments
reports a regenerated draft; `--write` writes only when no routing file exists. It
never overwrites an authored network. It does not infer walls or approve paths.

## Data and integration

The version-1 graph stores Main Floor coordinates, nodes, undirected connections,
review flags, and a deterministic geometry/occupancy key. Weights are calculated,
not stored. Floor-plan geometry or occupancy changes invalidate the graph and
disable directions until the network is updated. The editor preserves a stale
import's key and reports the mismatch rather than silently approving it.

`routing.ts` provides validation, segment snapping, temporary edge splitting, and
min-heap Dijkstra. `routing-editor.ts` provides immutable authoring operations.
Temporary starting nodes never modify the source graph. Booth nodes cannot be
used as intermediate shortcuts. `use-booth-directions.ts` loads and validates a
network once per loaded map and owns session-only start/destination state.
`FloorPlan` renders the route independently of label detail and exposes point
placement through the displayed camera's coordinate transform.

Interviews, cross-map paths, live location, crowd avoidance, and accessible-route
profiles are not included. Changing map pages clears the current route.
