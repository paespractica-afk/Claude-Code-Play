// Custom post-processing pipeline.
//
// Hand-rolled rather than EffectComposer so the ordering is exact:
//   scene (HDR + depth) -> SSAO -> bloom (progressive down/up-sample)
//   -> composite (ACES tonemap, grade, vignette, CA, grain, damage) -> FXAA
//
// Everything before the composite runs in linear HDR; everything after is sRGB.

import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/* ------------------------------------------------------------------ SSAO -- */

const SSAO_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uProj;
uniform vec2 uResolution;
uniform float uRadius;
uniform float uBias;
uniform float uIntensity;
uniform float uNear;
uniform float uFar;

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec3 viewPos(vec2 uv, float d) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uProjInv * clip;
  return v.xyz / v.w;
}

// Golden-angle spiral kernel: good coverage with few samples and no LUT.
const int SAMPLES = 14;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float d = texture2D(tDepth, vUv).r;
  if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }

  vec3 P = viewPos(vUv, d);
  // Reconstruct the normal from screen-space derivatives of view position.
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));

  float noise = hash12(gl_FragCoord.xy) * 6.2831853;
  float occlusion = 0.0;
  float radius = uRadius;

  for (int i = 0; i < SAMPLES; i++) {
    float fi = float(i);
    float ang = noise + fi * 2.399963; // golden angle
    float r = radius * sqrt((fi + 0.5) / float(SAMPLES));
    vec3 dir = vec3(cos(ang), sin(ang), 0.0);
    // Push the sample into the hemisphere around N.
    vec3 offset = dir * r;
    offset += N * r * 0.55;
    if (dot(offset, N) < 0.0) offset = -offset;

    vec3 sp = P + offset;
    vec4 clip = uProj * vec4(sp, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = texture2D(tDepth, suv).r;
    if (sd >= 0.9999) continue;
    vec3 sampleP = viewPos(suv, sd);
    float diff = sampleP.z - sp.z;
    // Only count geometry in front of the sample point, and fade with distance
    // so a distant wall doesn't darken a foreground object.
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(0.0001, abs(P.z - sampleP.z)));
    if (diff > uBias) occlusion += rangeCheck;
  }

  float ao = 1.0 - (occlusion / float(SAMPLES)) * uIntensity;
  gl_FragColor = vec4(clamp(ao, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tAO;
uniform vec2 uTexel;
uniform vec2 uDir;
void main() {
  // 9-tap gaussian, separable.
  float w[5];
  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621; w[3] = 0.054054; w[4] = 0.016216;
  float sum = texture2D(tAO, vUv).r * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * uTexel * float(i);
    sum += texture2D(tAO, vUv + o).r * w[i];
    sum += texture2D(tAO, vUv - o).r * w[i];
  }
  gl_FragColor = vec4(sum, 0.0, 0.0, 1.0);
}`;

/* ----------------------------------------------------------------- bloom -- */

const DOWNSAMPLE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform int uFirst;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  // Soft knee so the bloom ramps in instead of popping at the threshold.
  float soft = br - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.00001);
  float contrib = max(soft, br - uThreshold) / max(br, 0.00001);
  return c * contrib;
}

void main() {
  // 13-tap box arrangement (Jimenez / COD "next generation post processing").
  vec2 t = uTexel;
  vec3 a = texture2D(tSrc, vUv + vec2(-2.0, 2.0) * t).rgb;
  vec3 b = texture2D(tSrc, vUv + vec2( 0.0, 2.0) * t).rgb;
  vec3 c = texture2D(tSrc, vUv + vec2( 2.0, 2.0) * t).rgb;
  vec3 d = texture2D(tSrc, vUv + vec2(-2.0, 0.0) * t).rgb;
  vec3 e = texture2D(tSrc, vUv).rgb;
  vec3 f = texture2D(tSrc, vUv + vec2( 2.0, 0.0) * t).rgb;
  vec3 g = texture2D(tSrc, vUv + vec2(-2.0,-2.0) * t).rgb;
  vec3 h = texture2D(tSrc, vUv + vec2( 0.0,-2.0) * t).rgb;
  vec3 i = texture2D(tSrc, vUv + vec2( 2.0,-2.0) * t).rgb;
  vec3 j = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * t).rgb;
  vec3 k = texture2D(tSrc, vUv + vec2( 1.0, 1.0) * t).rgb;
  vec3 l = texture2D(tSrc, vUv + vec2(-1.0,-1.0) * t).rgb;
  vec3 m = texture2D(tSrc, vUv + vec2( 1.0,-1.0) * t).rgb;

  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;

  if (uFirst == 1) col = prefilter(col);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

const UPSAMPLE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  // 3x3 tent filter — the classic progressive-upsample bloom kernel.
  vec2 t = uTexel * uRadius;
  vec3 col = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * t).rgb * 1.0;
  col += texture2D(tSrc, vUv + vec2( 0.0, 1.0) * t).rgb * 2.0;
  col += texture2D(tSrc, vUv + vec2( 1.0, 1.0) * t).rgb * 1.0;
  col += texture2D(tSrc, vUv + vec2(-1.0, 0.0) * t).rgb * 2.0;
  col += texture2D(tSrc, vUv).rgb * 4.0;
  col += texture2D(tSrc, vUv + vec2( 1.0, 0.0) * t).rgb * 2.0;
  col += texture2D(tSrc, vUv + vec2(-1.0,-1.0) * t).rgb * 1.0;
  col += texture2D(tSrc, vUv + vec2( 0.0,-1.0) * t).rgb * 2.0;
  col += texture2D(tSrc, vUv + vec2( 1.0,-1.0) * t).rgb * 1.0;
  gl_FragColor = vec4(col / 16.0, 1.0);
}`;

/* ------------------------------------------------------------- composite -- */

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAO;
uniform vec2 uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uBloom;
uniform float uAOStrength;
uniform float uVignette;
uniform float uChroma;
uniform float uGrain;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uDamage;      // 0..1 red edge + desaturation when hurt
uniform float uFlash;       // white flash (flashbang / explosions)
uniform float uHitFlash;    // brief red pulse on taking damage
uniform float uAdrenaline;  // low-health pulse
uniform float uSharpen;
uniform float uScopeDark;   // darkens the frame edges while aiming
uniform float uAberrationBoost;

// ACES fitted (Stephen Hill). Richer highlight roll-off than the cheap variant.
const mat3 ACESInput = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACESOutput = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFitted(vec3 color) {
  color = ACESInput * color;
  color = RRTAndODTFit(color);
  color = ACESOutput * color;
  return clamp(color, 0.0, 1.0);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = vUv;
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);

  // --- Chromatic aberration: radial, stronger at the edges ---
  float ca = uChroma * (0.0016 + uAberrationBoost * 0.006);
  vec3 scene;
  if (ca > 0.00001) {
    vec2 off = centered * r2 * ca * 6.0;
    scene.r = texture2D(tScene, uv - off).r;
    scene.g = texture2D(tScene, uv).g;
    scene.b = texture2D(tScene, uv + off).b;
  } else {
    scene = texture2D(tScene, uv).rgb;
  }

  // --- Ambient occlusion (multiplied before tonemapping) ---
  float ao = texture2D(tAO, uv).r;
  ao = mix(1.0, ao, uAOStrength);
  scene *= ao;

  // --- Bloom ---
  vec3 bloom = texture2D(tBloom, uv).rgb;
  scene += bloom * uBloom;

  // --- Sharpen (unsharp mask on the HDR buffer, before tonemap) ---
  if (uSharpen > 0.001) {
    vec2 t = 1.0 / uResolution;
    vec3 blur = texture2D(tScene, uv + vec2(t.x, 0.0)).rgb
              + texture2D(tScene, uv - vec2(t.x, 0.0)).rgb
              + texture2D(tScene, uv + vec2(0.0, t.y)).rgb
              + texture2D(tScene, uv - vec2(0.0, t.y)).rgb;
    scene += (scene - blur * 0.25) * uSharpen;
  }

  // --- Exposure + tonemap ---
  vec3 col = acesFitted(scene * uExposure);

  // --- Grade: contrast around mid grey, saturation, lift/gain ---
  col = (col - 0.5) * uContrast + 0.5;
  float l = luma(col);
  col = mix(vec3(l), col, uSaturation);
  col = col * uGain + uLift;
  col = clamp(col, 0.0, 1.0);

  // --- Damage feedback ---
  if (uDamage > 0.001) {
    float edge = smoothstep(0.06, 0.42, r2);
    vec3 blood = vec3(0.55, 0.03, 0.03);
    col = mix(col, blood, edge * uDamage * 0.8);
    col = mix(vec3(luma(col)), col, 1.0 - uDamage * 0.45);
  }
  if (uAdrenaline > 0.001) {
    float pulse = 0.5 + 0.5 * sin(uTime * 5.5);
    float edge = smoothstep(0.02, 0.35, r2);
    col += vec3(0.22, 0.0, 0.0) * edge * uAdrenaline * pulse;
  }
  col = mix(col, vec3(0.85, 0.12, 0.12), uHitFlash * 0.55);
  col = mix(col, vec3(1.0), uFlash);

  // --- Vignette + scope darkening ---
  float vig = 1.0 - uVignette * smoothstep(0.12, 0.78, r2);
  col *= vig;
  if (uScopeDark > 0.001) col *= 1.0 - smoothstep(0.05, 0.3, r2) * uScopeDark;

  // --- Film grain (animated, luminance-weighted so shadows stay clean) ---
  if (uGrain > 0.0001) {
    float n = hash13(vec3(gl_FragCoord.xy, fract(uTime) * 91.7)) - 0.5;
    // Weight grain toward the midtones; shadows stay clean, highlights stay crisp.
    float lg = luma(col);
    col += n * uGrain * (0.25 + 4.0 * lg * (1.0 - lg));
  }

  gl_FragColor = vec4(toSRGB(clamp(col, 0.0, 1.0)), 1.0);
}`;

/* ------------------------------------------------------------------ FXAA -- */

const FXAA_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;

#define EDGE_MIN (1.0/128.0)
#define EDGE_MAX (1.0/8.0)
#define SPAN_MAX 8.0

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;

  float lNW = lum(rgbNW), lNE = lum(rgbNE), lSW = lum(rgbSW), lSE = lum(rgbSE), lM = lum(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  if (lMax - lMin < max(EDGE_MIN, lMax * EDGE_MAX)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * EDGE_MAX, EDGE_MIN);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(tDiffuse, vUv + dir * -0.5).rgb +
    texture2D(tDiffuse, vUv + dir * 0.5).rgb);

  float lB = lum(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}`;

/* ------------------------------------------------------------- pipeline --- */

function makeMaterial(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

export class PostPipeline {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.enabled = true;
    this.opts = {
      bloom: true,
      ssao: true,
      fxaa: true,
      bloomStrength: 0.42,
      bloomThreshold: 1.6,
      bloomKnee: 0.55,
      bloomRadius: 1.0,
      aoStrength: 0.85,
      aoRadius: 1.1,
      exposure: 1.0,
      ...options,
    };
    this.mipCount = 6;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this._buildTargets(1, 1);
    this._buildMaterials();

    // Live-tunable grade, driven by the map and by gameplay events.
    this.grade = {
      exposure: 1.0, contrast: 1.04, saturation: 1.06,
      lift: new THREE.Vector3(0, 0, 0),
      gain: new THREE.Vector3(1, 1, 1),
      vignette: 0.42, chroma: 1.0, grain: 0.022, sharpen: 0.25,
    };
    this.fx = { damage: 0, flash: 0, hitFlash: 0, adrenaline: 0, scopeDark: 0, aberrationBoost: 0 };
  }

  _rt(w, h, opts = {}) {
    return new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: opts.type ?? THREE.HalfFloatType,
      depthBuffer: !!opts.depth,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
  }

  _buildTargets(w, h) {
    this.width = w; this.height = h;

    this.sceneRT = this._rt(w, h, { depth: true });
    this.sceneRT.depthTexture = new THREE.DepthTexture(w, h);
    this.sceneRT.depthTexture.format = THREE.DepthFormat;
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT.depthTexture.minFilter = THREE.NearestFilter;
    this.sceneRT.depthTexture.magFilter = THREE.NearestFilter;

    const aw = Math.max(1, w >> 1), ah = Math.max(1, h >> 1);
    this.aoRT = this._rt(aw, ah, { type: THREE.UnsignedByteType });
    this.aoBlurRT = this._rt(aw, ah, { type: THREE.UnsignedByteType });
    this.aoBlurRT2 = this._rt(aw, ah, { type: THREE.UnsignedByteType });

    this.mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < this.mipCount; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      this.mips.push({ down: this._rt(mw, mh), up: this._rt(mw, mh), w: mw, h: mh });
      if (mw <= 2 || mh <= 2) break;
    }

    this.ldrRT = this._rt(w, h, { type: THREE.UnsignedByteType });

    this.whiteAO = this.whiteAO || (() => {
      const d = new Uint8Array([255, 255, 255, 255]);
      const t = new THREE.DataTexture(d, 1, 1);
      t.needsUpdate = true;
      return t;
    })();
  }

  _buildMaterials() {
    this.ssaoMat = makeMaterial(SSAO_FRAG, {
      tDepth: { value: null },
      uProjInv: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2() },
      uRadius: { value: 0.9 },
      uBias: { value: 0.035 },
      uIntensity: { value: 1.25 },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
    });

    this.blurMat = makeMaterial(BLUR_FRAG, {
      tAO: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDir: { value: new THREE.Vector2(1, 0) },
    });

    this.downMat = makeMaterial(DOWNSAMPLE_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.6 },
      uFirst: { value: 0 },
    });

    this.upMat = makeMaterial(UPSAMPLE_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.1 },
    });
    this.upMat.blending = THREE.AdditiveBlending;
    this.upMat.transparent = true;

    this.compositeMat = makeMaterial(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      tAO: { value: null },
      uResolution: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uExposure: { value: 1 },
      uBloom: { value: 0.55 },
      uAOStrength: { value: 0.7 },
      uVignette: { value: 0.42 },
      uChroma: { value: 1 },
      uGrain: { value: 0.035 },
      uSaturation: { value: 1.06 },
      uContrast: { value: 1.04 },
      uLift: { value: new THREE.Vector3() },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uDamage: { value: 0 },
      uFlash: { value: 0 },
      uHitFlash: { value: 0 },
      uAdrenaline: { value: 0 },
      uSharpen: { value: 0.25 },
      uScopeDark: { value: 0 },
      uAberrationBoost: { value: 0 },
    });

    this.fxaaMat = makeMaterial(FXAA_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });

    this.copyMat = makeMaterial(
      'precision highp float; varying vec2 vUv; uniform sampler2D tDiffuse; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
      { tDiffuse: { value: null } },
    );
  }

  setSize(w, h) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.width && h === this.height) return;
    this._disposeTargets();
    this._buildTargets(w, h);
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.scene, this.camera);
  }

  /** Render the world into the HDR buffer. Call before `composite`. */
  renderScene(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);
  }

  _renderSSAO(camera) {
    if (!this.opts.ssao) return this.whiteAO;
    const u = this.ssaoMat.uniforms;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uResolution.value.set(this.aoRT.width, this.aoRT.height);
    u.uRadius.value = this.opts.aoRadius;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    this._blit(this.ssaoMat, this.aoRT);

    const bu = this.blurMat.uniforms;
    bu.uTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    bu.tAO.value = this.aoRT.texture;
    bu.uDir.value.set(1, 0);
    this._blit(this.blurMat, this.aoBlurRT);
    bu.tAO.value = this.aoBlurRT.texture;
    bu.uDir.value.set(0, 1);
    this._blit(this.blurMat, this.aoBlurRT2);
    return this.aoBlurRT2.texture;
  }

  _renderBloom() {
    if (!this.opts.bloom || !this.mips.length) return null;
    const du = this.downMat.uniforms;
    du.uThreshold.value = this.opts.bloomThreshold;
    du.uKnee.value = this.opts.bloomKnee;

    let src = this.sceneRT;
    for (let i = 0; i < this.mips.length; i++) {
      du.tSrc.value = src.texture;
      du.uTexel.value.set(1 / src.width, 1 / src.height);
      du.uFirst.value = i === 0 ? 1 : 0;
      this._blit(this.downMat, this.mips[i].down);
      src = this.mips[i].down;
    }

    // Progressive upsample: start at the smallest mip, add into each larger one.
    const uu = this.upMat.uniforms;
    uu.uRadius.value = this.opts.bloomRadius;
    const last = this.mips.length - 1;
    // Seed the top of the chain.
    this.copyMat.uniforms.tDiffuse.value = this.mips[last].down.texture;
    this._blit(this.copyMat, this.mips[last].up);

    for (let i = last - 1; i >= 0; i--) {
      // Base = this mip's downsample, plus the (blurred) larger mip above it.
      this.copyMat.uniforms.tDiffuse.value = this.mips[i].down.texture;
      this._blit(this.copyMat, this.mips[i].up);
      uu.tSrc.value = this.mips[i + 1].up.texture;
      uu.uTexel.value.set(1 / this.mips[i + 1].w, 1 / this.mips[i + 1].h);
      // Additive blend, so don't clear first.
      this.quad.material = this.upMat;
      this.renderer.setRenderTarget(this.mips[i].up);
      this.renderer.render(this.scene, this.camera);
    }
    return this.mips[0].up.texture;
  }

  /** Run the full post chain and present to the canvas. */
  composite(camera, elapsed) {
    const r = this.renderer;
    const aoTex = this._renderSSAO(camera);
    const bloomTex = this._renderBloom();

    const u = this.compositeMat.uniforms;
    const g = this.grade;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = bloomTex || this.whiteAO;
    u.tAO.value = aoTex;
    u.uResolution.value.set(this.width, this.height);
    u.uTime.value = elapsed;
    u.uExposure.value = g.exposure * this.opts.exposure;
    u.uBloom.value = bloomTex ? this.opts.bloomStrength : 0;
    u.uAOStrength.value = this.opts.ssao ? this.opts.aoStrength : 0;
    u.uVignette.value = g.vignette;
    u.uChroma.value = g.chroma;
    u.uGrain.value = g.grain;
    u.uSaturation.value = g.saturation;
    u.uContrast.value = g.contrast;
    u.uLift.value.copy(g.lift);
    u.uGain.value.copy(g.gain);
    u.uSharpen.value = g.sharpen;
    u.uDamage.value = this.fx.damage;
    u.uFlash.value = this.fx.flash;
    u.uHitFlash.value = this.fx.hitFlash;
    u.uAdrenaline.value = this.fx.adrenaline;
    u.uScopeDark.value = this.fx.scopeDark;
    u.uAberrationBoost.value = this.fx.aberrationBoost;

    if (this.opts.fxaa) {
      this._blit(this.compositeMat, this.ldrRT);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture;
      this.fxaaMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      this.quad.material = this.fxaaMat;
      r.setRenderTarget(null);
      r.clear(true, false, false);
      r.render(this.scene, this.camera);
    } else {
      this.quad.material = this.compositeMat;
      r.setRenderTarget(null);
      r.clear(true, false, false);
      r.render(this.scene, this.camera);
    }
    r.setRenderTarget(null);
  }

  _disposeTargets() {
    const kill = (rt) => { if (rt) { rt.depthTexture?.dispose(); rt.dispose(); } };
    kill(this.sceneRT); kill(this.aoRT); kill(this.aoBlurRT); kill(this.aoBlurRT2); kill(this.ldrRT);
    for (const m of this.mips || []) { kill(m.down); kill(m.up); }
    this.mips = [];
  }

  dispose() {
    this._disposeTargets();
    this.whiteAO?.dispose();
    for (const m of [this.ssaoMat, this.blurMat, this.downMat, this.upMat, this.compositeMat, this.fxaaMat, this.copyMat]) m?.dispose();
    this.quad.geometry.dispose();
  }
}
