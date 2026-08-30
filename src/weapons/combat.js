// Shared ballistics: one code path resolves shots for the player and the AI,
// so bots are held to exactly the same rules the player is.

import { rayCapsule } from '../world/physics.js';
import { damageAtRange } from './defs.js';
import { gauss, clamp } from '../core/math.js';

export const HITZONE = { HEAD: 'head', BODY: 'body', LIMB: 'limb' };

/**
 * @param {object} p
 *   world      CollisionWorld
 *   entities   array of damageable characters
 *   origin     {x,y,z}
 *   dir        normalised {x,y,z}
 *   def        weapon definition
 *   shooter    entity firing (excluded from hits)
 *   maxDist    override range
 *   friendlyFire whether teammates can be hit
 * @returns {{ hits: Array, endPoint: {x,y,z}, wallHit: object|null }}
 */
export function traceShot({ world, entities, origin, dir, def, shooter, maxDist = 220, friendlyFire = false, teamDamage = false }) {
  const hits = [];
  let ox = origin.x, oy = origin.y, oz = origin.z;
  let remaining = maxDist;
  let penetrationLeft = def.penetration ?? 0;
  let damageScale = 1;
  let travelled = 0;
  let endPoint = { x: ox + dir.x * maxDist, y: oy + dir.y * maxDist, z: oz + dir.z * maxDist };
  let wallHit = null;
  const alreadyHit = new Set();

  // Bounded loop: each iteration either terminates or consumes a penetration.
  for (let pass = 0; pass < 4 && remaining > 0.01; pass++) {
    const worldHit = world.raycast(ox, oy, oz, dir.x, dir.y, dir.z, remaining, 'bullet');
    const wallDist = worldHit ? worldHit.dist : remaining;

    // Nearest character in front of the wall.
    let best = null;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e.alive || e === shooter || alreadyHit.has(e)) continue;
      if (!friendlyFire && !teamDamage && shooter && e.team === shooter.team) continue;
      const half = e.height * 0.5;
      const hit = rayCapsule(
        ox, oy, oz, dir.x, dir.y, dir.z,
        e.pos.x, e.pos.y + half, e.pos.z,
        half, e.radius, Math.min(wallDist, remaining),
      );
      if (hit && (!best || hit.dist < best.dist)) { best = hit; best.entity = e; }
    }

    if (best) {
      const e = best.entity;
      alreadyHit.add(e);
      const zone = hitZoneFor(e, best.localY);
      const dist = travelled + best.dist;
      let dmg = damageAtRange(def.damage, dist) * damageScale;
      if (zone === HITZONE.HEAD) dmg *= def.headshotMul ?? 1;
      else if (zone === HITZONE.LIMB) dmg *= def.limbMul ?? 1;
      hits.push({ entity: e, point: best.point, normal: best.normal, zone, damage: dmg, distance: dist, dir });
      endPoint = best.point;

      // Bullets stop in bodies unless the weapon punches through.
      if (penetrationLeft < 2) { return { hits, endPoint, wallHit: null }; }
      penetrationLeft -= 1;
      damageScale *= 0.6;
      travelled += best.dist + 0.35;
      remaining -= best.dist + 0.35;
      ox = best.point.x + dir.x * 0.35;
      oy = best.point.y + dir.y * 0.35;
      oz = best.point.z + dir.z * 0.35;
      continue;
    }

    if (worldHit) {
      endPoint = worldHit.point;
      wallHit = worldHit;
      const brushPen = worldHit.brush.penetration ?? 0;
      if (penetrationLeft > 0 && brushPen > 0 && penetrationLeft >= brushPen) {
        // Punch through: step past the brush and keep going with reduced damage.
        const thickness = estimateThickness(worldHit.brush, dir);
        penetrationLeft -= brushPen;
        damageScale *= Math.max(0.25, 0.72 - thickness * 0.12);
        travelled += worldHit.dist + thickness + 0.05;
        remaining -= worldHit.dist + thickness + 0.05;
        ox = worldHit.point.x + dir.x * (thickness + 0.05);
        oy = worldHit.point.y + dir.y * (thickness + 0.05);
        oz = worldHit.point.z + dir.z * (thickness + 0.05);
        wallHit = worldHit;
        continue;
      }
      return { hits, endPoint, wallHit };
    }
    break;
  }
  return { hits, endPoint, wallHit };
}

function estimateThickness(brush, dir) {
  const sx = brush.max.x - brush.min.x;
  const sy = brush.max.y - brush.min.y;
  const sz = brush.max.z - brush.min.z;
  // Thickness along the dominant travel axis.
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  if (ax >= ay && ax >= az) return sx;
  if (ay >= az) return sy;
  return sz;
}

export function hitZoneFor(entity, localY) {
  const h = entity.height;
  if (localY === undefined) return HITZONE.BODY;
  if (localY > h - 0.28) return HITZONE.HEAD;
  if (localY < h * 0.42) return HITZONE.LIMB;
  return HITZONE.BODY;
}

/**
 * Apply spread and the weapon's spray pattern to an aim direction.
 * `shotIndex` walks the pattern; `spreadDeg` is the random cone on top.
 */
export function applySpread(dir, right, up, spreadDeg, patternX = 0, patternY = 0, out = { x: 0, y: 0, z: 0 }) {
  const rad = spreadDeg * Math.PI / 180;
  // Gaussian spread reads more natural than a uniform disc — most shots land
  // near the centre with an occasional flyer.
  const sx = gauss(0, rad * 0.42) + patternX * Math.PI / 180;
  const sy = gauss(0, rad * 0.42) + patternY * Math.PI / 180;
  out.x = dir.x + right.x * sx + up.x * sy;
  out.y = dir.y + right.y * sx + up.y * sy;
  out.z = dir.z + right.z * sx + up.z * sy;
  const l = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= l; out.y /= l; out.z /= l;
  return out;
}

/** Look up the pattern entry for a shot index, wrapping with jitter at the end. */
export function patternAt(def, shotIndex) {
  const pat = def.pattern;
  if (!pat || !pat.length) return [0, 0];
  if (shotIndex < pat.length) return pat[shotIndex];
  const last = pat[pat.length - 1];
  // Past the end of the learnable pattern, spray goes random — as it should.
  return [last[0] + gauss(0, 0.55), last[1] * 0.75 + gauss(0, 0.2)];
}

/** Explosion damage with line-of-sight falloff. */
export function explosionDamage(world, entities, center, radius, maxDamage, shooter, friendlyFire = true) {
  const out = [];
  for (const e of entities) {
    if (!e.alive) continue;
    const cx = e.pos.x, cy = e.pos.y + e.height * 0.5, cz = e.pos.z;
    const d = Math.hypot(cx - center.x, cy - center.y, cz - center.z);
    if (d > radius) continue;
    if (!friendlyFire && shooter && e.team === shooter.team && e !== shooter) continue;
    // Cover check: a wall between the blast and the target cuts damage hard.
    const exposed = world.lineOfSight(center.x, center.y, center.z, cx, cy, cz) ? 1 : 0.28;
    const falloff = Math.pow(1 - d / radius, 1.6);
    const dmg = maxDamage * falloff * exposed;
    if (dmg > 1) out.push({ entity: e, damage: dmg, distance: d, exposed: exposed === 1 });
  }
  return out;
}

/** Flashbang blindness: full effect looking straight at it, none behind cover. */
export function flashIntensity(world, viewer, forward, center, radius, maxSeconds) {
  const ex = viewer.pos.x, ey = viewer.pos.y + viewer.height * 0.9, ez = viewer.pos.z;
  const dx = center.x - ex, dy = center.y - ey, dz = center.z - ez;
  const d = Math.hypot(dx, dy, dz);
  if (d > radius) return 0;
  if (!world.lineOfSight(ex, ey, ez, center.x, center.y, center.z)) return 0;
  const nd = d > 0 ? { x: dx / d, y: dy / d, z: dz / d } : { x: 0, y: 0, z: 1 };
  const facing = nd.x * forward.x + nd.y * forward.y + nd.z * forward.z;
  // Facing directly = 1, 90 degrees away = ~0.15, behind = 0.
  const angleFactor = facing > 0 ? 0.25 + facing * 0.75 : Math.max(0, 0.25 + facing * 0.5);
  const distFactor = 1 - (d / radius) * 0.65;
  return clamp(maxSeconds * angleFactor * distFactor, 0, maxSeconds);
}
