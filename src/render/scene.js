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
    this.hemi = new THREE.HemisphereLight(0x8fb4ff, 0x2b2118, 0.55);
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
    this.viewMuzzleLight = new THREE.PointLight(0xffcf88, 0, 3, 2.0);
    this.viewMuzzleLight.visible = false;
    this.viewScene.add(this.viewMuzzleLight);
    this.viewAmbient = new THREE.HemisphereLight(0xa8c0ff, 0x2a2622, 0.9);
    this.viewScene.add(this.viewAmbient);
    this.viewKey = new THREE.DirectionalLight(0xffffff, 1.6);
    this.viewKey.position.set(0.6, 1.2, 0.9);
    this.viewScene.add(this.viewKey);
    this.viewRim = new THREE.DirectionalLight(0x86b8ff, 0.9);
    this.viewRim.position.set(-1.1, 0.4, -1.0);
    this.viewScene.add(this.viewRim);
  }

  _buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(6000);
    this.sky.material.depthWrite = false;
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this._envScene = new THREE.Scene();
    this._envSky = new Sky();
    this._envSky.scale.setScalar(6000);
    this._envScene.add(this._envSky);
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
      hemiSky = 0x8fb4ff, hemiGround = 0x2b2118, hemiIntensity = 0.5,
      fogColor = 0x9fb6d8, fogDensity = 0.008,
      exposure = 1.0, grade = {}, showSky = true,
      backgroundColor = null,
    } = env;

    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

    for (const sky of [this.sky, this._envSky]) {
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

    // Regenerate the image-based lighting probe from the current sky.
    this.envRT?.dispose();
    try {
      this.envRT = this.pmrem.fromScene(this._envScene, 0.04, 0.1, 1000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = env.envIntensity ?? 1.0;
    } catch {
      this.scene.environment = null; // IBL is a bonus, never a hard requirement
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
    this.post.grade.grain = settings.filmGrain ? 0.035 : 0;
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
