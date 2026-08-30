// Renderer, camera rig, environment and light management.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { PostPipeline } from './post.js';
import { QUALITY } from '../core/settings.js';
import { clamp, damp } from '../core/math.js';

export class RenderContext {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,        // we run our own AA in the post chain
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // the composite pass tonemaps
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x05070c, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(90, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';

    // The view model lives in its own scene+camera so a weapon can never clip
    // into a wall, and so it gets its own near plane and FOV.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(65, 1, 0.008, 12);

    this.post = new PostPipeline(this.renderer, {});
    this.quality = QUALITY[settings.quality] || QUALITY.high;

    this._buildLights();
    this._buildSky();

    this.pixelRatioCap = 2;
    this.dynamicRes = 1;
    this._resTarget = 1;
    this.applyQuality(settings);
    this.resize();
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x8fb4ff, 0x2b2118, 0.35);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 160;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.2;
    this.sun.position.set(40, 70, 25);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Fill light opposite the sun keeps shadowed faces readable without
    // flattening the image the way raw ambient does.
    this.fill = new THREE.DirectionalLight(0x6d8fc8, 0.35);
    this.fill.position.set(-30, 24, -40);
    this.scene.add(this.fill);

    // Lights that follow the player: a subtle bounce so interiors never go
    // fully black, and a muzzle flash light we pulse when firing.
    this.playerBounce = new THREE.PointLight(0xbfd4ff, 0.0, 9, 2);
    this.scene.add(this.playerBounce);
    this.muzzleLight = new THREE.PointLight(0xffcf88, 0, 16, 2.0);
    this.muzzleLight.visible = false;
    this.scene.add(this.muzzleLight);

    // The view model hangs off the camera itself, so it stays locked to the
    // screen as the player looks around, and its lighting never swims.
    this.viewScene.add(this.viewCamera);
    this.viewRig = new THREE.Group();
    this.viewCamera.add(this.viewRig);

    this.viewMuzzleLight = new THREE.PointLight(0xffcf88, 0, 3, 2.0);
    this.viewMuzzleLight.visible = false;
    this.viewScene.add(this.viewMuzzleLight);
    this.viewAmbient = new THREE.HemisphereLight(0xbcc8d8, 0x312c26, 2.2);
    this.viewScene.add(this.viewAmbient);

    const attachDirectional = (light, pos, targetPos) => {
      light.position.set(pos[0], pos[1], pos[2]);
      light.target.position.set(targetPos[0], targetPos[1], targetPos[2]);
      this.viewCamera.add(light);
      this.viewCamera.add(light.target);
    };
    // The weapon sits to the lower right of the camera, so the key has to come
    // from the upper LEFT to light the faces the player actually sees.
    const gun = [0.12, -0.06, -0.55];
    this.viewKey = new THREE.DirectionalLight(0xfff4e8, 7.0);
    attachDirectional(this.viewKey, [-1.0, 1.1, 0.6], gun);
    this.viewFill = new THREE.DirectionalLight(0xffd9b0, 2.2);
    attachDirectional(this.viewFill, [1.3, -0.35, 0.9], gun);
    this.viewRim = new THREE.DirectionalLight(0xa8c4e6, 2.6);
    attachDirectional(this.viewRim, [0.7, 0.7, -1.7], gun);
  }

  _buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(6000);
    this.sky.material.depthWrite = false;
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    // Ambient light comes from an art-directed gradient, not from the raw sky.
    // Lighting an interior with a photographic sky dyes every upward face blue;
    // an authored three-stop gradient keeps each map's ambient under control.
    // Built as an equirectangular data texture so there is no scene render or
    // shader compile between the numbers and the probe.
    this._probeW = 64;
    this._probeH = 32;
    this._probeData = new Float32Array(this._probeW * this._probeH * 4);
    this._probeTex = new THREE.DataTexture(
      this._probeData, this._probeW, this._probeH,
      THREE.RGBAFormat, THREE.FloatType,
    );
    this._probeTex.mapping = THREE.EquirectangularReflectionMapping;
    this._probeTex.colorSpace = THREE.LinearSRGBColorSpace;
    this._probeTex.minFilter = THREE.LinearFilter;
    this._probeTex.magFilter = THREE.LinearFilter;
    this._probeTex.needsUpdate = true;
  }

  /** Paint the equirectangular ambient probe from a three-stop gradient. */
  _writeProbe({ top, horizon, bottom, boost = 1 }) {
    const W = this._probeW, H = this._probeH;
    // THREE.Color already converts an sRGB hex into the linear working space,
    // so no further conversion is needed here.
    const cTop = new THREE.Color(top);
    const cHor = new THREE.Color(horizon);
    const cBot = new THREE.Color(bottom);
    const d = this._probeData;
    const tmp = new THREE.Color();
    for (let y = 0; y < H; y++) {
      // Equirectangular V maps to polar angle: v=0 is straight up.
      const theta = (y + 0.5) / H * Math.PI;
      const up = Math.cos(theta);
      if (up >= 0) tmp.copy(cHor).lerp(cTop, Math.pow(up, 0.65)).multiplyScalar(boost);
      else tmp.copy(cHor).lerp(cBot, Math.pow(-up, 0.55));
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        d[i] = tmp.r; d[i + 1] = tmp.g; d[i + 2] = tmp.b; d[i + 3] = 1;
      }
    }
    this._probeTex.needsUpdate = true;
  }

  /**
   * Apply an environment preset from a map definition.
   * Regenerates the IBL probe, so call it on map load, not per frame.
   */
  applyEnvironment(env = {}) {
    const {
      turbidity = 6, rayleigh = 2.2, mieCoefficient = 0.006, mieDirectionalG = 0.82,
      elevation = 24, azimuth = 140,
      sunColor = 0xfff1dc, sunIntensity = 2.6,
      hemiSky = 0x8fb4ff, hemiGround = 0x2b2118, hemiIntensity = 0.35,
      fogColor = 0x9fb6d8, fogDensity = 0.008,
      exposure = 1.0, grade = {}, showSky = true,
      backgroundColor = null,
    } = env;

    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

    for (const sky of [this.sky]) {
      const u = sky.material.uniforms;
      u.turbidity.value = turbidity;
      u.rayleigh.value = rayleigh;
      u.mieCoefficient.value = mieCoefficient;
      u.mieDirectionalG.value = mieDirectionalG;
      u.sunPosition.value.copy(sunDir);
    }
    this.sky.visible = showSky;

    this.sun.position.copy(sunDir).multiplyScalar(120);
    this.sun.color.set(sunColor);
    this.sun.intensity = sunIntensity;
    this.hemi.color.set(hemiSky);
    this.hemi.groundColor.set(hemiGround);
    this.hemi.intensity = hemiIntensity;
    this.fill.color.set(hemiSky);
    this.fill.position.copy(sunDir).multiplyScalar(-80).setY(30);

    this.scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    if (backgroundColor !== null) this.scene.background = new THREE.Color(backgroundColor);
    else this.scene.background = null;

    // Regenerate the image-based lighting probe from the authored gradient.
    const probe = env.probe || {};
    this._writeProbe({
      top: probe.top ?? hemiSky,
      horizon: probe.horizon ?? 0x8d8f92,
      bottom: probe.bottom ?? hemiGround,
      boost: probe.boost ?? 1.0,
    });
    this.envRT?.dispose();
    try {
      this.envRT = this.pmrem.fromEquirectangular(this._probeTex);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = env.envIntensity ?? 1.0;
      // The view model lives in its own scene and needs the same probe, or
      // every metal part on the weapon renders black.
      this.viewScene.environment = this.envRT.texture;
      // Clamped so a dim map cannot leave the weapon a black silhouette.
      this.viewScene.environmentIntensity = Math.max(1.2, Math.min(2.0, (env.envIntensity ?? 1.0) * 0.8));
    } catch {
      // IBL is a bonus, never a hard requirement.
      this.scene.environment = null;
      this.viewScene.environment = null;
    }

    this.post.opts.exposure = exposure;
    Object.assign(this.post.grade, grade);
    this.envSunDir = sunDir;
    return sunDir;
  }

  applyQuality(settings) {
    const q = QUALITY[settings.quality] || QUALITY.high;
    this.quality = q;
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    if (q.shadows && this.sun.shadow.mapSize.width !== q.shadowMap) {
      this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.post.opts.bloom = q.bloom && settings.bloom !== false;
    this.post.opts.ssao = settings.quality !== 'low';
    this.post.opts.fxaa = true;
    this.post.grade.grain = settings.filmGrain ? 0.022 : 0;
    this.post.grade.chroma = settings.chromaticAberration ? 1 : 0;
    this.post.grade.vignette = settings.vignette ? 0.42 : 0.12;
    this.pixelRatioCap = q.pixelRatio;
    this.camera.fov = settings.fov;
    this.camera.updateProjectionMatrix();
    this.resize(true);
  }

  resize(force = false) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap);
    const rw = Math.max(1, Math.round(w * dpr * this.dynamicRes));
    const rh = Math.max(1, Math.round(h * dpr * this.dynamicRes));
    if (!force && rw === this._lastW && rh === this._lastH) return;
    this._lastW = rw; this._lastH = rh;

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(rw, rh, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    const aspect = rw / rh;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();
    this.post.setSize(rw, rh);
  }

  /**
   * Dynamic resolution: if we're missing frame budget, quietly drop internal
   * resolution rather than stuttering. Recovers when there's headroom again.
   */
  updateDynamicRes(fps, dt) {
    const target = fps < 48 ? 0.72 : fps < 56 ? 0.85 : 1.0;
    this._resTarget = damp(this._resTarget, target, 0.35, dt);
    const snapped = Math.round(this._resTarget * 20) / 20;
    if (Math.abs(snapped - this.dynamicRes) > 0.049) {
      this.dynamicRes = clamp(snapped, 0.6, 1.0);
      this.resize(true);
    }
  }

  /** Keep the shadow frustum tight around the player for crisp contact shadows. */
  updateShadowFocus(x, y, z) {
    if (!this.sun.castShadow) return;
    const dir = this.envSunDir || new THREE.Vector3(0.4, 0.8, 0.3);
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x + dir.x * 90, y + dir.y * 90, z + dir.z * 90);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    const extent = this.quality.shadowMap >= 4096 ? 48 : this.quality.shadowMap >= 2048 ? 38 : 28;
    if (cam.left !== -extent) {
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
      cam.far = 220;
      cam.updateProjectionMatrix();
    }
  }

  render(elapsed) {
    const r = this.renderer;
    // World pass into the HDR buffer.
    this.post.renderScene(this.scene, this.camera);
    // Capture the world pass's cost before the post chain overwrites the counters.
    this.sceneDrawCalls = r.info.render.calls;
    this.sceneTriangles = r.info.render.triangles;
    // View model draws on top, into the same buffer, with a cleared depth so it
    // never intersects world geometry.
    r.setRenderTarget(this.post.sceneRT);
    r.clearDepth();
    r.render(this.viewScene, this.viewCamera);
    // Post chain to the canvas.
    this.post.composite(this.camera, elapsed);
  }

  dispose() {
    this.post.dispose();
    this.pmrem.dispose();
    this.envRT?.dispose();
    this.renderer.dispose();
  }
}
