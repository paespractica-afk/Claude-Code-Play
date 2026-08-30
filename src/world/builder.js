// Map construction helpers.
//
// A map's geometry is authored as boxes; each box feeds both the collision
// world and the render mesh, so what you see is exactly what you shoot.

import * as THREE from 'three';
import { Brush } from './physics.js';

export class MapBuilder {
  constructor() {
    this.boxes = [];        // { min, max, tex, surface, ...flags }
    this.lights = [];
    this.spawnPoints = { 0: [], 1: [], ffa: [] };
    this.sites = [];
    this.zones = [];
    this.props = [];        // custom meshes added after brush meshing
    this.markers = {};
    this.covers = [];
  }

  /** Core primitive. Coordinates are min/max corners in world space. */
  box(x0, y0, z0, x1, y1, z1, opts = {}) {
    const min = { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) };
    const max = { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) };
    const b = {
      min, max,
      tex: opts.tex || 'concrete',
      surface: opts.surface || surfaceFor(opts.tex || 'concrete'),
      solid: opts.solid !== false,
      opaque: opts.opaque !== false,
      bulletproof: opts.bulletproof !== false,
      penetration: opts.penetration ?? 0,
      tint: opts.tint,
      uvScale: opts.uvScale,
      visible: opts.visible !== false,
      skipFaces: opts.skipFaces,
      tag: opts.tag,
      noNav: !!opts.noNav,
    };
    this.boxes.push(b);
    return b;
  }

  /** Floor slab. */
  floor(x0, z0, x1, z1, y = 0, thickness = 0.5, opts = {}) {
    return this.box(x0, y - thickness, z0, x1, y, z1, { tex: 'concreteFloor', ...opts });
  }

  /** Wall between two points on the XZ plane, with thickness. */
  wall(x0, z0, x1, z1, y0, y1, thickness = 0.4, opts = {}) {
    const dx = x1 - x0, dz = z1 - z0;
    if (Math.abs(dx) >= Math.abs(dz)) {
      const zc = (z0 + z1) / 2;
      return this.box(x0, y0, zc - thickness / 2, x1, y1, zc + thickness / 2, opts);
    }
    const xc = (x0 + x1) / 2;
    return this.box(xc - thickness / 2, y0, z0, xc + thickness / 2, y1, z1, opts);
  }

  /** Wall running along X at a fixed Z. Explicit segments beat subtractive openings. */
  wallX(z, x0, x1, y0, y1, thickness = 0.4, opts = {}) {
    if (x1 - x0 < 0.01) return null;
    return this.box(x0, y0, z - thickness / 2, x1, y1, z + thickness / 2, opts);
  }

  /** Wall running along Z at a fixed X. */
  wallZ(x, z0, z1, y0, y1, thickness = 0.4, opts = {}) {
    if (z1 - z0 < 0.01) return null;
    return this.box(x - thickness / 2, y0, z0, x + thickness / 2, y1, z1, opts);
  }

  /**
   * Wall along X with one or more gaps (doorways). `gaps` is a list of [x0,x1].
   * A header is added above each gap so the wall still reads as solid.
   */
  wallXGaps(z, x0, x1, y0, y1, gaps = [], thickness = 0.4, doorH = 2.6, opts = {}) {
    const sorted = gaps.slice().sort((a, b) => a[0] - b[0]);
    let cursor = x0;
    for (const [g0, g1] of sorted) {
      const a = Math.max(x0, g0), bb = Math.min(x1, g1);
      if (bb <= cursor) continue;
      if (a > cursor) this.wallX(z, cursor, a, y0, y1, thickness, opts);
      if (y1 > y0 + doorH) this.wallX(z, a, bb, y0 + doorH, y1, thickness, opts);
      cursor = bb;
    }
    if (cursor < x1) this.wallX(z, cursor, x1, y0, y1, thickness, opts);
  }

  /** Wall along Z with one or more gaps. */
  wallZGaps(x, z0, z1, y0, y1, gaps = [], thickness = 0.4, doorH = 2.6, opts = {}) {
    const sorted = gaps.slice().sort((a, b) => a[0] - b[0]);
    let cursor = z0;
    for (const [g0, g1] of sorted) {
      const a = Math.max(z0, g0), bb = Math.min(z1, g1);
      if (bb <= cursor) continue;
      if (a > cursor) this.wallZ(x, cursor, a, y0, y1, thickness, opts);
      if (y1 > y0 + doorH) this.wallZ(x, a, bb, y0 + doorH, y1, thickness, opts);
      cursor = bb;
    }
    if (cursor < z1) this.wallZ(x, cursor, z1, y0, y1, thickness, opts);
  }

  /** Flat ceiling slab over a region — keeps interiors dark and readable. */
  ceiling(x0, z0, x1, z1, y, thickness = 0.5, opts = {}) {
    return this.box(x0, y, z0, x1, y + thickness, z1, { tex: 'concrete', noNav: true, ...opts });
  }

  /** Four walls with an optional door gap per side. `doors` = {n,s,e,w} = [start,end]. */
  room(x0, z0, x1, z1, y0, y1, thickness = 0.4, doors = {}, opts = {}) {
    const seg = (axis, fixed, a, b, gap) => {
      if (!gap) { this._wallSeg(axis, fixed, a, b, y0, y1, thickness, opts); return; }
      const [g0, g1] = gap;
      if (g0 > a) this._wallSeg(axis, fixed, a, g0, y0, y1, thickness, opts);
      if (g1 < b) this._wallSeg(axis, fixed, g1, b, y0, y1, thickness, opts);
      // Header above the doorway.
      if (y1 - 2.4 > y0) this._wallSeg(axis, fixed, g0, g1, y0 + 2.4, y1, thickness, opts);
    };
    seg('x', z0, x0, x1, doors.n);
    seg('x', z1, x0, x1, doors.s);
    seg('z', x0, z0, z1, doors.w);
    seg('z', x1, z0, z1, doors.e);
  }

  _wallSeg(axis, fixed, a, b, y0, y1, t, opts) {
    if (b - a < 0.01) return;
    if (axis === 'x') this.box(a, y0, fixed - t / 2, b, y1, fixed + t / 2, opts);
    else this.box(fixed - t / 2, y0, a, fixed + t / 2, y1, b, opts);
  }

  /** Steps from y0 to y1 along an axis. */
  stairs(x0, z0, x1, z1, y0, y1, steps = 8, axis = 'x', opts = {}) {
    const rise = (y1 - y0) / steps;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      if (axis === 'x') {
        this.box(x0 + (x1 - x0) * t0, y0, z0, x0 + (x1 - x0) * t1, y0 + rise * (i + 1), z1, opts);
      } else {
        this.box(x0, y0, z0 + (z1 - z0) * t0, x1, y0 + rise * (i + 1), z0 + (z1 - z0) * t1, opts);
      }
    }
  }

  /** Waist-high cover you can shoot over but not through. */
  crate(x, y, z, w = 1.2, h = 1.1, d = 1.2, opts = {}) {
    return this.box(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, { tex: 'wood', penetration: 1, ...opts });
  }

  pillar(x, z, y0, y1, r = 0.5, opts = {}) {
    return this.box(x - r, y0, z - r, x + r, y1, z + r, opts);
  }

  /**
   * Elevated walkway. Railings run along the long sides only, leaving the ends
   * open so staircases and adjoining platforms can connect to them.
   * `opts.rails`: true (default), false, or 'x' / 'z' to force the railed axis.
   */
  catwalk(x0, z0, x1, z1, y, opts = {}) {
    this.box(x0, y - 0.25, z0, x1, y, z1, { tex: 'grate', ...opts });
    if (opts.rails === false) return;
    const railH = 1.05;
    const t = 0.12;
    const spanX = Math.abs(x1 - x0), spanZ = Math.abs(z1 - z0);
    const axis = opts.rails === 'x' || opts.rails === 'z' ? opts.rails : (spanZ >= spanX ? 'z' : 'x');
    const railOpts = { tex: 'metalPanel', opaque: false, penetration: 1, noNav: true };
    if (axis === 'z') {
      // Long axis runs along Z, so rail the two X edges.
      this.box(x0, y, z0, x0 + t, y + railH, z1, railOpts);
      this.box(x1 - t, y, z0, x1, y + railH, z1, railOpts);
    } else {
      this.box(x0, y, z0, x1, y + railH, z0 + t, railOpts);
      this.box(x0, y, z1 - t, x1, y + railH, z1, railOpts);
    }
  }

  light(x, y, z, opts = {}) {
    this.lights.push({
      x, y, z,
      color: opts.color ?? 0xffe6c0,
      intensity: opts.intensity ?? 8,
      distance: opts.distance ?? 14,
      decay: opts.decay ?? 2,
      castShadow: !!opts.castShadow,
      fixture: opts.fixture !== false,
      fixtureColor: opts.fixtureColor ?? opts.color ?? 0xffe6c0,
      priority: opts.priority ?? 1,
    });
  }

  /** Emissive strip — cheap, readable, and great for guiding the player. */
  strip(x0, y0, z0, x1, y1, z1, color = 0x6fd6ff, intensity = 3) {
    this.props.push({ kind: 'strip', x0, y0, z0, x1, y1, z1, color, intensity });
  }

  sign(x, y, z, rotY, text, color = 0xffb347) {
    this.props.push({ kind: 'sign', x, y, z, rotY, text, color });
  }

  spawn(team, x, y, z, yaw = 0) {
    const key = team === 'ffa' ? 'ffa' : team;
    if (!this.spawnPoints[key]) this.spawnPoints[key] = [];
    this.spawnPoints[key].push({ x, y, z, yaw });
    this.spawnPoints.ffa.push({ x, y, z, yaw });
  }

  site(id, x, y, z, radius = 4.5) {
    this.sites.push({ id, x, y, z, radius });
  }

  zone(id, x, y, z, radius = 5, opts = {}) {
    this.zones.push({ id, x, y, z, radius, ...opts });
  }

  marker(name, x, y, z) { this.markers[name] = { x, y, z }; }

  /**
   * Seal the play area. Walls run from well below the floor to well above, and
   * a catch plate far below stops anything falling forever if it slips a gap.
   */
  seal(x0, z0, x1, z1, y0, y1, opts = {}) {
    const t = 2;
    this.wallX(z0 - t / 2, x0 - t, x1 + t, y0 - 8, y1, t, opts);
    this.wallX(z1 + t / 2, x0 - t, x1 + t, y0 - 8, y1, t, opts);
    this.wallZ(x0 - t / 2, z0 - t, z1 + t, y0 - 8, y1, t, opts);
    this.wallZ(x1 + t / 2, z0 - t, z1 + t, y0 - 8, y1, t, opts);
    this.box(x0 - t, y1, z0 - t, x1 + t, y1 + t, z1 + t, { tex: 'concrete', visible: false, noNav: true });
    this.box(x0 - t, y0 - 9, z0 - t, x1 + t, y0 - 8, z1 + t, { tex: 'concrete', visible: false, noNav: true });
    this.killY = y0 - 6;
  }
}

const SURFACE_MAP = {
  concrete: 'concrete', concreteFloor: 'concrete', metalPanel: 'metal', paintedMetal: 'metal',
  grate: 'metal', hazard: 'metal', tile: 'tile', marble: 'marble', wood: 'wood',
  sand: 'sand', brick: 'brick',
};
function surfaceFor(tex) { return SURFACE_MAP[tex] || 'concrete'; }

/* ---------------------------------------------------------- prop meshes -- */

export function buildProps(builder, materials, scene) {
  const group = new THREE.Group();
  for (const p of builder.props) {
    if (p.kind === 'strip') {
      const w = Math.max(0.06, Math.abs(p.x1 - p.x0));
      const h = Math.max(0.06, Math.abs(p.y1 - p.y0));
      const d = Math.max(0.06, Math.abs(p.z1 - p.z0));
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        materials.emissive(p.color, p.intensity),
      );
      mesh.position.set((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, (p.z0 + p.z1) / 2);
      group.add(mesh);
    } else if (p.kind === 'sign') {
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, 512, 128);
      ctx.strokeStyle = `#${new THREE.Color(p.color).getHexString()}`;
      ctx.lineWidth = 8;
      ctx.strokeRect(10, 10, 492, 108);
      ctx.fillStyle = `#${new THREE.Color(p.color).getHexString()}`;
      ctx.font = 'bold 74px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, 256, 68);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 0.6),
        new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.4, roughness: 0.6 }),
      );
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.y = p.rotY;
      group.add(mesh);
    }
  }
  scene.add(group);
  return group;
}

/** Turn builder boxes into collision brushes. */
export function buildCollision(builder, collisionWorld) {
  collisionWorld.clear();
  for (const b of builder.boxes) {
    collisionWorld.add(new Brush(b.min, b.max, {
      surface: b.surface,
      solid: b.solid,
      opaque: b.opaque,
      bulletproof: b.bulletproof,
      penetration: b.penetration,
      tag: b.tag,
      noNav: b.noNav,
    }));
  }
  return collisionWorld;
}
