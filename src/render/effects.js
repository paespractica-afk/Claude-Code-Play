// GPU-instanced effect systems: particles, decals, tracers, shell casings.
// Every system is a fixed-size ring buffer with zero per-frame allocation.

import * as THREE from 'three';
import { makeSpriteTexture } from './textures.js';
import { rand, randInt, clamp, clamp01 } from '../core/math.js';

/* ------------------------------------------------------- particle system -- */

const PARTICLE_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec2 iSize;
attribute float iRot;
attribute vec3 iColor;
attribute float iAlpha;
attribute vec3 iStretch;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vUv = uv;
  vColor = iColor;
  vAlpha = iAlpha;

  vec3 viewCenter = (modelViewMatrix * vec4(iPos, 1.0)).xyz;
  vec2 local = position.xy * iSize;

  #ifdef STRETCHED
    // Align the quad with the velocity direction in view space and trail it
    // BEHIND the particle, so a tracer reads as a streak coming from the muzzle
    // rather than a bar centred on the round.
    vec3 dirView = (modelViewMatrix * vec4(iStretch, 0.0)).xyz;
    float len = length(dirView.xy);
    vec2 axis = len > 0.0001 ? dirView.xy / len : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);
    float stretchLen = length(iStretch);
    float along = position.x - 0.5;            // 0 at the head, -1 at the tail
    vec2 offset = axis * (along * (iSize.x + stretchLen)) + perp * (position.y * iSize.y);
    viewCenter.xy += offset;
  #endif
  #ifndef STRETCHED
    float s = sin(iRot), c = cos(iRot);
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    viewCenter.xy += rotated;
  #endif

  gl_Position = projectionMatrix * vec4(viewCenter, 1.0);
}`;

const PARTICLE_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(t.rgb * vColor * uIntensity, a);
}`;

export class ParticleSystem {
  /**
   * @param {object} o { texture, capacity, blending, stretched, intensity, depthWrite }
   */
  constructor(o = {}) {
    this.capacity = o.capacity ?? 256;
    this.stretched = !!o.stretched;

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    base.dispose();

    const n = this.capacity;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.aStretch = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iSize', this.aSize);
    geo.setAttribute('iRot', this.aRot);
    geo.setAttribute('iColor', this.aColor);
    geo.setAttribute('iAlpha', this.aAlpha);
    geo.setAttribute('iStretch', this.aStretch);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uMap: { value: o.texture },
        uIntensity: { value: o.intensity ?? 1 },
      },
      transparent: true,
      depthWrite: o.depthWrite ?? false,
      depthTest: true,
      blending: o.blending ?? THREE.NormalBlending,
      defines: this.stretched ? { STRETCHED: '' } : {},
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? 5;
    this.geo = geo;
    this.material = mat;

    // Simulation state, kept in plain arrays alongside the GPU attributes.
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.life = new Float32Array(n); this.maxLife = new Float32Array(n);
    this.size0 = new Float32Array(n); this.size1 = new Float32Array(n);
    this.aspect = new Float32Array(n);
    this.rot = new Float32Array(n); this.rotVel = new Float32Array(n);
    this.drag = new Float32Array(n); this.grav = new Float32Array(n);
    this.alpha0 = new Float32Array(n); this.alpha1 = new Float32Array(n);
    this.cr = new Float32Array(n); this.cg = new Float32Array(n); this.cb = new Float32Array(n);
    this.cr1 = new Float32Array(n); this.cg1 = new Float32Array(n); this.cb1 = new Float32Array(n);
    this.active = new Uint8Array(n);
    this.stretchScale = new Float32Array(n);
    this.count = 0;
    this.cursor = 0;
    this.budget = 1.0;
  }

  /** Spawn one particle. Oldest is recycled when the buffer is full. */
  spawn(p) {
    if (Math.random() > this.budget) return -1;
    const n = this.capacity;
    let i = -1;
    for (let k = 0; k < n; k++) {
      const c = (this.cursor + k) % n;
      if (!this.active[c]) { i = c; break; }
    }
    if (i === -1) { i = this.cursor % n; }
    this.cursor = (i + 1) % n;

    this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z;
    this.vx[i] = p.vx ?? 0; this.vy[i] = p.vy ?? 0; this.vz[i] = p.vz ?? 0;
    this.maxLife[i] = p.life ?? 1;
    this.life[i] = this.maxLife[i];
    this.size0[i] = p.size ?? 0.2;
    this.size1[i] = p.sizeEnd ?? this.size0[i];
    this.aspect[i] = p.aspect ?? 1;
    this.rot[i] = p.rot ?? rand(0, Math.PI * 2);
    this.rotVel[i] = p.rotVel ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.grav[i] = p.gravity ?? 0;
    this.alpha0[i] = p.alpha ?? 1;
    this.alpha1[i] = p.alphaEnd ?? 0;
    const c = p.color ?? { r: 1, g: 1, b: 1 };
    this.cr[i] = c.r; this.cg[i] = c.g; this.cb[i] = c.b;
    const c1 = p.colorEnd ?? c;
    this.cr1[i] = c1.r; this.cg1[i] = c1.g; this.cb1[i] = c1.b;
    this.stretchScale[i] = p.stretch ?? 0;
    this.active[i] = 1;
    return i;
  }

  update(dt) {
    const n = this.capacity;
    let live = 0;
    const pos = this.aPos.array, size = this.aSize.array, rot = this.aRot.array;
    const col = this.aColor.array, alp = this.aAlpha.array, str = this.aStretch.array;
    for (let i = 0; i < n; i++) {
      if (!this.active[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.active[i] = 0; continue; }
      const t = 1 - this.life[i] / this.maxLife[i];

      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vy[i] *= d; this.vz[i] *= d;
      this.vy[i] -= this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;

      const j = live;
      pos[j * 3] = this.px[i]; pos[j * 3 + 1] = this.py[i]; pos[j * 3 + 2] = this.pz[i];
      const s = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      size[j * 2] = s * this.aspect[i]; size[j * 2 + 1] = s;
      rot[j] = this.rot[i];
      col[j * 3] = this.cr[i] + (this.cr1[i] - this.cr[i]) * t;
      col[j * 3 + 1] = this.cg[i] + (this.cg1[i] - this.cg[i]) * t;
      col[j * 3 + 2] = this.cb[i] + (this.cb1[i] - this.cb[i]) * t;
      alp[j] = this.alpha0[i] + (this.alpha1[i] - this.alpha0[i]) * t;
      const ss = this.stretchScale[i];
      str[j * 3] = this.vx[i] * ss; str[j * 3 + 1] = this.vy[i] * ss; str[j * 3 + 2] = this.vz[i] * ss;
      live++;
    }
    this.count = live;
    this.geo.instanceCount = live;
    if (live > 0) {
      this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aRot.needsUpdate = true;
      this.aColor.needsUpdate = true; this.aAlpha.needsUpdate = true; this.aStretch.needsUpdate = true;
    }
  }

  clear() { this.active.fill(0); this.count = 0; this.geo.instanceCount = 0; }
  dispose() { this.geo.dispose(); this.material.dispose(); }
}

/* ------------------------------------------------------------- decals ----- */

const DECAL_VERT = /* glsl */`
attribute float iAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
  vAlpha = iAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const DECAL_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(t.rgb * uColor, a);
}`;

export class DecalSystem {
  constructor(texture, capacity = 160, color = 0x1a1a1a) {
    this.capacity = capacity;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: { uMap: { value: texture }, uColor: { value: new THREE.Color(color) } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.alphas = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iAlpha', this.alphas);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.used = 0;
    this.cursor = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._n = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._budget = 1;
  }

  setBudget(v) { this._budget = clamp01(v); }

  add(px, py, pz, nx, ny, nz, size = 0.13, life = 45) {
    if (Math.random() > this._budget) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.used = Math.min(this.used + 1, this.capacity);
    this.mesh.count = this.used;

    this._n.set(nx, ny, nz).normalize();
    // Offset slightly along the normal so the quad never z-fights the wall.
    this._pos.set(px + this._n.x * 0.012, py + this._n.y * 0.012, pz + this._n.z * 0.012);
    const up = Math.abs(this._n.y) > 0.95 ? new THREE.Vector3(0, 0, 1) : this._up;
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._n);
    // Random roll keeps repeated holes from looking stamped.
    const roll = new THREE.Quaternion().setFromAxisAngle(this._n, rand(0, Math.PI * 2));
    this._q.premultiply(roll);
    const s = size * rand(0.82, 1.25);
    this._scale.set(s, s, s);
    this._m.compose(this._pos, this._q, this._scale);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alphas.array[i] = 1;
    this.alphas.needsUpdate = true;
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.used; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      // Hold full opacity, then fade over the last quarter of the lifetime.
      const t = this.life[i] / this.maxLife[i];
      const a = t <= 0 ? 0 : t < 0.25 ? t / 0.25 : 1;
      if (this.alphas.array[i] !== a) { this.alphas.array[i] = a; dirty = true; }
    }
    if (dirty) this.alphas.needsUpdate = true;
  }

  clear() {
    this.used = 0; this.cursor = 0; this.mesh.count = 0;
    this.life.fill(0); this.alphas.array.fill(0); this.alphas.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/* --------------------------------------------------------- shell casings -- */

export class ShellSystem {
  constructor(world, capacity = 40) {
    this.world = world;
    this.capacity = capacity;
    const geo = new THREE.CylinderGeometry(0.0045, 0.005, 0.021, 7, 1, false);
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8ab52, roughness: 0.32, metalness: 0.95 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = capacity;
    this.p = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.rotV = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.rested = new Uint8Array(capacity);
    this.cursor = 0;
    this._m = new THREE.Matrix4();
    this._e = new THREE.Euler();
    this._q = new THREE.Quaternion();
    this._pv = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.onBounce = null;
  }

  eject(x, y, z, vx, vy, vz) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.rot[i * 3] = rand(0, 6.28); this.rot[i * 3 + 1] = rand(0, 6.28); this.rot[i * 3 + 2] = rand(0, 6.28);
    this.rotV[i * 3] = rand(-22, 22); this.rotV[i * 3 + 1] = rand(-22, 22); this.rotV[i * 3 + 2] = rand(-22, 22);
    this.life[i] = 7;
    this.rested[i] = 0;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.mesh.setMatrixAt(i, this._hidden); continue; }
      const b = i * 3;
      if (!this.rested[i]) {
        this.v[b + 1] -= 22 * dt;
        const nx = this.p[b] + this.v[b] * dt;
        const ny = this.p[b + 1] + this.v[b + 1] * dt;
        const nz = this.p[b + 2] + this.v[b + 2] * dt;
        // Cheap floor collision: one downward ray from the previous position.
        if (this.v[b + 1] < 0) {
          const hit = this.world.raycast(this.p[b], this.p[b + 1], this.p[b + 2], 0, -1, 0, Math.max(0.02, this.p[b + 1] - ny + 0.02), 'solid');
          if (hit) {
            this.p[b + 1] = hit.point.y + 0.006;
            this.v[b + 1] *= -0.32;
            this.v[b] *= 0.55; this.v[b + 2] *= 0.55;
            this.rotV[b] *= 0.5; this.rotV[b + 1] *= 0.5; this.rotV[b + 2] *= 0.5;
            if (Math.abs(this.v[b + 1]) < 0.6) {
              this.rested[i] = 1;
              this.v[b] = this.v[b + 1] = this.v[b + 2] = 0;
              this.rotV[b] = this.rotV[b + 1] = this.rotV[b + 2] = 0;
              this.rot[b] = Math.PI / 2; // lie flat
            } else if (this.onBounce) {
              this.onBounce(this.p[b], this.p[b + 1], this.p[b + 2]);
            }
            this.p[b] = nx; this.p[b + 2] = nz;
          } else { this.p[b] = nx; this.p[b + 1] = ny; this.p[b + 2] = nz; }
        } else { this.p[b] = nx; this.p[b + 1] = ny; this.p[b + 2] = nz; }
        this.rot[b] += this.rotV[b] * dt;
        this.rot[b + 1] += this.rotV[b + 1] * dt;
        this.rot[b + 2] += this.rotV[b + 2] * dt;
      }
      this._pv.set(this.p[b], this.p[b + 1], this.p[b + 2]);
      this._e.set(this.rot[b], this.rot[b + 1], this.rot[b + 2]);
      this._q.setFromEuler(this._e);
      // Shrink away in the final second instead of blinking out.
      const fade = this.life[i] < 1 ? this.life[i] : 1;
      this._s.set(fade, fade, fade);
      this._m.compose(this._pv, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/* ------------------------------------------------------------ FX manager -- */

const SURFACE_FX = {
  concrete: { spark: 0.25, color: { r: 0.8, g: 0.78, b: 0.72 }, smoke: 1, decal: 0x141414 },
  concreteFloor: { spark: 0.25, color: { r: 0.8, g: 0.78, b: 0.72 }, smoke: 1, decal: 0x141414 },
  metal: { spark: 1.0, color: { r: 1.0, g: 0.85, b: 0.5 }, smoke: 0.35, decal: 0x0d0d0d },
  metalPanel: { spark: 1.0, color: { r: 1.0, g: 0.85, b: 0.5 }, smoke: 0.35, decal: 0x0d0d0d },
  paintedMetal: { spark: 0.8, color: { r: 1.0, g: 0.87, b: 0.55 }, smoke: 0.4, decal: 0x101010 },
  grate: { spark: 1.0, color: { r: 1.0, g: 0.85, b: 0.5 }, smoke: 0.2, decal: 0x0d0d0d },
  hazard: { spark: 0.7, color: { r: 1.0, g: 0.85, b: 0.5 }, smoke: 0.5, decal: 0x101010 },
  wood: { spark: 0.05, color: { r: 0.7, g: 0.5, b: 0.28 }, smoke: 0.8, decal: 0x231708 },
  tile: { spark: 0.3, color: { r: 0.9, g: 0.9, b: 0.92 }, smoke: 0.9, decal: 0x1a1a1a },
  marble: { spark: 0.3, color: { r: 0.95, g: 0.95, b: 0.95 }, smoke: 0.9, decal: 0x1a1a1a },
  brick: { spark: 0.15, color: { r: 0.8, g: 0.5, b: 0.35 }, smoke: 1.1, decal: 0x1b0f08 },
  sand: { spark: 0.0, color: { r: 0.85, g: 0.75, b: 0.5 }, smoke: 1.5, decal: 0x2a2113 },
  dirt: { spark: 0.0, color: { r: 0.6, g: 0.5, b: 0.35 }, smoke: 1.4, decal: 0x241c10 },
};

export class EffectsManager {
  constructor(scene, viewScene, collisionWorld, quality) {
    this.scene = scene;
    this.viewScene = viewScene;
    this.world = collisionWorld;
    const p = quality?.particles ?? 1;

    this.tex = {
      glow: makeSpriteTexture('glow', 128),
      smoke: makeSpriteTexture('smoke', 128),
      flash: makeSpriteTexture('flash', 256),
      hole: makeSpriteTexture('bullethole', 128),
      blood: makeSpriteTexture('blood', 128),
      spark: makeSpriteTexture('spark', 128),
    };

    this.sparks = new ParticleSystem({
      texture: this.tex.spark, capacity: Math.round(600 * p), stretched: true,
      blending: THREE.AdditiveBlending, intensity: 3.2, renderOrder: 6,
    });
    this.smoke = new ParticleSystem({
      texture: this.tex.smoke, capacity: Math.round(320 * p),
      blending: THREE.NormalBlending, intensity: 1, renderOrder: 4,
    });
    this.glow = new ParticleSystem({
      texture: this.tex.glow, capacity: Math.round(220 * p),
      blending: THREE.AdditiveBlending, intensity: 2.4, renderOrder: 7,
    });
    this.blood = new ParticleSystem({
      texture: this.tex.blood, capacity: Math.round(260 * p),
      blending: THREE.NormalBlending, intensity: 1, renderOrder: 5,
    });
    this.tracers = new ParticleSystem({
      texture: this.tex.spark, capacity: 220, stretched: true,
      blending: THREE.AdditiveBlending, intensity: 4.0, renderOrder: 8,
    });

    for (const s of [this.sparks, this.smoke, this.glow, this.blood, this.tracers]) {
      s.budget = clamp01(p);
      scene.add(s.mesh);
    }

    this.decals = new DecalSystem(this.tex.hole, quality?.decals ?? 160);
    scene.add(this.decals.mesh);
    this.bloodDecals = new DecalSystem(this.tex.blood, Math.round((quality?.decals ?? 160) * 0.5), 0x7a0a0a);
    scene.add(this.bloodDecals.mesh);

    this.shells = new ShellSystem(collisionWorld, 40);
    scene.add(this.shells.mesh);

    // View-model muzzle flash quad, drawn in the weapon scene.
    this.viewFlash = new ParticleSystem({
      texture: this.tex.flash, capacity: 12, blending: THREE.AdditiveBlending,
      intensity: 5.0, renderOrder: 20,
    });
    viewScene.add(this.viewFlash.mesh);
    this.worldFlash = new ParticleSystem({
      texture: this.tex.flash, capacity: 40, blending: THREE.AdditiveBlending,
      intensity: 4.0, renderOrder: 9,
    });
    scene.add(this.worldFlash.mesh);

    this.systems = [this.sparks, this.smoke, this.glow, this.blood, this.tracers, this.viewFlash, this.worldFlash];
  }

  setQuality(q) {
    const p = clamp01(q.particles);
    for (const s of this.systems) s.budget = p;
    this.decals.setBudget(p);
    this.bloodDecals.setBudget(p);
  }

  update(dt) {
    for (const s of this.systems) s.update(dt);
    this.decals.update(dt);
    this.bloodDecals.update(dt);
    this.shells.update(dt);
  }

  /** Bullet hitting the world. */
  impact(x, y, z, nx, ny, nz, surface = 'concrete', scale = 1) {
    const fx = SURFACE_FX[surface] || SURFACE_FX.concrete;

    const sparkCount = Math.round(randInt(4, 9) * fx.spark * scale);
    for (let i = 0; i < sparkCount; i++) {
      const sx = nx + rand(-0.75, 0.75), sy = ny + rand(-0.4, 0.95), sz = nz + rand(-0.75, 0.75);
      const sp = rand(3.5, 11);
      this.sparks.spawn({
        x, y, z, vx: sx * sp, vy: sy * sp, vz: sz * sp,
        life: rand(0.16, 0.42), size: 0.028, sizeEnd: 0.006, aspect: 1,
        color: fx.color, colorEnd: { r: 1, g: 0.28, b: 0.05 },
        alpha: 1, alphaEnd: 0, gravity: 15, drag: 2.4, stretch: 0.022,
      });
    }

    const smokeCount = Math.round(randInt(1, 3) * fx.smoke * scale);
    for (let i = 0; i < smokeCount; i++) {
      this.smoke.spawn({
        x: x + nx * 0.05, y: y + ny * 0.05, z: z + nz * 0.05,
        vx: nx * rand(0.4, 1.5) + rand(-0.4, 0.4),
        vy: ny * rand(0.4, 1.5) + rand(0.1, 0.7),
        vz: nz * rand(0.4, 1.5) + rand(-0.4, 0.4),
        life: rand(0.5, 1.3), size: rand(0.09, 0.18), sizeEnd: rand(0.5, 0.95),
        color: { r: 0.55, g: 0.53, b: 0.5 }, colorEnd: { r: 0.32, g: 0.31, b: 0.3 },
        alpha: 0.42, alphaEnd: 0, drag: 1.5, gravity: -0.4, rotVel: rand(-1.4, 1.4),
      });
    }

    this.glow.spawn({
      x: x + nx * 0.02, y: y + ny * 0.02, z: z + nz * 0.02,
      life: 0.09, size: 0.28 * scale, sizeEnd: 0.05,
      color: fx.color, alpha: 0.9, alphaEnd: 0,
    });

    this.decals.add(x, y, z, nx, ny, nz, 0.11 * scale, 40);
  }

  /** Bullet hitting a character. */
  bloodSpray(x, y, z, dx, dy, dz, amount = 1) {
    const n = Math.round(randInt(6, 12) * amount);
    for (let i = 0; i < n; i++) {
      const sp = rand(1.5, 6.5);
      this.blood.spawn({
        x, y, z,
        vx: dx * sp + rand(-1.6, 1.6), vy: dy * sp + rand(0.4, 2.6), vz: dz * sp + rand(-1.6, 1.6),
        life: rand(0.3, 0.8), size: rand(0.05, 0.14), sizeEnd: rand(0.02, 0.06),
        color: { r: 0.72, g: 0.06, b: 0.06 }, colorEnd: { r: 0.32, g: 0.02, b: 0.02 },
        alpha: 0.95, alphaEnd: 0, gravity: 11, drag: 1.4,
      });
    }
    this.blood.spawn({
      x, y, z, life: 0.22, size: 0.18 * amount, sizeEnd: 0.5 * amount,
      color: { r: 0.55, g: 0.04, b: 0.04 }, alpha: 0.55, alphaEnd: 0, drag: 3,
      vx: dx * 1.2, vy: dy * 1.2 + 0.5, vz: dz * 1.2,
    });
    // Splatter behind the target.
    const hit = this.world.raycast(x, y, z, dx, dy, dz, 3.2, 'solid');
    if (hit) this.bloodDecals.add(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, rand(0.25, 0.55), 25);
  }

  /** Muzzle flash in the world (for other characters). */
  muzzleWorld(x, y, z, dx, dy, dz, scale = 1) {
    this.worldFlash.spawn({
      x: x + dx * 0.25, y: y + dy * 0.25, z: z + dz * 0.25,
      life: 0.045, size: rand(0.35, 0.55) * scale, sizeEnd: rand(0.2, 0.3) * scale,
      color: { r: 1, g: 0.85, b: 0.55 }, alpha: 1, alphaEnd: 0.2, rot: rand(0, 6.28),
    });
    for (let i = 0; i < 3; i++) {
      this.sparks.spawn({
        x: x + dx * 0.3, y: y + dy * 0.3, z: z + dz * 0.3,
        vx: dx * rand(5, 13) + rand(-1.5, 1.5), vy: dy * rand(5, 13) + rand(-1, 1.5), vz: dz * rand(5, 13) + rand(-1.5, 1.5),
        life: rand(0.05, 0.12), size: 0.02, sizeEnd: 0.004,
        color: { r: 1, g: 0.8, b: 0.4 }, alpha: 1, alphaEnd: 0, drag: 4, stretch: 0.02,
      });
    }
  }

  /** Muzzle flash on the player's own weapon, in view space. */
  muzzleView(pos, scale = 1) {
    this.viewFlash.spawn({
      x: pos.x, y: pos.y, z: pos.z,
      life: 0.04, size: rand(0.10, 0.16) * scale, sizeEnd: rand(0.05, 0.08) * scale,
      color: { r: 1, g: 0.88, b: 0.62 }, alpha: 1, alphaEnd: 0.1, rot: rand(0, 6.28),
    });
    this.viewFlash.spawn({
      x: pos.x, y: pos.y, z: pos.z - 0.02,
      life: 0.07, size: rand(0.05, 0.08) * scale, sizeEnd: rand(0.14, 0.2) * scale,
      color: { r: 1, g: 0.6, b: 0.25 }, alpha: 0.55, alphaEnd: 0, rot: rand(0, 6.28),
    });
  }

  /** Gunsmoke lingering at the barrel after sustained fire. */
  barrelSmoke(x, y, z, amount = 1) {
    this.smoke.spawn({
      x, y, z,
      vx: rand(-0.1, 0.1), vy: rand(0.25, 0.6), vz: rand(-0.1, 0.1),
      life: rand(0.9, 1.9), size: rand(0.05, 0.1), sizeEnd: rand(0.35, 0.6),
      color: { r: 0.6, g: 0.6, b: 0.6 }, colorEnd: { r: 0.4, g: 0.4, b: 0.42 },
      alpha: 0.2 * amount, alphaEnd: 0, drag: 1.1, gravity: -0.5, rotVel: rand(-0.8, 0.8),
    });
  }

  explosion(x, y, z, radius = 5) {
    this.glow.spawn({
      x, y, z, life: 0.16, size: radius * 0.9, sizeEnd: radius * 1.6,
      color: { r: 1, g: 0.75, b: 0.35 }, alpha: 1, alphaEnd: 0,
    });
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), e = rand(-0.3, 1);
      const sp = rand(6, 22);
      this.sparks.spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: e * sp, vz: Math.sin(a) * sp,
        life: rand(0.3, 0.9), size: 0.045, sizeEnd: 0.01,
        color: { r: 1, g: 0.9, b: 0.6 }, colorEnd: { r: 1, g: 0.25, b: 0.04 },
        alpha: 1, alphaEnd: 0, gravity: 14, drag: 1.4, stretch: 0.02,
      });
    }
    for (let i = 0; i < 16; i++) {
      const a = rand(0, Math.PI * 2);
      this.smoke.spawn({
        x, y, z,
        vx: Math.cos(a) * rand(1, 5), vy: rand(0.5, 4), vz: Math.sin(a) * rand(1, 5),
        life: rand(1.2, 2.6), size: rand(0.4, 0.9), sizeEnd: rand(2.2, 4),
        color: { r: 0.35, g: 0.33, b: 0.32 }, colorEnd: { r: 0.18, g: 0.17, b: 0.17 },
        alpha: 0.75, alphaEnd: 0, drag: 1.1, gravity: -0.8, rotVel: rand(-1, 1),
      });
    }
  }

  /** Long, thin, fast-fading tracer streak. */
  tracer(x, y, z, dx, dy, dz, speed = 240, life = 0.09, color = { r: 1, g: 0.82, b: 0.45 }) {
    this.tracers.spawn({
      x, y, z, vx: dx * speed, vy: dy * speed, vz: dz * speed,
      life, size: 0.02, sizeEnd: 0.012, aspect: 1,
      // Stretch is in seconds of travel: a short, fast streak, not a long bar.
      color, colorEnd: color, alpha: 0.85, alphaEnd: 0, stretch: 0.006,
    });
  }

  clear() {
    for (const s of this.systems) s.clear();
    this.decals.clear();
    this.bloodDecals.clear();
    this.shells.clear();
  }

  dispose() {
    for (const s of this.systems) { s.mesh.parent?.remove(s.mesh); s.dispose(); }
    this.decals.mesh.parent?.remove(this.decals.mesh); this.decals.dispose();
    this.bloodDecals.mesh.parent?.remove(this.bloodDecals.mesh); this.bloodDecals.dispose();
    this.shells.mesh.parent?.remove(this.shells.mesh); this.shells.dispose();
    for (const t of Object.values(this.tex)) t.dispose();
  }
}
