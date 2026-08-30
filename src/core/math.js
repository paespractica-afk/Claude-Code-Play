// Small, allocation-free math helpers used across the engine.
// Everything here is deterministic and framerate-independent.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Framerate-independent exponential smoothing. `rate` = how much of the gap is closed per second. */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Same as damp but for angles, taking the shortest way round. */
export function dampAngle(current, target, rate, dt) {
  return current + shortAngle(current, target) * (1 - Math.exp(-rate * dt));
}

export function shortAngle(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

// Easing curves. Used for view-model transitions so nothing ever snaps.
export const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outElastic: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const p = 0.35;
    return Math.pow(2, -9 * t) * Math.sin(((t - p / 4) * TAU) / p) + 1;
  },
};

/**
 * A critically-damped-by-default spring. This is the backbone of every soft
 * motion in the game: recoil, sway, ADS blends, camera shake decay.
 * Integrated semi-implicitly and sub-stepped so it stays stable at any dt.
 */
export class Spring {
  constructor(stiffness = 120, damping = 18, value = 0) {
    this.k = stiffness;
    this.d = damping;
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
  set(v) { this.value = v; this.target = v; this.velocity = 0; return this; }
  nudge(v) { this.velocity += v; return this; }
  update(dt) {
    // Sub-step to keep the integrator stable if a frame hitches.
    const steps = dt > 1 / 90 ? Math.min(8, Math.ceil(dt * 120)) : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * this.k - this.velocity * this.d;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Three independent springs sharing one set of coefficients. */
export class Spring3 {
  constructor(stiffness = 120, damping = 18) {
    this.x = new Spring(stiffness, damping);
    this.y = new Spring(stiffness, damping);
    this.z = new Spring(stiffness, damping);
  }
  setTarget(x, y, z) { this.x.target = x; this.y.target = y; this.z.target = z; return this; }
  nudge(x, y, z) { this.x.nudge(x); this.y.nudge(y); this.z.nudge(z); return this; }
  reset() { this.x.set(0); this.y.set(0); this.z.set(0); return this; }
  update(dt) { this.x.update(dt); this.y.update(dt); this.z.update(dt); return this; }
  applyTo(v3) { v3.set(this.x.value, this.y.value, this.z.value); return v3; }
}

/** Deterministic PRNG (mulberry32) so recoil patterns can be seeded and reproducible. */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Gaussian sample (Box-Muller), used for aim error so spread feels organic, not uniform. */
export function gauss(mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** Reusable object pool — keeps the GC quiet during firefights. */
export class Pool {
  constructor(factory, reset, size = 32) {
    this.factory = factory;
    this.resetFn = reset;
    this.free = [];
    this.live = [];
    for (let i = 0; i < size; i++) this.free.push(factory());
  }
  acquire() {
    const o = this.free.length ? this.free.pop() : this.factory();
    this.live.push(o);
    return o;
  }
  release(o) {
    const i = this.live.indexOf(o);
    if (i === -1) return;
    this.live[i] = this.live[this.live.length - 1];
    this.live.pop();
    if (this.resetFn) this.resetFn(o);
    this.free.push(o);
  }
  releaseAll() {
    while (this.live.length) this.release(this.live[this.live.length - 1]);
  }
}
