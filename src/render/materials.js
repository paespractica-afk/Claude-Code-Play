// Material library + world-aligned brush meshing.
//
// Brush faces get planar UVs computed in world space, so one shared material
// tiles correctly across every wall regardless of size. That means the whole
// map renders in a handful of draw calls with no per-brush material clones.

import * as THREE from 'three';

/** World units covered by one texture tile, per surface family. */
export const TEX_SCALE = {
  concrete: 4.4,
  concreteFloor: 5.0,
  metalPanel: 3.0,
  paintedMetal: 3.2,
  tile: 3.0,
  wood: 2.8,
  sand: 6.0,
  brick: 3.6,
  grate: 2.6,
  hazard: 2.0,
  marble: 5.5,
};

export class MaterialLibrary {
  constructor(textures, envMap = null) {
    this.textures = textures;
    this.envMap = envMap;
    this.cache = new Map();
  }

  /** Shared PBR material for a texture recipe, optionally tinted. */
  surface(name, opts = {}) {
    const key = `${name}|${opts.color || ''}|${opts.emissive || ''}|${opts.rough ?? ''}|${opts.metal ?? ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const set = this.textures.bake(name);
    const mat = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.armMap,
      metalnessMap: set.armMap,
      aoMap: set.armMap,
      aoMapIntensity: 1.0,
      roughness: opts.rough ?? 1.0,
      metalness: opts.metal ?? 1.0,
      color: new THREE.Color(opts.color ?? 0xffffff),
      normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      envMapIntensity: opts.envIntensity ?? 1.0,
      envMapIntensity: opts.envIntensity ?? 1.0,
      dithering: true,
    });
    if (opts.emissive) {
      mat.emissive = new THREE.Color(opts.emissive);
      mat.emissiveIntensity = opts.emissiveIntensity ?? 1;
    }
    this.cache.set(key, mat);
    return mat;
  }

  /** Flat emissive material for light strips, holograms and objective markers. */
  emissive(color, intensity = 3, opts = {}) {
    const key = `emis|${color}|${intensity}|${opts.transparent ? 1 : 0}|${opts.opacity ?? 1}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x050505,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.4,
      metalness: 0,
      transparent: !!opts.transparent,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      toneMapped: opts.toneMapped !== false,
    });
    this.cache.set(key, mat);
    return mat;
  }

  /** Plain shaded material for props and characters. */
  solid(color, { rough = 0.6, metal = 0.1, emissive = null, emissiveIntensity = 1, flat = false, transparent = false, opacity = 1 } = {}) {
    const key = `solid|${color}|${rough}|${metal}|${emissive}|${emissiveIntensity}|${flat}|${transparent}|${opacity}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rough,
      metalness: metal,
      flatShading: flat,
      transparent,
      opacity,
      dithering: true,
    });
    if (emissive) { mat.emissive = new THREE.Color(emissive); mat.emissiveIntensity = emissiveIntensity; }
    this.cache.set(key, mat);
    return mat;
  }

  /**
   * Materials deliberately do NOT carry their own `envMap`: leaving it unset
   * lets `scene.environment` supply it, which is the only path that respects
   * `scene.environmentIntensity` and therefore each map's ambient level.
   */
  setEnvMap(env) { this.envMap = env; }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}

/* ------------------------------------------------------------- meshing ---- */

// Face table. Corner order is derived so each quad winds counter-clockwise as
// seen from outside the box — verified against the right-hand rule per axis.
// `q` lists (u,v) corners using 0 = min, 1 = max on the face's u/v axes.
const FACES = [
  { axis: 'x', sign: 1, n: [1, 0, 0], u: 'z', v: 'y', q: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  { axis: 'x', sign: -1, n: [-1, 0, 0], u: 'z', v: 'y', q: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { axis: 'y', sign: 1, n: [0, 1, 0], u: 'x', v: 'z', q: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { axis: 'y', sign: -1, n: [0, -1, 0], u: 'x', v: 'z', q: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { axis: 'z', sign: 1, n: [0, 0, 1], u: 'x', v: 'y', q: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { axis: 'z', sign: -1, n: [0, 0, -1], u: 'x', v: 'y', q: [[1, 0], [0, 0], [0, 1], [1, 1]] },
];

/**
 * Build merged geometry for a set of boxes, grouped by texture name.
 * @param {Array<{min,max,tex,uvScale?,tint?,skipFaces?}>} boxes
 * @returns {Map<string, THREE.BufferGeometry>}
 */
export function buildBrushGeometry(boxes) {
  const groups = new Map();

  for (const b of boxes) {
    const tex = b.tex || 'concrete';
    let g = groups.get(tex);
    if (!g) { g = { pos: [], nor: [], uv: [], col: [], idx: [], count: 0 }; groups.set(tex, g); }

    const scale = b.uvScale ?? TEX_SCALE[tex] ?? 3;
    const tint = b.tint ? new THREE.Color(b.tint) : null;
    const { min, max } = b;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      if (b.skipFaces && b.skipFaces.includes(f)) continue;
      const [nx, ny, nz] = face.n;
      const fixed = face.sign > 0 ? max[face.axis] : min[face.axis];
      const uKey = face.u, vKey = face.v;
      const uRange = [min[uKey], max[uKey]];
      const vRange = [min[vKey], max[vKey]];

      const base = g.count;
      for (let i = 0; i < 4; i++) {
        const u = uRange[face.q[i][0]];
        const v = vRange[face.q[i][1]];
        const p = { x: 0, y: 0, z: 0 };
        p[face.axis] = fixed; p[uKey] = u; p[vKey] = v;
        g.pos.push(p.x, p.y, p.z);
        g.nor.push(nx, ny, nz);
        // World-space planar UVs, so tiling is continuous between brushes.
        g.uv.push(u / scale, (vKey === 'y' ? -v : v) / scale);
        if (tint) g.col.push(tint.r, tint.g, tint.b); else g.col.push(1, 1, 1);
        g.count++;
      }
      g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const out = new Map();
  for (const [tex, g] of groups) {
    if (!g.count) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
    geo.setIndex(g.idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    // Tangents come from the UVs; without them the normal maps light incorrectly.
    computeFlatTangents(geo);
    out.set(tex, geo);
  }
  return out;
}

/** Per-face tangents for planar-mapped geometry (MikkTSpace is overkill for boxes). */
function computeFlatTangents(geo) {
  const pos = geo.attributes.position.array;
  const uv = geo.attributes.uv.array;
  const idx = geo.index.array;
  const tan = new Float32Array((pos.length / 3) * 4);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const x1 = pos[b * 3] - pos[a * 3], y1 = pos[b * 3 + 1] - pos[a * 3 + 1], z1 = pos[b * 3 + 2] - pos[a * 3 + 2];
    const x2 = pos[c * 3] - pos[a * 3], y2 = pos[c * 3 + 1] - pos[a * 3 + 1], z2 = pos[c * 3 + 2] - pos[a * 3 + 2];
    const s1 = uv[b * 2] - uv[a * 2], t1 = uv[b * 2 + 1] - uv[a * 2 + 1];
    const s2 = uv[c * 2] - uv[a * 2], t2 = uv[c * 2 + 1] - uv[a * 2 + 1];
    const det = s1 * t2 - s2 * t1;
    const r = Math.abs(det) < 1e-8 ? 0 : 1 / det;
    let tx = (t2 * x1 - t1 * x2) * r, ty = (t2 * y1 - t1 * y2) * r, tz = (t2 * z1 - t1 * z2) * r;
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l; ty /= l; tz /= l;
    for (const v of [a, b, c]) {
      tan[v * 4] = tx; tan[v * 4 + 1] = ty; tan[v * 4 + 2] = tz; tan[v * 4 + 3] = 1;
    }
  }
  geo.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
}
