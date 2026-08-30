// Procedural PBR texture generation.
//
// No image files ship with the game: every surface is synthesised into canvases
// at load time and turned into albedo / normal / roughness / AO maps. This keeps
// the download tiny while still giving materials real high-frequency detail.

import * as THREE from 'three';

/* ---------------------------------------------------------------- noise --- */

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
/** Smoothstep between two edges, clamped. */
function smoothstep01(v, a, b) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Tileable value noise: wraps at `period` so textures repeat seamlessly. */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const w = (v) => ((v % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const u = smooth(xf), v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x, y, octaves, period, seed, gain = 0.5, lacunarity = 2) {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, period * freq, seed + i * 977) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Worley/cellular noise — gives concrete its aggregate and metal its brushed grain. */
function worley(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 10;
  const w = (v) => ((v % period) + period) % period;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const px = cx + hash2(w(cx), w(cy), seed);
      const py = cy + hash2(w(cx), w(cy), seed + 31);
      const d = Math.hypot(px - x, py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, best);
}

/* ------------------------------------------------------------ generation --- */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/**
 * Core generator. `shade(x, y, u, v)` returns { r, g, b, h, rough, ao }
 * with colour in 0..1 and h (height) in 0..1.
 */
function generate(size, shade) {
  const albedo = makeCanvas(size);
  const normal = makeCanvas(size);
  const arm = makeCanvas(size); // packed: R = AO, G = roughness, B = metalness
  const aCtx = albedo.getContext('2d', { willReadFrequently: true });
  const nCtx = normal.getContext('2d', { willReadFrequently: true });
  const rCtx = arm.getContext('2d', { willReadFrequently: true });
  const aImg = aCtx.createImageData(size, size);
  const nImg = nCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const s = shade(x, y, x / size, y / size);
      aImg.data[i * 4 + 0] = Math.max(0, Math.min(255, s.r * 255));
      aImg.data[i * 4 + 1] = Math.max(0, Math.min(255, s.g * 255));
      aImg.data[i * 4 + 2] = Math.max(0, Math.min(255, s.b * 255));
      aImg.data[i * 4 + 3] = 255;
      rImg.data[i * 4 + 0] = Math.max(0, Math.min(255, (s.ao ?? 1) * 255));
      rImg.data[i * 4 + 1] = Math.max(0, Math.min(255, (s.rough ?? 0.8) * 255));
      rImg.data[i * 4 + 2] = Math.max(0, Math.min(255, (s.metal ?? 0) * 255));
      rImg.data[i * 4 + 3] = 255;
      height[i] = s.h ?? 0.5;
    }
  }

  // Soften the height field before differentiating. Sobel on raw per-pixel noise
  // produces violent normals that sparkle under motion and never settle.
  const smoothed = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = ((x + dx) % size + size) % size;
          const sy = ((y + dy) % size + size) % size;
          sum += height[sy * size + sx] * (dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0) ? 2 : 1);
        }
      }
      smoothed[y * size + x] = sum / 16;
    }
  }
  height.set(smoothed);

  // Sobel the height field into a tangent-space normal map.
  const strength = 1.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (dx, dy) => height[(((y + dy) % size + size) % size) * size + (((x + dx) % size + size) % size)];
      const gx = (at(-1, -1) + 2 * at(-1, 0) + at(-1, 1)) - (at(1, -1) + 2 * at(1, 0) + at(1, 1));
      const gz = (at(-1, -1) + 2 * at(0, -1) + at(1, -1)) - (at(-1, 1) + 2 * at(0, 1) + at(1, 1));
      let nx = gx * strength, ny = gz * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      nImg.data[i + 0] = (nx / len * 0.5 + 0.5) * 255;
      nImg.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      nImg.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      nImg.data[i + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  nCtx.putImageData(nImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);
  return { albedo, normal, arm };
}

function toTexture(canvas, { srgb = false, aniso = 8, repeat = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

/* ----------------------------------------------------------- recipes ------ */

// Recipes deliberately keep albedo variation small — real surfaces are far
// flatter in colour than they look. The interest comes from the height field
// (and therefore the normal map) and from roughness breakup, not from painting
// high-contrast blotches into the diffuse.
const RECIPES = {
  concrete: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const grain = fbm(u * 26, v * 26, 4, 26, 11);              // fine surface tooth
    const patch = fbm(u * 3.5, v * 3.5, 4, 4, 23);             // slow tonal drift
    const agg = worley(u * 20, v * 20, 20, 7);                 // small aggregate
    const pit = smoothstep01(agg, 0.0, 0.16) * 0.55;                  // shallow pinholes
    const stain = Math.max(0, fbm(u * 1.7, v * 1.7, 3, 2, 91) - 0.55) * 0.9;

    const base = 0.44 + (patch - 0.5) * 0.10 + (grain - 0.5) * 0.05 - stain * 0.10;
    const h = 0.55 + (grain - 0.5) * 0.35 + pit * 0.22 + (patch - 0.5) * 0.1;
    return {
      r: base * 1.03, g: base, b: base * 0.95,
      h,
      rough: 0.84 + (grain - 0.5) * 0.10 - stain * 0.05,
      ao: 0.9 + pit * 0.1,
      metal: 0,
    };
  }),

  concreteFloor: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    // Poured slab with control joints every half tile.
    const jx = Math.min(x % (size / 2), (size / 2) - (x % (size / 2)));
    const jy = Math.min(y % (size / 2), (size / 2) - (y % (size / 2)));
    const joint = Math.min(jx, jy) < 1.6 ? 1 : 0;
    const grain = fbm(u * 24, v * 24, 4, 24, 33);
    const patch = fbm(u * 4, v * 4, 4, 4, 55);
    const agg = worley(u * 22, v * 22, 22, 3);
    const scuff = Math.max(0, fbm(u * 2.2, v * 2.2, 3, 2, 77) - 0.5) * 0.7;

    const base = 0.42 + (patch - 0.5) * 0.09 + (grain - 0.5) * 0.045 - joint * 0.14 - scuff * 0.06;
    return {
      r: base * 1.02, g: base, b: base * 0.96,
      h: 0.6 + (grain - 0.5) * 0.3 - joint * 0.45 + smoothstep01(agg, 0, 0.2) * 0.12,
      rough: 0.82 + (grain - 0.5) * 0.1 + joint * 0.08,
      ao: joint ? 0.62 : 0.94 + (1 - agg) * 0.06,
      metal: 0,
    };
  }),

  metalPanel: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const cell = size / 3;
    const gx = x % cell, gy = y % cell;
    const seamDist = Math.min(Math.min(gx, cell - gx), Math.min(gy, cell - gy));
    const seam = seamDist < 1.8 ? 1 : 0;
    // Brushed finish: stretched noise along one axis.
    const brushed = (fbm(u * 34, v * 5, 3, 34, 5) - 0.5) * 0.028;
    const rust = Math.max(0, fbm(u * 3.4, v * 3.4, 4, 3, 71) - 0.62) * 1.8;
    const dust = fbm(u * 6, v * 6, 3, 6, 17) * 0.05;

    const bx = Math.min(gx, cell - gx), by = Math.min(gy, cell - gy);
    const boltR = Math.hypot(bx - 5, by - 5);
    const bolt = (bx < 11 && by < 11) ? Math.max(0, 1 - boltR / 3.6) : 0;

    const steel = 0.56 + brushed - dust;
    const r = steel * (1 - rust) + rust * 0.34;
    const g = steel * (1 - rust) + rust * 0.20;
    const b = steel * (1 - rust) + rust * 0.13;
    return {
      r: r + bolt * 0.05, g: g + bolt * 0.05, b: b + bolt * 0.055,
      h: (seam ? 0.24 : 0.62) + brushed * 2 + bolt * 0.28,
      rough: 0.30 + rust * 0.45 + dust * 2 + (seam ? 0.1 : 0),
      metal: 0.62 - rust * 0.45,
      ao: seam ? 0.55 : 1 - rust * 0.1,
    };
  }),

  paintedMetal: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const chip = Math.max(0, worley(u * 18, v * 18, 18, 17) - 0.76) * 3.0;
    const orange = (fbm(u * 34, v * 34, 3, 34, 41) - 0.5) * 0.03;  // orange-peel paint
    const dirt = fbm(u * 4, v * 4, 4, 4, 55) * 0.07;
    const paint = 0.34 - dirt + orange;
    const l = paint * (1 - chip) + chip * 0.36;
    return {
      r: l * 0.74, g: l * 0.84, b: l * 0.92,
      h: 0.6 + orange * 6 - chip * 0.22 - dirt,
      rough: 0.40 + chip * 0.3 + dirt * 2,
      metal: chip * 0.6,
      ao: 1 - chip * 0.2,
    };
  }),

  tile: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const cell = size / 6;
    const gx = x % cell, gy = y % cell;
    const groutDist = Math.min(Math.min(gx, cell - gx), Math.min(gy, cell - gy));
    const grout = groutDist < 2.2 ? 1 : 0;
    const bevel = smoothstep01(groutDist, 2.2, 5.0);
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
    const shade = (hash2(ix, iy, 13) - 0.5) * 0.05;
    const speck = (fbm(u * 30, v * 30, 3, 30, ix * 31 + iy) - 0.5) * 0.025;
    const l = grout ? 0.30 : 0.60 + shade + speck;
    return {
      r: l * (grout ? 0.98 : 1), g: l, b: l * (grout ? 0.95 : 1.02),
      h: grout ? 0.12 : 0.55 + bevel * 0.4,
      rough: grout ? 0.9 : 0.22 + Math.abs(speck) * 4,
      ao: grout ? 0.55 : 0.85 + bevel * 0.15,
      metal: 0,
    };
  }),

  wood: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const plank = size / 4;
    const row = Math.floor(y / plank);
    const offset = (row % 2) * plank * 0.6;
    const px = (x + offset) % (plank * 1.7);
    const gapY = (y % plank) < 2 ? 1 : 0;
    const gapX = px < 2 ? 1 : 0;
    const gap = Math.max(gapX, gapY);
    // Grain: warped stripes, gentle in colour, strong in height.
    const warp = fbm(u * 5, v * 22, 3, 5, row * 7 + 3) * 2.2;
    const rings = Math.sin((u * 20 + warp) * Math.PI) * 0.5 + 0.5;
    const fine = (fbm(u * 56, v * 14, 3, 56, row) - 0.5) * 0.035;
    const tone = 0.34 + (hash2(row, 0, 5) - 0.5) * 0.04 + rings * 0.04 + fine;
    return {
      r: tone * 1.14, g: tone * 1.0, b: tone * 0.84,
      h: gap ? 0.2 : 0.55 + rings * 0.18 + fine * 3,
      rough: 0.60 + rings * 0.14,
      ao: gap ? 0.45 : 0.95 + rings * 0.05,
      metal: 0,
    };
  }),

  sand: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const dune = fbm(u * 2.6, v * 2.6, 4, 3, 3);
    const ripple = Math.sin((u * 14 + fbm(u * 4, v * 4, 3, 4, 9) * 6) * Math.PI) * 0.5 + 0.5;
    const grain = fbm(u * 40, v * 40, 3, 40, 61);
    const l = 0.56 + (dune - 0.5) * 0.10 + ripple * 0.02 + (grain - 0.5) * 0.03;
    return {
      r: l * 1.12, g: l * 1.0, b: l * 0.76,
      h: dune * 0.5 + ripple * 0.22 + grain * 0.28,
      rough: 0.93 + (grain - 0.5) * 0.05,
      ao: 0.92 + dune * 0.08,
      metal: 0,
    };
  }),

  brick: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const bh = size / 8, bw = size / 4;
    const row = Math.floor(y / bh);
    const xo = (row % 2) * bw * 0.5;
    const lx = (x + xo) % bw, ly = y % bh;
    const edge = Math.min(Math.min(lx, bw - lx), Math.min(ly, bh - ly));
    const mortar = edge < 3 ? 1 : 0;
    const bevel = smoothstep01(edge, 3, 7);
    const col = Math.floor((x + xo) / bw);
    const tint = (hash2(row, col, 5) - 0.5) * 0.09;
    const grit = (fbm(u * 34, v * 34, 3, 34, row * 41 + col) - 0.5) * 0.045;
    if (mortar) {
      const l = 0.42 + grit;
      return { r: l, g: l * 0.99, b: l * 0.96, h: 0.16, rough: 0.93, ao: 0.55, metal: 0 };
    }
    const l = 0.34 + tint + grit;
    return {
      r: l * 1.45, g: l * 0.92, b: l * 0.76,
      h: 0.55 + bevel * 0.35 + grit * 3,
      rough: 0.80 + Math.abs(grit) * 2,
      ao: 0.8 + bevel * 0.2,
      metal: 0,
    };
  }),

  grate: (size) => generate(size, (x, y) => {
    const cell = size / 6;
    const gx = x % cell, gy = y % cell;
    const bar = (gx < cell * 0.34 || gy < cell * 0.34) ? 1 : 0;
    const edge = bar ? smoothstep01(Math.min(gx, gy), 0, cell * 0.08) : 0;
    const grain = (fbm(x / size * 40, y / size * 40, 3, 40, 3) - 0.5) * 0.035;
    const l = bar ? 0.44 + grain : 0.08;
    return {
      r: l, g: l * 1.01, b: l * 1.05,
      h: bar ? 0.82 + edge * 0.14 : 0.04,
      rough: bar ? 0.38 : 0.9,
      metal: bar ? 0.6 : 0.08,
      ao: bar ? 0.95 : 0.25,
    };
  }),

  hazard: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    const stripe = (((x + y) % (size / 3)) < size / 6) ? 1 : 0;
    const wear = fbm(u * 5, v * 5, 4, 5, 23);
    const scuff = Math.max(0, wear - 0.58) * 1.5;
    const grain = (fbm(u * 32, v * 32, 3, 32, 9) - 0.5) * 0.035;
    const paintR = stripe ? 0.58 : 0.20, paintG = stripe ? 0.45 : 0.20, paintB = stripe ? 0.10 : 0.21;
    const k = 1 - scuff;
    return {
      r: paintR * k + 0.22 * scuff + grain,
      g: paintG * k + 0.22 * scuff + grain,
      b: paintB * k + 0.23 * scuff + grain,
      h: 0.5 + grain * 5 + wear * 0.12 - scuff * 0.2,
      rough: 0.68 + scuff * 0.2 + Math.abs(grain) * 2,
      ao: 1 - scuff * 0.15,
      metal: 0.12,
    };
  }),

  marble: (size) => generate(size, (x, y) => {
    const u = x / size, v = y / size;
    // Veins: turbulence-warped bands, thin and dark, over a near-flat field.
    const warp = fbm(u * 3, v * 3, 5, 3, 9) * 5.5;
    const band = Math.abs(Math.sin((u * 1.4 + v * 0.5 + warp) * Math.PI));
    const vein = Math.pow(1 - band, 22);
    const fine = (fbm(u * 26, v * 26, 3, 26, 21) - 0.5) * 0.018;
    const l = 0.58 - vein * 0.14 + fine;
    return {
      r: l * 0.985, g: l * 0.995, b: l,
      h: 0.6 - vein * 0.04 + fine * 3,
      rough: 0.14 + vein * 0.12,
      ao: 1 - vein * 0.08,
      metal: 0,
    };
  }),
};

/* --------------------------------------------------------------- library -- */

export class TextureLibrary {
  constructor(renderer) {
    this.renderer = renderer;
    this.maps = {};
    this.anisotropy = Math.min(16, renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
  }

  names() { return Object.keys(RECIPES); }

  /** Generate one recipe. Yields between recipes so the loader can paint. */
  bake(name, size = 512) {
    if (this.maps[name]) return this.maps[name];
    const recipe = RECIPES[name];
    if (!recipe) throw new Error(`unknown texture recipe: ${name}`);
    const { albedo, normal, arm } = recipe(size);
    const set = {
      map: toTexture(albedo, { srgb: true, aniso: this.anisotropy }),
      normalMap: toTexture(normal, { aniso: this.anisotropy }),
      armMap: toTexture(arm, { aniso: this.anisotropy }),
    };
    this.maps[name] = set;
    return set;
  }

  async bakeAll(size = 512, onProgress = null) {
    const names = this.names();
    for (let i = 0; i < names.length; i++) {
      this.bake(names[i], size);
      onProgress?.((i + 1) / names.length, names[i]);
      // Yield to the browser so the loading bar animates instead of freezing.
      await new Promise((r) => setTimeout(r, 0));
    }
    return this.maps;
  }

  dispose() {
    for (const set of Object.values(this.maps)) {
      set.map?.dispose(); set.normalMap?.dispose(); set.armMap?.dispose();
    }
    this.maps = {};
  }
}

/** Small square gradient used for sprites (sparks, smoke, muzzle flash, glow). */
export function makeSpriteTexture(kind = 'glow', size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const half = size / 2;
  if (kind === 'glow') {
    const g = ctx.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  } else if (kind === 'smoke') {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - half, y - half) / half;
        const n = fbm(x / size * 5, y / size * 5, 5, 5, 42);
        const a = Math.max(0, 1 - d) * Math.max(0, 1 - d) * (0.35 + n * 0.9);
        const i = (y * size + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.min(255, a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === 'flash') {
    // Star-burst muzzle flash: bright core plus radiating spikes.
    const g = ctx.createRadialGradient(half, half, 0, half, half, half * 0.55);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,228,150,0.8)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,222,160,0.55)';
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      const len = half * (0.55 + Math.random() * 0.45);
      ctx.lineWidth = 2 + Math.random() * 4;
      ctx.beginPath();
      ctx.moveTo(half, half);
      ctx.lineTo(half + Math.cos(a) * len, half + Math.sin(a) * len);
      ctx.stroke();
    }
  } else if (kind === 'bullethole') {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - half, y - half) / half;
        const n = fbm(x / size * 8, y / size * 8, 4, 8, 88);
        const crater = d < 0.3 + n * 0.12 ? 1 : 0;
        const ring = Math.max(0, 1 - Math.abs(d - 0.42 - n * 0.16) * 5) * 0.5;
        const a = Math.min(1, crater + ring) * Math.max(0, 1 - d * 1.05);
        const i = (y * size + x) * 4;
        const v = crater ? 12 : 90;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
        img.data[i + 3] = Math.min(255, a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === 'blood') {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - half, y - half) / half;
        const n = fbm(x / size * 6, y / size * 6, 4, 6, 12);
        const a = Math.max(0, (1 - d) * (0.5 + n) - 0.28) * 1.6;
        const i = (y * size + x) * 4;
        img.data[i] = 150; img.data[i + 1] = 14; img.data[i + 2] = 14;
        img.data[i + 3] = Math.min(255, a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === 'spark') {
    const g = ctx.createLinearGradient(0, half, size, half);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,238,190,1)');
    g.addColorStop(0.6, 'rgba(255,170,60,0.9)');
    g.addColorStop(1, 'rgba(255,90,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, half - size * 0.06, size, size * 0.12);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = kind === 'bullethole' || kind === 'smoke' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
