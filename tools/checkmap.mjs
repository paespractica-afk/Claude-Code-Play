// Dev tool: validate a map's geometry, connectivity and spawn safety.
import { MapBuilder, buildCollision } from '../src/world/builder.js';
import { CollisionWorld, BodyMover } from '../src/world/physics.js';
import { NavGrid } from '../src/nav/navgrid.js';

export async function checkMap(mapDef, { verbose = true } = {}) {
  const b = new MapBuilder();
  mapDef.build(b);
  const world = new CollisionWorld(6);
  buildCollision(b, world);
  const t0 = Date.now();
  const nav = new NavGrid(world, { cell: 1.2, bounds: mapDef.bounds }).build();
  const navMs = Date.now() - t0;
  const mover = new BodyMover(world);

  const problems = [];

  // Spawns must be standable and above a floor.
  for (const team of ['0', '1']) {
    for (const [i, s] of (b.spawnPoints[team] || []).entries()) {
      if (!mover.fits(s.x, s.y + 0.05, s.z, 0.36, 1.78)) problems.push(`spawn ${team}#${i} is inside geometry`);
      const g = mover.groundAt(s.x, s.y + 1, s.z, 6);
      if (g === null) problems.push(`spawn ${team}#${i} has no floor beneath it`);
      else if (Math.abs(g - s.y) > 1.2) problems.push(`spawn ${team}#${i} floats ${(s.y - g).toFixed(2)}m`);
    }
  }

  // Every spawn must reach every objective and every other spawn.
  const targets = [...b.sites.map((s) => ({ name: `site ${s.id}`, ...s })),
                   ...b.zones.map((z) => ({ name: `zone ${z.id}`, ...z }))];
  const allSpawns = [...(b.spawnPoints[0] || []), ...(b.spawnPoints[1] || [])];
  for (const t of targets) {
    for (const [i, s] of allSpawns.entries()) {
      if (!nav.findPath(s, t)) problems.push(`spawn#${i} cannot reach ${t.name}`);
    }
  }
  // Vertical routes (catwalks, roofs, mezzanines) must be reachable too.
  for (const pr of mapDef.probes || []) {
    const node = nav.nearest(pr.x, pr.y, pr.z, 4);
    if (!node) { problems.push(`probe "${pr.name}" has no nav node`); continue; }
    if (Math.abs(node.y - pr.y) > 1.2) problems.push(`probe "${pr.name}" nearest node is at y=${node.y.toFixed(2)}, expected ~${pr.y}`);
    if (allSpawns.length && !nav.findPath(allSpawns[0], node)) problems.push(`probe "${pr.name}" is unreachable from spawn`);
  }

  if (allSpawns.length > 1) {
    const a = allSpawns[0], z = allSpawns[allSpawns.length - 1];
    if (!nav.findPath(a, z)) problems.push('spawns are not mutually reachable');
  }

  // Dropped islands larger than a closet mean a genuinely disconnected region.
  for (const d of nav.droppedIslands || []) {
    if (d.size >= 18) {
      const bb = d.bounds;
      problems.push(`disconnected region of ${d.size} nodes: x[${bb.minX.toFixed(1)}..${bb.maxX.toFixed(1)}] y[${bb.minY.toFixed(1)}..${bb.maxY.toFixed(1)}] z[${bb.minZ.toFixed(1)}..${bb.maxZ.toFixed(1)}]`);
    }
  }
  const islands = new Set(nav.nodes.map((n) => n.island));

  if (verbose) {
    console.log(`--- ${mapDef.name} ---`);
    console.log(`  boxes ${b.boxes.length}  lights ${b.lights.length}  nav ${nav.nodes.length} nodes (${navMs}ms)  islands ${islands.size} dropped ${(nav.droppedIslands||[]).length}`);
    console.log(`  spawns: T0=${(b.spawnPoints[0] || []).length} T1=${(b.spawnPoints[1] || []).length} ffa=${b.spawnPoints.ffa.length}`);
    console.log(`  sites: ${b.sites.map((s) => s.id).join(', ') || 'none'}  zones: ${b.zones.map((z) => z.id).join(', ') || 'none'}`);
    if (problems.length) problems.forEach((p) => console.log(`  ✗ ${p}`));
    else console.log('  ✓ all checks passed');
  }
  return { builder: b, world, nav, problems };
}

if (process.argv[2]) {
  const mod = await import(`../src/world/maps/${process.argv[2]}.js`);
  const def = Object.values(mod)[0];
  const { problems } = await checkMap(def);
  process.exit(problems.length ? 1 : 0);
}
