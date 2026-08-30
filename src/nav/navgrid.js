// Navigation grid built by sampling the brush world.
//
// Beyond plain pathfinding this bakes the tactical data the AI reasons over:
// per-node cover directions (stand + crouch), exposure, and chokepoint scoring.
// Without this the bots would only be able to run straight at you.

import { BodyMover } from '../world/physics.js';
import { clamp } from '../core/math.js';

export const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
// 16 sampling directions for cover analysis (finer than movement dirs).
const COVER_DIRS = [];
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  COVER_DIRS.push([Math.cos(a), Math.sin(a)]);
}

export class NavGrid {
  constructor(world, opts = {}) {
    this.world = world;
    this.cell = opts.cell ?? 1.0;
    this.agentRadius = opts.agentRadius ?? 0.38;
    this.agentHeight = opts.agentHeight ?? 1.78;
    this.stepMax = opts.stepMax ?? 0.55;
    this.maxLayers = opts.maxLayers ?? 3;
    this.nodes = [];
    this.columns = new Map(); // "ix,iz" -> node[]
    this.mover = new BodyMover(world);
    this.built = false;
    this.bounds = opts.bounds || null;
    this._openSet = null;
  }

  _ckey(ix, iz) { return ix * 100000 + iz; }

  build() {
    const w = this.world;
    const b = this.bounds || w.bounds;
    if (!Number.isFinite(b.min.x)) return this;
    const c = this.cell;
    const x0 = Math.floor(b.min.x / c), x1 = Math.ceil(b.max.x / c);
    const z0 = Math.floor(b.min.z / c), z1 = Math.ceil(b.max.z / c);
    const ceiling = b.max.y - 0.02;

    // --- Pass 1: sample standable surfaces, allowing several floors per column ---
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const x = ix * c + c * 0.5;
        const z = iz * c + c * 0.5;
        let y = ceiling;
        const col = [];
        for (let layer = 0; layer < this.maxLayers * 2 && col.length < this.maxLayers; layer++) {
          const hit = w.raycast(x, y, z, 0, -1, 0, y - b.min.y + 2, 'solid');
          if (!hit) break;
          const floorY = hit.point.y;
          // Surfaces below the declared play volume are structural (catch
          // plates, foundations) and never become walkable nav.
          if (floorY < b.min.y) break;
          const upFacing = hit.normal.y > 0;
          if (upFacing && !hit.brush.noNav && this._standable(x, floorY, z)) {
            col.push(this._makeNode(ix, iz, x, floorY, z, hit.brush.surface));
          }
          // Step past the brush we just hit. Starting inside one (or grazing a
          // side face) would otherwise leave `y` unchanged and stall the scan.
          const next = upFacing ? floorY - 0.25 : Math.min(hit.brush.min.y - 0.25, y - 0.25);
          if (next >= y) break;
          y = next;
          if (y <= b.min.y) break;
        }
        if (col.length) this.columns.set(this._ckey(ix, iz), col);
      }
    }

    // --- Pass 2: link neighbours ---
    for (const col of this.columns.values()) {
      for (const node of col) this._link(node);
    }

    // --- Pass 3: keep only the main connected component ---
    // A nav graph with several islands means either a genuinely unreachable
    // pocket or a geometry mistake; either way bots must never path into one.
    this._pruneIslands();

    // --- Pass 4: tactical annotation ---
    for (const n of this.nodes) this._analyse(n);
    this._normaliseExposure();

    this.built = true;
    this._openSet = new BinaryHeap();
    return this;
  }

  _makeNode(ix, iz, x, y, z, surface) {
    const n = {
      index: this.nodes.length,
      ix, iz, x, y, z, surface,
      links: [],
      // tactical
      cover: new Float32Array(16),   // 0 = wide open, 1 = fully blocked (stand height)
      coverLow: new Float32Array(16),// same, at crouch height
      exposure: 0,                   // 0 = enclosed, 1 = wide open
      chokeScore: 0,                 // high = narrow corridor / doorway
      island: -1,
      // A* scratch
      g: 0, f: 0, parent: null, stamp: -1, open: false, closed: false,
    };
    this.nodes.push(n);
    return n;
  }

  /**
   * Can an agent stand here?
   *
   * The straightforward test is a full-body box fit, but on a staircase the
   * body legitimately overlaps the treads above it — every tread is a solid
   * box rising from the floor — so that test rejects every stair in the game.
   * When it fails we fall back to: clear headroom in a thin column, plus a ring
   * of surface probes that must look like treads rather than a wall.
   */
  _standable(x, y, z, radiusScale = 1) {
    const r = this.agentRadius * radiusScale;
    // Normal ground: the whole body box fits.
    if (this.mover.fits(x, y + 0.02, z, r, this.agentHeight)) return true;
    // On a staircase the body always overlaps the tread in front of it, so the
    // box test can never pass. Fall back to measuring real headroom straight up
    // (which stairs never block) plus a footprint shape check.
    if (this.world.raycast(x, y + 0.06, z, 0, 1, 0, this.agentHeight - 0.06, 'solid')) return false;
    return this._rampLike(x, y, z, r);
  }

  /**
   * Distinguishes a staircase or ramp from a wall top or a thin ledge: on a
   * real walking surface almost the whole footprint is supported at roughly
   * the same height, whereas a wall top drops away on both sides.
   */
  _rampLike(x, y, z, r) {
    const top = y + this.agentHeight;
    const reach = this.agentHeight + 2.5;
    const tolerance = this.stepMax * 1.7;
    let supported = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      const h = this.world.raycast(sx, top, sz, 0, -1, 0, reach, 'solid');
      if (!h) continue;
      if (h.normal.y <= 0) return false;                 // ray began inside a wall
      const dy = h.point.y - y;
      if (dy > tolerance) return false;                  // something towers over us
      if (dy > -tolerance) supported++;
    }
    return supported >= 6;
  }

  _link(node) {
    for (const [dx, dz] of DIRS8) {
      const col = this.columns.get(this._ckey(node.ix + dx, node.iz + dz));
      if (!col) continue;
      for (const other of col) {
        const dy = other.y - node.y;
        // A staircase can rise faster than one step per nav cell, so a plain
        // height comparison would wrongly cut the graph. Walk the surface
        // between the two columns and accept it if every real step is small.
        if (Math.abs(dy) > this.stepMax && !this._stairwayBetween(node, other)) continue;
        // Diagonals must not cut a corner through geometry.
        const diagonal = dx !== 0 && dz !== 0;
        if (diagonal) {
          const a = this.columns.get(this._ckey(node.ix + dx, node.iz));
          const bb = this.columns.get(this._ckey(node.ix, node.iz + dz));
          if (!a || !bb) continue;
          if (!a.some((n2) => Math.abs(n2.y - node.y) <= this.stepMax)) continue;
          if (!bb.some((n2) => Math.abs(n2.y - node.y) <= this.stepMax)) continue;
        }
        // Verify the agent physically fits at the midpoint of the edge.
        const mx = (node.x + other.x) * 0.5;
        const mz = (node.z + other.z) * 0.5;
        const my = Math.max(node.y, other.y) + 0.02;
        if (!this._standable(mx, my - 0.02, mz, 0.92)) continue;
        const cost = Math.hypot(other.x - node.x, other.z - node.z) + Math.abs(dy) * 1.6;
        node.links.push({ node: other, cost });
      }
    }
  }

  /**
   * Sample the solid surface along the edge between two nodes. Returns true if
   * it forms a climbable run — no single rise exceeds `stepMax` and the agent
   * fits the whole way. This is what makes real staircases navigable when the
   * treads are narrower than a nav cell.
   */
  _stairwayBetween(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const span = Math.hypot(dx, dz);
    if (span < 1e-4) return false;
    const climb = Math.abs(b.y - a.y);
    // Anything steeper than roughly 45 degrees is a wall, not a stair.
    if (climb > span * 1.7) return false;

    const samples = Math.max(4, Math.ceil(span / 0.22));
    let prevY = a.y;
    const top = Math.max(a.y, b.y) + this.agentHeight + 0.5;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const x = a.x + dx * t, z = a.z + dz * t;
      const hit = this.world.raycast(x, top, z, 0, -1, 0, top - Math.min(a.y, b.y) + 1.0, 'solid');
      if (!hit || hit.normal.y <= 0) return false;
      const y = hit.point.y;
      if (Math.abs(y - prevY) > this.stepMax) return false;
      if (!this._standable(x, y, z, 0.85)) return false;
      prevY = y;
    }
    return Math.abs(prevY - b.y) <= this.stepMax;
  }

  _pruneIslands() {
    let island = 0;
    const stack = [];
    const sizes = [];
    for (const n of this.nodes) {
      if (n.island !== -1) continue;
      const members = [];
      stack.length = 0;
      stack.push(n);
      n.island = island;
      while (stack.length) {
        const cur = stack.pop();
        members.push(cur);
        for (const l of cur.links) {
          if (l.node.island === -1) { l.node.island = island; stack.push(l.node); }
        }
      }
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const mnode of members) {
        if (mnode.x < minX) minX = mnode.x; if (mnode.x > maxX) maxX = mnode.x;
        if (mnode.z < minZ) minZ = mnode.z; if (mnode.z > maxZ) maxZ = mnode.z;
        if (mnode.y < minY) minY = mnode.y; if (mnode.y > maxY) maxY = mnode.y;
      }
      sizes.push({ island, size: members.length, sample: members[0], bounds: { minX, maxX, minY, maxY, minZ, maxZ } });
      island++;
    }
    if (sizes.length <= 1) { this.droppedIslands = []; return; }
    sizes.sort((a, b) => b.size - a.size);
    const keep = sizes[0].island;
    this.droppedIslands = sizes.slice(1);

    const kept = this.nodes.filter((n) => n.island === keep);
    for (const n of kept) n.links = n.links.filter((l) => l.node.island === keep);
    this.nodes = kept;
    this.columns.clear();
    for (let i = 0; i < kept.length; i++) {
      const n = kept[i];
      n.index = i;
      const k = this._ckey(n.ix, n.iz);
      let col = this.columns.get(k);
      if (!col) { col = []; this.columns.set(k, col); }
      col.push(n);
    }
  }

  /** Cast rays outward to learn where this node is protected from. */
  _analyse(n) {
    const w = this.world;
    const standY = n.y + 1.55;
    const crouchY = n.y + 0.85;
    const probe = 9;
    let openCount = 0;
    for (let i = 0; i < 16; i++) {
      const [dx, dz] = COVER_DIRS[i];
      const hi = w.raycast(n.x, standY, n.z, dx, 0, dz, probe, 'sight');
      const lo = w.raycast(n.x, crouchY, n.z, dx, 0, dz, probe, 'sight');
      n.cover[i] = hi ? clamp(1 - hi.dist / probe, 0, 1) : 0;
      n.coverLow[i] = lo ? clamp(1 - lo.dist / probe, 0, 1) : 0;
      if (!hi) openCount++;
    }
    n.exposure = openCount / 16;
    // A node with few walkable neighbours in a mostly-walkable map is a chokepoint.
    n.chokeScore = clamp(1 - n.links.length / 8, 0, 1);
  }

  _normaliseExposure() {
    if (!this.nodes.length) return;
    let min = 1, max = 0;
    for (const n of this.nodes) { if (n.exposure < min) min = n.exposure; if (n.exposure > max) max = n.exposure; }
    const range = max - min || 1;
    for (const n of this.nodes) n.exposure = (n.exposure - min) / range;
  }

  /** Nearest node to a world point, preferring the matching floor level. */
  nearest(x, y, z, maxRadius = 6) {
    if (!this.nodes.length) return null;
    const c = this.cell;
    const cx = Math.floor(x / c), cz = Math.floor(z / c);
    let best = null, bestD = Infinity;
    const rings = Math.ceil(maxRadius / c);
    for (let r = 0; r <= rings; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          // Only walk the perimeter of each expanding ring.
          if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iz - cz) !== r) continue;
          const col = this.columns.get(this._ckey(ix, iz));
          if (!col) continue;
          for (const n of col) {
            const dx = n.x - x, dy = (n.y - y) * 2.2, dz = n.z - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = n; }
          }
        }
      }
      // Found something and the ring is already wider than the hit: good enough.
      if (best && Math.sqrt(bestD) <= r * c) break;
    }
    return best;
  }

  /**
   * A* between two world points.
   * `costFn(node, fromNode)` may add extra cost (danger avoidance, stealth).
   * Returns an array of {x,y,z} waypoints, already string-pulled.
   */
  findPath(from, to, costFn = null, maxNodes = 6000) {
    const start = this.nearest(from.x, from.y, from.z);
    const goal = this.nearest(to.x, to.y, to.z);
    if (!start || !goal) return null;
    if (start === goal) return [{ x: goal.x, y: goal.y, z: goal.z }];
    if (start.island !== goal.island) return null;

    const stamp = ++NavGrid._stamp;
    const heap = this._openSet;
    heap.clear();
    start.stamp = stamp; start.g = 0; start.parent = null;
    start.f = this._h(start, goal); start.open = true; start.closed = false;
    heap.push(start);

    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      cur.open = false;
      if (cur === goal) return this._reconstruct(cur, to);
      cur.closed = true;
      if (++expanded > maxNodes) break;

      for (let i = 0; i < cur.links.length; i++) {
        const link = cur.links[i];
        const nx = link.node;
        if (nx.stamp !== stamp) { nx.stamp = stamp; nx.g = Infinity; nx.open = false; nx.closed = false; nx.parent = null; }
        if (nx.closed) continue;
        let step = link.cost;
        if (costFn) {
          const extra = costFn(nx, cur);
          if (extra === Infinity) continue;
          step += extra;
        }
        const g = cur.g + step;
        if (g < nx.g) {
          nx.g = g;
          nx.parent = cur;
          nx.f = g + this._h(nx, goal);
          if (!nx.open) { nx.open = true; heap.push(nx); }
          else heap.update(nx);
        }
      }
    }
    return null;
  }

  _h(a, b) {
    const dx = Math.abs(a.x - b.x), dz = Math.abs(a.z - b.z);
    // Octile distance — admissible for 8-way movement, much tighter than Euclidean.
    return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz) + Math.abs(a.y - b.y) * 1.6;
  }

  _reconstruct(node, exactTarget) {
    const raw = [];
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 10000) { raw.push(cur); cur = cur.parent; }
    raw.reverse();
    return this.smooth(raw, exactTarget);
  }

  /** String-pull: drop waypoints we can walk straight past. Makes movement read as intentional. */
  smooth(nodes, exactTarget) {
    if (nodes.length <= 2) {
      const out = nodes.map((n) => ({ x: n.x, y: n.y, z: n.z }));
      if (exactTarget) out.push({ x: exactTarget.x, y: exactTarget.y ?? nodes[nodes.length - 1].y, z: exactTarget.z });
      return out;
    }
    const out = [{ x: nodes[0].x, y: nodes[0].y, z: nodes[0].z }];
    let anchor = 0;
    for (let i = 2; i < nodes.length; i++) {
      if (!this.walkableLine(nodes[anchor], nodes[i])) {
        out.push({ x: nodes[i - 1].x, y: nodes[i - 1].y, z: nodes[i - 1].z });
        anchor = i - 1;
      }
    }
    const last = nodes[nodes.length - 1];
    out.push({ x: last.x, y: last.y, z: last.z });
    if (exactTarget) {
      if (this.walkableLine(last, exactTarget)) out[out.length - 1] = { x: exactTarget.x, y: exactTarget.y ?? last.y, z: exactTarget.z };
      else out.push({ x: exactTarget.x, y: exactTarget.y ?? last.y, z: exactTarget.z });
    }
    return out;
  }

  /** Sample along a segment checking that an agent could actually walk it. */
  walkableLine(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return true;
    const steps = Math.ceil(dist / (this.cell * 0.5));
    let prevY = a.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      const node = this.nearest(x, prevY, z, this.cell * 1.5);
      if (!node) return false;
      if (Math.abs(node.y - prevY) > this.stepMax) return false;
      if (!this._standable(x, node.y, z, 0.95)) return false;
      prevY = node.y;
    }
    return true;
  }

  /**
   * Score nearby nodes as cover from a set of threat positions.
   * This is the heart of the AI's positioning: it wants a node that blocks the
   * threat's line of fire but still lets it lean out to shoot.
   */
  findCover(fromX, fromY, fromZ, threats, opts = {}) {
    const {
      searchRadius = 16, minDist = 0, maxResults = 1,
      preferForward = null, requireLos = false, avoid = null, avoidRadius = 3,
    } = opts;
    if (!this.nodes.length || !threats.length) return null;
    const origin = this.nearest(fromX, fromY, fromZ);
    if (!origin) return null;

    // Breadth-limited flood so we only score genuinely reachable nodes.
    const stamp = ++NavGrid._stamp;
    const queue = [origin];
    origin.stamp = stamp; origin.g = 0;
    const candidates = [];
    let head = 0;
    while (head < queue.length && candidates.length < 900) {
      const cur = queue[head++];
      if (cur.g > searchRadius) continue;
      candidates.push(cur);
      for (const l of cur.links) {
        const n = l.node;
        if (n.stamp === stamp) continue;
        n.stamp = stamp;
        n.g = cur.g + l.cost;
        if (n.g <= searchRadius) queue.push(n);
      }
    }

    const results = [];
    for (const n of candidates) {
      const d = Math.hypot(n.x - fromX, n.z - fromZ);
      if (d < minDist) continue;
      if (avoid && Math.hypot(n.x - avoid.x, n.z - avoid.z) < avoidRadius) continue;

      let score = 0;
      let blockedCount = 0;
      let peekable = false;
      for (const t of threats) {
        const eyeY = n.y + 1.6;
        const crouchY = n.y + 0.95;
        const standClear = this.world.lineOfSight(n.x, eyeY, n.z, t.x, t.y, t.z);
        const crouchClear = this.world.lineOfSight(n.x, crouchY, n.z, t.x, t.y, t.z);
        if (!standClear) { blockedCount++; score += 2.4; }
        else if (!crouchClear) { blockedCount++; score += 1.7; peekable = true; } // hard cover you can pop over
        else score -= 1.5;
        // Sideways lean check: cover you can shoot from beats a dead end.
        if (!standClear) {
          const ang = Math.atan2(t.z - n.z, t.x - n.x);
          for (const s of [-1, 1]) {
            const px = n.x + Math.cos(ang + s * Math.PI / 2) * 0.9;
            const pz = n.z + Math.sin(ang + s * Math.PI / 2) * 0.9;
            if (this.world.lineOfSight(px, eyeY, pz, t.x, t.y, t.z)) { peekable = true; break; }
          }
        }
      }
      if (requireLos && blockedCount === threats.length && !peekable) continue;
      if (peekable) score += 2.0;
      score -= n.exposure * 1.2;
      score -= (n.g / searchRadius) * 1.8;       // prefer close cover, we may be under fire
      if (preferForward) {
        const dot = ((n.x - fromX) * preferForward.x + (n.z - fromZ) * preferForward.z) / (d || 1);
        score += dot * 1.1;
      }
      results.push({ node: n, score, peekable, travel: n.g });
    }
    if (!results.length) return null;
    results.sort((a, b) => b.score - a.score);
    return maxResults === 1 ? results[0] : results.slice(0, maxResults);
  }

  /** Node that can see `target` from around `fromX/Z` — used for flanking and angles. */
  findFiringPosition(fromX, fromY, fromZ, target, opts = {}) {
    const { searchRadius = 22, minDistToTarget = 5, maxDistToTarget = 45, flankBias = null } = opts;
    const origin = this.nearest(fromX, fromY, fromZ);
    if (!origin) return null;
    const stamp = ++NavGrid._stamp;
    const queue = [origin];
    origin.stamp = stamp; origin.g = 0;
    let head = 0;
    let best = null, bestScore = -Infinity;
    while (head < queue.length && head < 1400) {
      const cur = queue[head++];
      for (const l of cur.links) {
        const n = l.node;
        if (n.stamp === stamp) continue;
        n.stamp = stamp; n.g = cur.g + l.cost;
        if (n.g <= searchRadius) queue.push(n);
      }
      const dt = Math.hypot(cur.x - target.x, cur.z - target.z);
      if (dt < minDistToTarget || dt > maxDistToTarget) continue;
      if (!this.world.lineOfSight(cur.x, cur.y + 1.6, cur.z, target.x, target.y, target.z)) continue;
      let score = 3 - cur.exposure * 2 - cur.g * 0.05;
      // Reward taking an angle the target isn't already facing.
      if (flankBias) {
        const ax = cur.x - target.x, az = cur.z - target.z;
        const l2 = Math.hypot(ax, az) || 1;
        const dot = (ax / l2) * flankBias.x + (az / l2) * flankBias.z;
        score += (1 - dot) * 2.2;
      }
      // Prefer nodes with some nearby cover to fall back into.
      let maxCover = 0;
      for (let i = 0; i < 16; i++) maxCover = Math.max(maxCover, cur.cover[i]);
      score += maxCover * 1.4;
      if (score > bestScore) { bestScore = score; best = cur; }
    }
    return best ? { node: best, score: bestScore } : null;
  }

  /** Random reachable node, optionally far from a point. Used for patrols and spawns. */
  randomNode(awayFrom = null, minDist = 0, tries = 40) {
    if (!this.nodes.length) return null;
    let best = null, bestD = -1;
    for (let i = 0; i < tries; i++) {
      const n = this.nodes[(Math.random() * this.nodes.length) | 0];
      if (!awayFrom) return n;
      const d = Math.hypot(n.x - awayFrom.x, n.z - awayFrom.z);
      if (d >= minDist) return n;
      if (d > bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** How well is this node covered from a given world direction? 0..1 */
  coverFrom(node, dx, dz, crouched = false) {
    const a = Math.atan2(dz, dx);
    let idx = Math.round((a / (Math.PI * 2)) * 16);
    idx = ((idx % 16) + 16) % 16;
    return crouched ? node.coverLow[idx] : node.cover[idx];
  }
}
NavGrid._stamp = 0;

/** Minimal binary heap with decrease-key, keyed on node.f. */
class BinaryHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  clear() { this.items.length = 0; }
  push(n) { n._heap = this.items.length; this.items.push(n); this._up(this.items.length - 1); }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) { items[0] = last; last._heap = 0; this._down(0); }
    top._heap = -1;
    return top;
  }
  update(n) { if (n._heap >= 0 && n._heap < this.items.length) this._up(n._heap); }
  _up(i) {
    const items = this.items;
    const node = items[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].f <= node.f) break;
      items[i] = items[p]; items[i]._heap = i;
      i = p;
    }
    items[i] = node; node._heap = i;
  }
  _down(i) {
    const items = this.items;
    const n = items.length;
    const node = items[i];
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let best = i;
      let bestF = node.f;
      if (l < n && items[l].f < bestF) { best = l; bestF = items[l].f; }
      if (r < n && items[r].f < bestF) { best = r; }
      if (best === i) break;
      items[i] = items[best]; items[i]._heap = i;
      i = best;
    }
    items[i] = node; node._heap = i;
  }
}
