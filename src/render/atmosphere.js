// Atmosphere: drifting dust and fake volumetric light shafts.
//
// Both are cheap tricks that do a disproportionate amount of work for how a
// space feels — dust gives the air volume, and shafts give the lights presence.

import * as THREE from 'three';
import { rand, clamp01 } from '../core/math.js';

const SHAFT_VERT = /* glsl */`
varying float vFade;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 toEye = normalize(cameraPosition - world.xyz);
  // A cone read edge-on is a bright sheet; read end-on it should disappear.
  vec3 axis = normalize((modelMatrix * vec4(0.0, -1.0, 0.0, 0.0)).xyz);
  vFade = 1.0 - abs(dot(toEye, axis));
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SHAFT_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uIntensity;
varying float vFade;
varying vec2 vUv;
void main() {
  // Fade along the cone's length and toward its silhouette edges.
  float lengthFade = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.45, 1.0, vUv.y));
  float a = lengthFade * pow(clamp(vFade, 0.0, 1.0), 1.6) * uIntensity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}`;

export class Atmosphere {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.renderOrder = 3;
    scene.add(this.group);
    this.shafts = [];
    this.dust = null;
    this.dustCount = 0;
    this._center = new THREE.Vector3();
    this.enabled = true;
  }

  /** A soft cone of light beneath a fixture. */
  addShaft(x, y, z, { radius = 1.6, length = 5, color = 0xffe6c0, intensity = 0.10 } = {}) {
    const geo = new THREE.ConeGeometry(radius, length, 18, 1, true);
    // Cone points +Y by default; flip so it opens downward from the fixture.
    geo.translate(0, -length / 2, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: intensity },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this.shafts.push(mesh);
    return mesh;
  }

  /**
   * Dust motes that follow the camera in a moving box, so a modest particle
   * count covers the whole map without ever running out.
   */
  buildDust(count = 900, opts = {}) {
    this.disposeDust();
    const n = Math.max(0, Math.round(count));
    if (!n) return;
    this.dustCount = n;
    this.dustRange = opts.range ?? 22;
    this.dustHeight = opts.height ?? 9;

    const positions = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = rand(-this.dustRange, this.dustRange);
      positions[i * 3 + 1] = rand(0, this.dustHeight);
      positions[i * 3 + 2] = rand(-this.dustRange, this.dustRange);
      seeds[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uRange: { value: this.dustRange },
        uHeight: { value: this.dustHeight },
        uColor: { value: new THREE.Color(opts.color ?? 0xd8ccb4) },
        uOpacity: { value: opts.opacity ?? 0.30 },
        uSize: { value: opts.size ?? 34 },
      },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uCenter;
        uniform float uRange;
        uniform float uHeight;
        uniform float uSize;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          // Slow drift, then wrap into a box that follows the camera.
          p.x += sin(uTime * 0.11 + aSeed * 31.0) * 1.6;
          p.y += sin(uTime * 0.07 + aSeed * 17.0) * 0.7 + uTime * 0.05 * (0.4 + aSeed);
          p.z += cos(uTime * 0.09 + aSeed * 23.0) * 1.6;
          p.x = mod(p.x - uCenter.x + uRange, uRange * 2.0) - uRange + uCenter.x;
          p.z = mod(p.z - uCenter.z + uRange, uRange * 2.0) - uRange + uCenter.z;
          p.y = mod(p.y - uCenter.y + uHeight * 0.5, uHeight) - uHeight * 0.5 + uCenter.y;

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dist = -mv.z;
          // Fade in the distance and very close up, so motes never pop.
          vAlpha = smoothstep(0.6, 2.2, dist) * (1.0 - smoothstep(uRange * 0.55, uRange, dist))
                 * (0.35 + aSeed * 0.65);
          gl_PointSize = (uSize / max(dist, 0.35)) * (0.5 + aSeed);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = (1.0 - r * 4.0) * vAlpha * uOpacity;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 4;
    this.group.add(this.dust);
  }

  update(dt, cameraPos, elapsed) {
    if (!this.dust) return;
    const u = this.dust.material.uniforms;
    u.uTime.value = elapsed;
    u.uCenter.value.set(cameraPos.x, cameraPos.y, cameraPos.z);
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
  }

  disposeDust() {
    if (!this.dust) return;
    this.group.remove(this.dust);
    this.dust.geometry.dispose();
    this.dust.material.dispose();
    this.dust = null;
  }

  clear() {
    this.disposeDust();
    for (const s of this.shafts) {
      this.group.remove(s);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.shafts.length = 0;
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
  }
}
