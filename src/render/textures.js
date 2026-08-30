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

  // Sobel the height field into a tangent-space normal map.
  const strength = 2.6;
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

const RECIPES = {
  concrete: (size) => generate(size, (x, y) => {
    const s = 1 / size * 8;
    const base = fbm(x * s, y * s, 5, 8, 11) * 0.35 + 0.42;
    const agg = worley(x * s * 3, y * s * 3, 24, 7);
    const stain = fbm(x * s * 0.35, y * s * 0.35, 3, 3, 91);
    const pit = agg < 0.16 ? 0.55 : 1;
    const v = base * pit * (0.85 + stain * 0.3);
    const h = v * 0.7 + (1 - agg) * 0.3;
    return { r: v * 0.94, g: v * 0.95, b: v * 0.97, h, rough: 0.86 - agg * 0.1, ao: 0.75 + agg * 0.25, metal: 0 };
  }),

  concreteFloor: (size) => generate(size, (x, y) => {
    const s = 1 / size * 8;
    const grid = (x % (size / 2) < 2 || y % (size / 2) < 2) ? 0.68 : 1;
    const base = fbm(x * s, y * s, 5, 8, 33) * 0.3 + 0.4;
    const agg = worley(x * s * 4, y * s * 4, 32, 3);
    const v = base * grid * (agg < 0.12 ? 0.7 : 1);
    return { r: v * 0.98, g: v * 0.98, b: v, h: v * 0.5 + grid * 0.5, rough: 0.8, ao: grid * (0.8 + agg * 0.2), metal: 0 };
  }),

  metalPanel: (size) => generate(size, (x, y) => {
    const cell = size / 4;
    const gx = x % cell, gy = y % cell;
    const seam = (gx < 2.5 || gy < 2.5 || gx > cell - 2.5 || gy > cell - 2.5);
    const brushed = fbm(x * 0.35, y * 0.02, 3, 512, 5) * 0.16;
    const rust = Math.max(0, fbm(x / size * 5, y / size * 5, 4, 5, 71) - 0.56) * 2.6;
    const base = 0.42 + brushed;
    const r = base * (1 - rust) + rust * 0.42;
    const g = base * (1 - rust) + rust * 0.24;
    const b = base * (1 - rust) + rust * 0.14;
    // Bolt heads at the panel corners.
    const bx = Math.min(gx, cell - gx), by = Math.min(gy, cell - gy);
    const bolt = (bx < 7 && by < 7) ? Math.max(0, 1 - Math.hypot(bx - 3.5, by - 3.5) / 3.2) : 0;
    return {
      r: r + bolt * 0.16, g: g + bolt * 0.16, b: b + bolt * 0.18,
      h: (seam ? 0.28 : 0.6) + brushed * 1.2 + bolt * 0.35,
      rough: 0.32 + rust * 0.5 + brushed,
      metal: 0.92 - rust * 0.7,
      ao: seam ? 0.6 : 1,
    };
  }),

  paintedMetal: (size) => generate(size, (x, y) => {
    const s = 1 / size * 6;
    const chip = Math.max(0, worley(x * s * 5, y * s * 5, 30, 17) - 0.72) * 3.4;
    const dirt = fbm(x * s, y * s, 4, 6, 55) * 0.22;
    const paint = 0.32 - dirt;
    const v = paint * (1 - chip) + chip * 0.34;
    return {
      r: v * 0.72, g: v * 0.82, b: v * 0.9,
      h: 0.6 - chip * 0.3 + dirt,
      rough: 0.42 + chip * 0.35 + dirt,
      metal: chip * 0.8,
      ao: 1 - chip * 0.25,
    };
  }),

  tile: (size) => generate(size, (x, y) => {
    const cell = size / 8;
    const gx = x % cell, gy = y % cell;
    const grout = (gx < 2 || gy < 2);
    const id = Math.floor(x / cell) * 31 + Math.floor(y / cell) * 17;
    const shadeVar = (hash2(Math.floor(x / cell), Math.floor(y / cell), 13) - 0.5) * 0.1;
    const speck = fbm(x * 0.6, y * 0.6, 3, 256, id) * 0.08;
    const v = grout ? 0.24 : 0.62 + shadeVar + speck;
    return {
      r: v * (grout ? 0.95 : 1), g: v, b: v * (grout ? 0.92 : 1.03),
      h: grout ? 0.2 : 0.85,
      rough: grout ? 0.9 : 0.24,
      ao: grout ? 0.5 : 1,
      metal: 0,
    };
  }),

  wood: (size) => generate(size, (x, y) => {
    const plank = size / 5;
    const row = Math.floor(y / plank);
    const offset = (row % 2) * plank * 0.5;
    const px = (x + offset) % (plank * 2.2);
    const gap = (y % plank < 1.6) || (px < 1.6);
    const rings = Math.sin((x * 0.09 + fbm(x * 0.02, y * 0.05, 4, 64, row * 7) * 7)) * 0.5 + 0.5;
    const v = 0.3 + rings * 0.2;
    return {
      r: v * 1.28, g: v * 0.88, b: v * 0.56,
      h: gap ? 0.15 : 0.7 + rings * 0.2,
      rough: 0.62 + rings * 0.16,
      ao: gap ? 0.45 : 1,
      metal: 0,
    };
  }),

  sand: (size) => generate(size, (x, y) => {
    const s = 1 / size * 10;
    const dune = fbm(x * s * 0.4, y * s * 0.4, 4, 4, 3);
    const grain = fbm(x * 0.9, y * 0.9, 2, 256, 61) * 0.12;
    const v = 0.52 + dune * 0.22 + grain;
    return { r: v * 1.16, g: v * 1.0, b: v * 0.72, h: dune * 0.7 + grain * 2, rough: 0.94, ao: 0.85 + dune * 0.15, metal: 0 };
  }),

  brick: (size) => generate(size, (x, y) => {
    const bh = size / 10, bw = size / 5;
    const row = Math.floor(y / bh);
    const xo = (row % 2) * bw * 0.5;
    const lx = (x + xo) % bw, ly = y % bh;
    const mortar = lx < 3 || ly < 3;
    const id = row * 41 + Math.floor((x + xo) / bw) * 7;
    const tint = hash2(row, Math.floor((x + xo) / bw), 5) * 0.22;
    const grit = fbm(x * 0.4, y * 0.4, 3, 256, id) * 0.14;
    const v = mortar ? 0.4 + grit : 0.3 + tint + grit;
    return {
      r: mortar ? v : v * 1.6, g: mortar ? v : v * 0.9, b: mortar ? v * 0.98 : v * 0.72,
      h: mortar ? 0.22 : 0.8, rough: mortar ? 0.95 : 0.78, ao: mortar ? 0.5 : 1, metal: 0,
    };
  }),

  grate: (size) => generate(size, (x, y) => {
    const cell = size / 16;
    const gx = x % cell, gy = y % cell;
    const bar = gx < cell * 0.32 || gy < cell * 0.32;
    const v = bar ? 0.36 : 0.06;
    return { r: v, g: v * 1.02, b: v * 1.06, h: bar ? 0.9 : 0.05, rough: bar ? 0.4 : 0.9, metal: bar ? 0.9 : 0.1, ao: bar ? 1 : 0.28 };
  }),

  hazard: (size) => generate(size, (x, y) => {
    const stripe = ((x + y) % (size / 4)) < size / 8;
    const wear = fbm(x / size * 6, y / size * 6, 4, 6, 23);
    const scuff = Math.max(0, wear - 0.55) * 1.8;
    const r = stripe ? 0.72 : 0.07, g = stripe ? 0.56 : 0.07, b = stripe ? 0.05 : 0.08;
    return {
      r: r * (1 - scuff) + 0.2 * scuff, g: g * (1 - scuff) + 0.2 * scuff, b: b * (1 - scuff) + 0.2 * scuff,
      h: 0.5 + wear * 0.2, rough: 0.7 + scuff * 0.2, ao: 1 - scuff * 0.2, metal: 0.1,
    };
  }),

  marble: (size) => generate(size, (x, y) => {
    const s = 1 / size * 5;
    const vein = Math.abs(Math.sin(x * s * 3 + fbm(x * s, y * s, 5, 5, 9) * 9));
    const v = 0.68 - Math.pow(1 - vein, 8) * 0.42;
    return { r: v, g: v * 0.99, b: v * 0.96, h: 0.6 + vein * 0.1, rough: 0.16 + (1 - vein) * 0.2, ao: 1, metal: 0 };
  }),
};

/* --------------------------------------------------------------- library -- */

export class TextureLibrary {
  constructor(renderer) {
    this.renderer = renderer;
    this.maps = {};
    this.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
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
