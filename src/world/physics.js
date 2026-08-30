// Axis-aligned brush collision world.
//
// Maps are built from boxes (like a classic BSP shooter), which keeps collision
// exact and cheap: no mesh soup, no tunnelling, no "fell through the floor".
// Broadphase is a uniform spatial hash; the ray query walks it with a 3D DDA.

import { clamp } from '../core/math.js';

export const SURFACE = {
  CONCRETE: 'concrete', METAL: 'metal', WOOD: 'wood',
  DIRT: 'dirt', GLASS: 'glass', WATER: 'water', TILE: 'tile', SAND: 'sand',
};

let brushId = 0;

export class Brush {
  constructor(min, max, opts = {}) {
    this.id = brushId++;
    this.min = { x: Math.min(min.x, max.x), y: Math.min(min.y, max.y), z: Math.min(min.z, max.z) };
    this.max = { x: Math.max(min.x, max.x), y: Math.max(min.y, max.y), z: Math.max(min.z, max.z) };
    this.surface = opts.surface || SURFACE.CONCRETE;
    this.solid = opts.solid !== false;        // blocks movement
    this.opaque = opts.opaque !== false;      // blocks line of sight
    this.bulletproof = opts.bulletproof !== false; // blocks bullets
    this.penetration = opts.penetration ?? 0; // 0 = none, 1 = light wallbang, 2 = heavy
    this.climbable = !!opts.climbable;        // ladders
    this.destructible = !!opts.destructible;
    this.health = opts.health ?? 0;
    this.tag = opts.tag || null;
    // Roofs and structural shells are solid but must never host nav nodes.
    this.noNav = !!opts.noNav;
  }
  get sizeX() { return this.max.x - this.min.x; }
  get sizeY() { return this.max.y - this.min.y; }
  get sizeZ() { return this.max.z - this.min.z; }
  contains(x, y, z) {
    return x >= this.min.x && x <= this.max.x && y >= this.min.y && y <= this.max.y && z >= this.min.z && z <= this.max.z;
  }
}

const EPS = 1e-4;

export class CollisionWorld {
  constructor(cellSize = 6) {
    this.cell = cellSize;
    this.grid = new Map();
    this.brushes = [];
    this.bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    this._queryStamp = 0;
    this._stamps = new Map();
  }

  _key(ix, iy, iz) { return `${ix},${iy},${iz}`; }

  add(brush) {
    this.brushes.push(brush);
    const c = this.cell;
    const x0 = Math.floor(brush.min.x / c), x1 = Math.floor(brush.max.x / c);
    const y0 = Math.floor(brush.min.y / c), y1 = Math.floor(brush.max.y / c);
    const z0 = Math.floor(brush.min.z / c), z1 = Math.floor(brush.max.z / c);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const k = this._key(ix, iy, iz);
          let list = this.grid.get(k);
          if (!list) { list = []; this.grid.set(k, list); }
          list.push(brush);
        }
    const b = this.bounds;
    b.min.x = Math.min(b.min.x, brush.min.x); b.max.x = Math.max(b.max.x, brush.max.x);
    b.min.y = Math.min(b.min.y, brush.min.y); b.max.y = Math.max(b.max.y, brush.max.y);
    b.min.z = Math.min(b.min.z, brush.min.z); b.max.z = Math.max(b.max.z, brush.max.z);
    return brush;
  }

  box(min, max, opts) { return this.add(new Brush(min, max, opts)); }

  clear() {
    this.grid.clear();
    this.brushes.length = 0;
    this.bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  }

  /** Collect unique brushes overlapping an AABB. Reuses a stamp map to avoid Set churn. */
  query(min, max, out = []) {
    out.length = 0;
    const c = this.cell;
    const stamp = ++this._queryStamp;
    const x0 = Math.floor(min.x / c), x1 = Math.floor(max.x / c);
    const y0 = Math.floor(min.y / c), y1 = Math.floor(max.y / c);
    const z0 = Math.floor(min.z / c), z1 = Math.floor(max.z / c);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const list = this.grid.get(this._key(ix, iy, iz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (this._stamps.get(b.id) === stamp) continue;
            this._stamps.set(b.id, stamp);
            if (b.max.x < min.x || b.min.x > max.x) continue;
            if (b.max.y < min.y || b.min.y > max.y) continue;
            if (b.max.z < min.z || b.min.z > max.z) continue;
            out.push(b);
          }
        }
    return out;
  }

  /** True if an axis-aligned box overlaps any solid brush. */
  overlapsSolid(min, max, scratch = []) {
    this.query(min, max, scratch);
    for (let i = 0; i < scratch.length; i++) if (scratch[i].solid) return true;
    return false;
  }

  /**
   * Ray query. `mask` decides what stops the ray:
   *   'solid'  — movement blockers
   *   'sight'  — line of sight (opaque brushes)
   *   'bullet' — bulletproof brushes
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 1000, mask = 'solid') {
    // Normalise; a zero-length direction would spin the DDA forever.
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return null;
    dx /= len; dy /= len; dz /= len;

    const c = this.cell;
    let ix = Math.floor(ox / c), iy = Math.floor(oy / c), iz = Math.floor(oz / c);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const invX = dx !== 0 ? 1 / dx : Infinity;
    const invY = dy !== 0 ? 1 / dy : Infinity;
    const invZ = dz !== 0 ? 1 / dz : Infinity;
    const nextBound = (i, step, o, inv) => {
      if (step === 0) return Infinity;
      const edge = (step > 0 ? (i + 1) * c : i * c);
      return (edge - o) * inv;
    };
    let tMaxX = nextBound(ix, stepX, ox, invX);
    let tMaxY = nextBound(iy, stepY, oy, invY);
    let tMaxZ = nextBound(iz, stepZ, oz, invZ);
    const tDeltaX = stepX !== 0 ? Math.abs(c * invX) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(c * invY) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(c * invZ) : Infinity;

    const stamp = ++this._queryStamp;
    let t = 0;
    let best = null;
    let guard = 0;
    const guardMax = 4096;

    while (t <= maxDist && guard++ < guardMax) {
      const list = this.grid.get(this._key(ix, iy, iz));
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (this._stamps.get(b.id) === stamp) continue;
          this._stamps.set(b.id, stamp);
          if (mask === 'solid' && !b.solid) continue;
          if (mask === 'sight' && !b.opaque) continue;
          if (mask === 'bullet' && !b.bulletproof) continue;
          const hit = rayBox(ox, oy, oz, dx, dy, dz, b, maxDist);
          if (hit && (!best || hit.dist < best.dist)) { hit.brush = b; best = hit; }
        }
      }
      // A hit inside the current cell can still be beaten by a nearer brush in
      // a cell we already entered, so only stop once we pass the cell exit.
      const tExit = Math.min(tMaxX, tMaxY, tMaxZ);
      if (best && best.dist <= tExit) break;

      if (tMaxX < tMaxY && tMaxX < tMaxZ) { ix += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else if (tMaxY < tMaxZ) { iy += stepY; t = tMaxY; tMaxY += tDeltaY; }
      else { iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
      if (t > maxDist) break;
    }
    return best;
  }

  /** Convenience: is there a clear line between two points? */
  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    const hit = this.raycast(ax, ay, az, dx, dy, dz, d - 0.02, 'sight');
    return !hit;
  }
}

/** Slab intersection of a ray against a brush. Returns nearest entry hit. */
export function rayBox(ox, oy, oz, dx, dy, dz, b, maxDist) {
  let tmin = 0, tmax = maxDist;
  let nx = 0, ny = 0, nz = 0;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox < b.min.x || ox > b.max.x) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (b.min.x - ox) * inv, t2 = (b.max.x - ox) * inv;
    let n = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = n; ny = 0; nz = 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (oy < b.min.y || oy > b.max.y) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (b.min.y - oy) * inv, t2 = (b.max.y - oy) * inv;
    let n = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = n; nz = 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (oz < b.min.z || oz > b.max.z) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (b.min.z - oz) * inv, t2 = (b.max.z - oz) * inv;
    let n = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nz = n; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin < 0 || tmin > maxDist) return null;
  return {
    dist: tmin,
    point: { x: ox + dx * tmin, y: oy + dy * tmin, z: oz + dz * tmin },
    normal: { x: nx, y: ny, z: nz },
    brush: b,
  };
}

/** Ray vs vertical capsule — used for hitting characters. */
export function rayCapsule(ox, oy, oz, dx, dy, dz, cx, cy, cz, halfHeight, radius, maxDist) {
  // Solve against the infinite cylinder first, then clamp to the segment and
  // fall back to sphere caps. Accurate enough for hit registration and cheap.
  const px = ox - cx, pz = oz - cz;
  const a = dx * dx + dz * dz;
  let bestT = Infinity;
  let hitY = 0;
  if (a > 1e-9) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0 || t > maxDist) continue;
        const y = oy + dy * t;
        if (y >= cy - halfHeight && y <= cy + halfHeight && t < bestT) { bestT = t; hitY = y; }
      }
    }
  }
  // Spherical caps
  for (const capY of [cy - halfHeight, cy + halfHeight]) {
    const ex = ox - cx, ey = oy - capY, ez = oz - cz;
    const b = 2 * (ex * dx + ey * dy + ez * dz);
    const c = ex * ex + ey * ey + ez * ez - radius * radius;
    const disc = b * b - 4 * c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of [(-b - sq) / 2, (-b + sq) / 2]) {
      if (t < 0 || t > maxDist || t >= bestT) continue;
      const y = oy + dy * t;
      if ((capY < cy && y <= cy - halfHeight) || (capY > cy && y >= cy + halfHeight)) { bestT = t; hitY = y; }
    }
  }
  if (bestT === Infinity) return null;
  const point = { x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT };
  const nx = point.x - cx, nz = point.z - cz;
  const nl = Math.hypot(nx, nz) || 1;
  return { dist: bestT, point, normal: { x: nx / nl, y: 0, z: nz / nl }, localY: hitY - (cy - halfHeight) };
}

/**
 * Move an axis-aligned body through the world with sliding and stair stepping.
 * `body` = { x, y, z, radius, height } with y at the FEET.
 * Returns collision flags for the caller (grounded, hit ceiling, hit wall).
 */
export class BodyMover {
  constructor(world) {
    this.world = world;
    this._scratch = [];
    this._min = { x: 0, y: 0, z: 0 };
    this._max = { x: 0, y: 0, z: 0 };
  }

  _aabb(x, y, z, r, h) {
    this._min.x = x - r; this._min.y = y; this._min.z = z - r;
    this._max.x = x + r; this._max.y = y + h; this._max.z = z + r;
    return this._min;
  }

  /** Resolve overlap along a single axis by pushing the body out of each brush. */
  _resolveAxis(pos, r, h, axis) {
    const w = this.world;
    this._aabb(pos.x, pos.y, pos.z, r, h);
    const list = w.query(this._min, this._max, this._scratch);
    let blocked = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b.solid) continue;
      const bmin = this._min, bmax = this._max;
      if (bmax.x <= b.min.x + EPS || bmin.x >= b.max.x - EPS) continue;
      if (bmax.y <= b.min.y + EPS || bmin.y >= b.max.y - EPS) continue;
      if (bmax.z <= b.min.z + EPS || bmin.z >= b.max.z - EPS) continue;
      // Overlapping: push out along the requested axis, whichever side is nearer.
      if (axis === 'x') {
        const pushPos = b.max.x - bmin.x;
        const pushNeg = b.min.x - bmax.x;
        pos.x += Math.abs(pushPos) < Math.abs(pushNeg) ? pushPos + EPS : pushNeg - EPS;
        blocked = Math.abs(pushPos) < Math.abs(pushNeg) ? 1 : -1;
      } else if (axis === 'z') {
        const pushPos = b.max.z - bmin.z;
        const pushNeg = b.min.z - bmax.z;
        pos.z += Math.abs(pushPos) < Math.abs(pushNeg) ? pushPos + EPS : pushNeg - EPS;
        blocked = Math.abs(pushPos) < Math.abs(pushNeg) ? 1 : -1;
      } else {
        const pushUp = b.max.y - bmin.y;
        const pushDown = b.min.y - bmax.y;
        if (Math.abs(pushUp) < Math.abs(pushDown)) { pos.y += pushUp + EPS; blocked = 1; }
        else { pos.y += pushDown - EPS; blocked = -1; }
      }
      this._aabb(pos.x, pos.y, pos.z, r, h);
    }
    return blocked;
  }

  /** Sweep horizontally in small substeps so fast movement can't skip a wall. */
  _moveHorizontal(pos, r, h, dx, dz) {
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.65)));
    let hitWall = false;
    for (let i = 0; i < steps; i++) {
      pos.x += dx / steps;
      if (this._resolveAxis(pos, r, h, 'x')) hitWall = true;
      pos.z += dz / steps;
      if (this._resolveAxis(pos, r, h, 'z')) hitWall = true;
    }
    return hitWall;
  }

  /**
   * @returns {{grounded:boolean, ceiling:boolean, wall:boolean, groundSurface:string|null, stepped:number}}
   */
  move(pos, radius, height, delta, stepHeight = 0.5, canStep = true) {
    const startX = pos.x, startZ = pos.z, startY = pos.y;
    const res = { grounded: false, ceiling: false, wall: false, groundSurface: null, stepped: 0 };

    // --- Vertical ---
    const vSteps = Math.max(1, Math.ceil(Math.abs(delta.y) / (height * 0.4)));
    for (let i = 0; i < vSteps; i++) {
      pos.y += delta.y / vSteps;
      const r = this._resolveAxis(pos, radius, height, 'y');
      if (r === 1) { res.grounded = true; }
      else if (r === -1) { res.ceiling = true; }
    }

    // --- Horizontal, plain slide ---
    const flatPos = { x: pos.x, y: pos.y, z: pos.z };
    const wallFlat = this._moveHorizontal(flatPos, radius, height, delta.x, delta.z);

    let chosen = flatPos;
    res.wall = wallFlat;

    // --- Horizontal, stair-stepped variant ---
    if (canStep && wallFlat && stepHeight > 0) {
      const up = { x: pos.x, y: pos.y, z: pos.z };
      up.y += stepHeight;
      if (this._resolveAxis(up, radius, height, 'y') !== -1) {
        this._moveHorizontal(up, radius, height, delta.x, delta.z);
        // Drop back down onto the step.
        up.y -= stepHeight + 0.02;
        const landed = this._resolveAxis(up, radius, height, 'y') === 1;
        const gainedFlat = Math.hypot(flatPos.x - pos.x, flatPos.z - pos.z);
        const gainedStep = Math.hypot(up.x - pos.x, up.z - pos.z);
        if (landed && gainedStep > gainedFlat + 1e-3) {
          chosen = up;
          res.stepped = up.y - startY;
          res.grounded = true;
          res.wall = false;
        }
      }
    }

    pos.x = chosen.x; pos.y = chosen.y; pos.z = chosen.z;

    // --- Ground probe (keeps the player glued to steps while walking down) ---
    if (!res.grounded && delta.y <= 0) {
      const probe = this.world.raycast(pos.x, pos.y + 0.05, pos.z, 0, -1, 0, 0.2 + Math.abs(delta.y), 'solid');
      if (probe && probe.normal.y > 0) {
        pos.y = probe.point.y + EPS;
        res.grounded = true;
        res.groundSurface = probe.brush.surface;
      }
    } else if (res.grounded) {
      const probe = this.world.raycast(pos.x, pos.y + 0.1, pos.z, 0, -1, 0, 0.3, 'solid');
      if (probe) res.groundSurface = probe.brush.surface;
    }

    // Safety net: if we somehow ended inside geometry, snap back out.
    this._aabb(pos.x, pos.y, pos.z, radius * 0.9, height * 0.95);
    if (this.world.overlapsSolid(this._min, this._max, this._scratch)) {
      const free = this._findFreeSpot(pos, radius, height);
      if (free) { pos.x = free.x; pos.y = free.y; pos.z = free.z; }
      else { pos.x = startX; pos.y = startY; pos.z = startZ; }
    }
    return res;
  }

  /** Spiral outward for the nearest non-overlapping position. Last-resort unstick. */
  _findFreeSpot(pos, radius, height) {
    const dirs = [
      [0, 1, 0], [0, 0.5, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
      [1, 0.5, 1], [-1, 0.5, 1], [1, 0.5, -1], [-1, 0.5, -1],
    ];
    for (let r = 0.15; r <= 2.4; r += 0.25) {
      for (const d of dirs) {
        const x = pos.x + d[0] * r, y = pos.y + d[1] * r, z = pos.z + d[2] * r;
        this._aabb(x, y, z, radius * 0.9, height * 0.95);
        if (!this.world.overlapsSolid(this._min, this._max, this._scratch)) return { x, y, z };
      }
    }
    return null;
  }

  /** Can a body of this size stand at this spot? Used by nav generation and spawn picking. */
  fits(x, y, z, radius, height) {
    this._aabb(x, y, z, radius, height);
    return !this.world.overlapsSolid(this._min, this._max, this._scratch);
  }

  /** Drop a point to the floor. Returns null if there's no floor within `maxDrop`. */
  groundAt(x, y, z, maxDrop = 20) {
    const hit = this.world.raycast(x, y, z, 0, -1, 0, maxDrop, 'solid');
    return hit ? hit.point.y : null;
  }
}

export function aabbOverlap(aMin, aMax, bMin, bMax) {
  return aMin.x <= bMax.x && aMax.x >= bMin.x &&
         aMin.y <= bMax.y && aMax.y >= bMin.y &&
         aMin.z <= bMax.z && aMax.z >= bMin.z;
}

export function distSq(ax, ay, az, bx, by, bz) {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}
