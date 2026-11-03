import { readFileSync } from 'node:fs';
import { selectFloorplanArea } from '../src/lib/floorplan-area.ts';
import { parseRoutingGraph, routableBooths, validateRoutingGraph } from '../src/lib/routing.ts';

try {
  const data = selectFloorplanArea(JSON.parse(readFileSync(new URL('../public/data/booths.json', import.meta.url))), 'main');
  const graph = parseRoutingGraph(JSON.parse(readFileSync(new URL('../public/data/routing-main.json', import.meta.url))));
  const report = validateRoutingGraph(graph, data);
  console.log(`${graph.nodes.filter(n => n.boothId).length}/${routableBooths(data).length} booth access points; ${report.errors.length} errors.`);
  for (const error of report.errors.slice(0, 30)) console.error(error);
  if (report.ready) console.log('Automatic checks passed. Walking directions and release export are enabled; individual reviews are optional.');
  if (!report.ready) process.exitCode = 1;
} catch (error) { console.error(String(error)); process.exitCode = 1; }
