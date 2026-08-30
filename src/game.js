// Game orchestrator: owns the world, the entities, the mode and the frame loop.

import * as THREE from 'three';
import { GameLoop } from './core/loop.js';
import { Input } from './core/input.js';
import { audio } from './core/audio.js';
import { loadSettings, saveSettings, QUALITY } from './core/settings.js';
import { clamp, clamp01, lerp, damp, rand, randInt, pick, TAU } from './core/math.js';
import { CollisionWorld, BodyMover } from './world/physics.js';
import { MapBuilder, buildCollision, buildProps } from './world/builder.js';
import { NavGrid } from './nav/navgrid.js';
import { RenderContext } from './render/scene.js';
import { TextureLibrary } from './render/textures.js';
import { MaterialLibrary, buildBrushGeometry } from './render/materials.js';
import { EffectsManager } from './render/effects.js';
import { Player } from './player/player.js';
import { Agent, DIFFICULTY } from './ai/agent.js';
import { Blackboard } from './ai/blackboard.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { createMode, MODES } from './modes/modes.js';
import { WEAPONS, GRENADES, PRIMARIES, SECONDARIES } from './weapons/defs.js';
import { explosionDamage, flashIntensity } from './weapons/combat.js';

import { foundry } from './world/maps/foundry.js';
import { dunes } from './world/maps/dunes.js';
import { vault } from './world/maps/vault.js';

const MAPS = { foundry, dunes, vault };

export class Game {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.settings = loadSettings();
    this.difficultyTable = DIFFICULTY;
    this.mapList = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name, subtitle: m.subtitle, size: m.size }));

    this.collision = new CollisionWorld(6);
    this.render = new RenderContext(canvas, this.settings);
    this.textures = new TextureLibrary(this.render.renderer);
    this.materials = new MaterialLibrary(this.textures, null);

    this.input = new Input(canvas);
    this.input.sensitivity = this.settings.sensitivity * 0.01;
    this.input.adsSensScale = this.settings.adsSensScale;
    this.input.invertY = this.settings.invertY;

    this.hudRoot = document.createElement('div');
    this.hudRoot.className = 'hud';
    uiRoot.appendChild(this.hudRoot);
    this.hud = new HUD(this.hudRoot, this.settings);
    this.menu = new Menu(uiRoot, this);
    this.menu.onStart = (cfg) => this.startMatch(cfg);

    this.time = 0;
    this.running = false;
    this.paused = true;
    this.movementLocked = false;
    this.shotCounter = 0;
    this.friendlyFire = false;
    this.agents = [];
    this.damageables = [];
    this.blackboards = [new Blackboard(0), new Blackboard(1)];
    this.timers = [];
    this.grenades = [];
    this.mapGroup = new THREE.Group();
    this.render.scene.add(this.mapGroup);
    this.dynamicLights = [];
    this._muzzleLightTimer = 0;
    this._respawnQueue = [];
    this._objectiveTimer = 0;
    this._navBudget = 0;
    this._scratchVec = new THREE.Vector3();
    this._worldMarkers = [];
    this._radarContacts = [];
    this._radarObjectives = [];

    this.player = null;
    this.mode = null;
    this.mapDef = null;
    this.mapBuilder = null;
    this.nav = null;
    this.effects = null;

    this.loop = new GameLoop({
      step: 1 / 120,
      update: (dt) => this.fixedUpdate(dt),
      render: (dt) => this.frame(dt),
    });

    this._installEvents();
  }

  /* ------------------------------------------------------------- lifecycle */

  _installEvents() {
    window.addEventListener('resize', () => {
      this.render.resize(true);
      this.hud.resize();
    });
    this.input.onLockChange = (locked) => {
      if (!locked && this.running && !this.paused && !this.menu.visible) this.pause();
    };
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        if (!this.running) return;
        if (this.paused) this.resume(); else this.pause();
      }
      if (e.code === 'Tab' && this.running && !this.paused) {
        e.preventDefault();
        this.hud.showScoreboard(true, this.hudState());
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.hud.showScoreboard(false, null);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running && !this.paused) this.pause();
    });
    // Any click on the canvas while playing re-acquires pointer lock.
    this.canvas.addEventListener('click', () => {
      if (this.running && !this.paused && !this.input.locked) this.input.requestLock();
    });
  }

  async boot() {
    this.menu.show('loading');
    this.menu._renderLoading(0.05, 'GENERATING SURFACES');
    await new Promise((r) => setTimeout(r, 30));
    await this.textures.bakeAll(512, (p, name) => {
      this.menu.setLoading(0.05 + p * 0.7, `GENERATING SURFACES — ${name.toUpperCase()}`);
    });
    this.menu.setLoading(0.8, 'COMPILING SHADERS');
    await new Promise((r) => setTimeout(r, 30));
    this.effects = new EffectsManager(this.render.scene, this.render.viewScene, this.collision, this.render.quality);
    this.menu.setLoading(1, 'READY');
    await new Promise((r) => setTimeout(r, 200));
    this.menu.show('main');
    // Idle backdrop: keep rendering the (empty) scene behind the menu.
    this.render.applyEnvironment(foundry.env);
    this.loop.start();
  }

  applySettings() {
    const s = this.settings;
    this.input.sensitivity = s.sensitivity * 0.01;
    this.input.adsSensScale = s.adsSensScale;
    this.input.invertY = s.invertY;
    audio.setVolumes({ master: s.volumeMaster, sfx: s.volumeSfx, music: s.volumeMusic });
    this.render.applyQuality(s);
    if (this.effects) this.effects.setQuality(this.render.quality);
    this.hud.resize();
  }

  saveSettings() { saveSettings(this.settings); }

  /* ------------------------------------------------------------ map loading */

  async loadMap(id) {
    const def = MAPS[id] || foundry;
    this.mapDef = def;

    // Tear down the previous map.
    this.mapGroup.clear();
    for (const l of this.dynamicLights) this.render.scene.remove(l);
    this.dynamicLights.length = 0;
    this.effects?.clear();

    const b = new MapBuilder();
    def.build(b);
    this.mapBuilder = b;
    buildCollision(b, this.collision);
    this.killY = (b.killY ?? -10);

    // Geometry, grouped per texture so the whole map is a handful of draws.
    const geoms = buildBrushGeometry(b.boxes.filter((box) => box.visible !== false));
    for (const [tex, geo] of geoms) {
      const mat = this.materials.surface(tex);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.mapGroup.add(mesh);
    }
    buildProps(b, this.materials, this.mapGroup);

    // Environment and lighting.
    this.render.applyEnvironment(def.env);
    this.materials.setEnvMap(this.render.scene.environment);
    this._placeLights(b);

    // Navigation.
    this.nav = new NavGrid(this.collision, { cell: 1.2, bounds: def.bounds }).build();
    return def;
  }

  _placeLights(b) {
    const budget = this.render.quality.lightCount;
    // Point lights fall off with the square of distance, so the authored
    // values (which read as "brightness") need scaling into candela.
    const CANDELA = 9;
    // Keep the strongest lights; the rest is carried by the fixtures' emissive
    // materials plus image-based lighting, which costs nothing per frame.
    const sorted = b.lights.slice().sort((p, q) => (q.intensity * q.distance) - (p.intensity * p.distance));
    for (let i = 0; i < sorted.length; i++) {
      const L = sorted[i];
      if (L.fixture) {
        const fixture = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.1, 0.5),
          this.materials.emissive(L.fixtureColor, 2.2),
        );
        fixture.position.set(L.x, L.y + 0.12, L.z);
        this.mapGroup.add(fixture);
      }
      if (i >= budget) continue;
      const light = new THREE.PointLight(L.color, L.intensity * CANDELA, L.distance, L.decay);
      light.position.set(L.x, L.y, L.z);
      if (L.castShadow && this.render.quality.shadows && i < 2) {
        light.castShadow = true;
        light.shadow.mapSize.set(512, 512);
        light.shadow.bias = -0.004;
        light.shadow.camera.far = L.distance;
      }
      this.render.scene.add(light);
      this.dynamicLights.push(light);
    }
  }

  /* --------------------------------------------------------------- matches */

  async startMatch(cfg) {
    audio.init();
    this.menu.show('loading');
    this.menu._renderLoading(0.1, `LOADING ${(MAPS[cfg.map] || foundry).name}`);
    await new Promise((r) => setTimeout(r, 40));

    this.settings.difficulty = cfg.difficulty;
    await this.loadMap(cfg.map);
    this.menu.setLoading(0.7, 'BRIEFING SQUADS');
    await new Promise((r) => setTimeout(r, 30));

    // --- entities ---
    this._disposeAgents();
    this.blackboards = [new Blackboard(0), new Blackboard(1)];
    if (!this.player) this.player = new Player(this);
    this.player.team = 0;
    this.player.name = 'YOU';
    this.player.kills = 0; this.player.deaths = 0; this.player.assists = 0;
    this.player.setLoadout(cfg.loadout.slice());
    this.player.grenades = { frag: 1, flash: 2, smoke: 1 };
    // The player sits in `agents` too, so squad logic can reason about them.
    this.agents.push(this.player);
    this.damageables.push(this.player);

    const total = clamp(cfg.botCount, 1, 15);
    const ffa = cfg.mode === 'gungame';
    const coop = cfg.mode === 'firefight';
    for (let i = 0; i < total; i++) {
      // Free-for-all gives every bot its own team so nothing is shared between
      // them; co-op puts every hostile on one squad that talks to itself.
      const team = ffa ? 2 + i : coop ? 1 : (i % 2 === 0 ? 1 : 0);
      this.addAgent(team, cfg.difficulty);
    }
    this.friendlyFire = false;

    // --- mode ---
    this.mode = createMode(cfg.mode, this, { });
    this.friendlyFire = this.mode.friendlyFire;
    this.player.regenEnabled = this.mode.regen;
    for (const a of this.agents) if (!a.isPlayer) a.regenEnabled = this.mode.regen;

    this.respawnAll();
    this.mode.init();
    this.mode.assignObjectives();

    this.menu.setLoading(1, 'DEPLOYING');
    await new Promise((r) => setTimeout(r, 180));

    this.time = 0;
    this.timers.length = 0;
    this.grenades.length = 0;
    this.shotCounter = 0;
    this.hud.clear();
    this.running = true;
    this.menu.hide();
    this.hud.setVisible(true);
    audio.startAmbience(this.mapDef.id === 'vault' ? 48 : 62);
    audio.setReverb(this.mapDef.id === 'vault' ? 0.42 : 0.24, this.mapDef.id === 'dunes' ? 1.2 : 2.2);
    this.resume();
  }

  /** Squad memory for a team, created on demand so free-for-all works too. */
  blackboardFor(team) {
    let bb = this.blackboards[team];
    if (!bb) { bb = new Blackboard(team); this.blackboards[team] = bb; }
    return bb;
  }

  addAgent(team, difficulty = this.settings.difficulty) {
    const loadout = this._randomLoadout();
    const agent = new Agent(this, team, { difficulty, loadout });
    this.agents.push(agent);
    this.damageables.push(agent);
    return agent;
  }

  _randomLoadout() {
    const primary = pick(PRIMARIES);
    const secondary = pick(SECONDARIES);
    return [primary, secondary, 'knife'];
  }

  _disposeAgents() {
    for (const a of this.agents) if (!a.isPlayer) a.dispose();
    this.agents.length = 0;
    this.damageables.length = 0;
  }

  respawnAll() {
    for (const e of this.damageables) this.spawnEntity(e);
    this._respawnQueue.length = 0;
  }

  spawnEntity(e) {
    const p = this.mode ? this.mode.pickSpawn(e) : (this.mapBuilder.spawnPoints.ffa[0] || { x: 0, y: 2, z: 0, yaw: 0 });
    // Nudge onto the nav graph so nobody spawns half inside a wall.
    const node = this.nav?.nearest(p.x, p.y, p.z, 5);
    const x = node ? node.x : p.x;
    const y = node ? node.y + 0.05 : p.y;
    const z = node ? node.z : p.z;
    e.spawn(x, y, z, p.yaw ?? 0);
    if (e.isPlayer) {
      this.render.post.fx.damage = 0;
      this.render.post.fx.hitFlash = 0;
    }
    this.mode?.onSpawn(e);
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.input.exitLock();
    this.hud.setVisible(false);
    audio.suspend();
    this.menu.show('pause');
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    this.menu.hide();
    this.hud.setVisible(true);
    audio.resume();
    this.input.requestLock();
  }

  quitToMenu() {
    this.running = false;
    this.paused = true;
    this.input.exitLock();
    this.hud.setVisible(false);
    audio.stopAmbience();
    this._disposeAgents();
    this.mode = null;
    this.menu.show('main');
  }

  onMatchEnd(winner) {
    this.input.exitLock();
    this.paused = true;
    this.hud.setVisible(false);
    audio.ui(winner === this.player.team ? 'win' : 'lose');
    this.menu.show('summary', {
      winner,
      playerTeam: this.player.team,
      scores: this.mode.scores,
      modeName: this.mode.name,
      mapName: this.mapDef.name,
      entities: this.damageables.map((e) => ({
        name: e.name, kills: e.kills, deaths: e.deaths, team: e.team, isPlayer: !!e.isPlayer,
      })),
    });
  }

  onWaveCleared() {
    // Firefight: open the shop between waves without losing the frame loop.
    this.paused = true;
    this.input.exitLock();
    this.hud.setVisible(false);
    this.menu.show('shop', { mode: this.mode });
  }

  /* ---------------------------------------------------------------- combat */

  applyDamage(target, amount, source, zone, dir) {
    if (!target || !target.alive) return false;
    const before = target.health;
    const killed = target.takeDamage(amount, source, zone, dir);
    const dealt = before - target.health;

    if (source && source.isPlayer && dealt > 0) {
      // Damage numbers float at the victim's chest, projected to screen space.
      const p = this._scratchVec.set(target.pos.x, target.pos.y + target.height * 0.75, target.pos.z);
      p.project(this.render.camera);
      if (p.z < 1) {
        this.hud.damageNumber((p.x * 0.5 + 0.5), (-p.y * 0.5 + 0.5), dealt, zone === 'head');
      }
    }
    if (target.isPlayer && dealt > 0) {
      this.render.post.fx.damage = clamp01(1 - target.health / target.maxHealth);
    }
    if (killed) this.onKill(target, source, zone);
    return killed;
  }

  onKill(victim, killer, zone) {
    victim.deaths = (victim.deaths ?? 0) + 1;
    if (killer && killer !== victim) {
      killer.kills = (killer.kills ?? 0) + 1;
      killer.killStreak = (killer.killStreak ?? 0) + 1;
      if (killer.isPlayer) {
        audio.ui('kill');
        this.hud.hitmarker(zone === 'head', true);
      }
    }
    victim.killStreak = 0;

    this.hud.addKill(
      killer ? killer.name : 'WORLD',
      victim.name,
      killer?.def?.id,
      zone === 'head',
      killer ? killer.team : -1,
      victim.team,
      !!(killer?.isPlayer || victim.isPlayer),
    );

    // Squad reaction: a teammate going down is information.
    if (killer) {
      const bb = this.blackboards[victim.team];
      bb?.report(killer, killer.pos, this.time, 0.6, 'kia');
      bb.deadAllies++;
    }

    this.mode?.onKill(victim, killer);

    if (victim.isPlayer) {
      this.render.post.fx.damage = 1;
      audio.ui('lose');
    }
    if (this.mode?.respawn) {
      this._respawnQueue.push({ entity: victim, at: this.time + this.mode.respawnDelay });
    } else if (!victim.isPlayer) {
      this.schedule(6, () => { if (!victim.alive) victim.despawn(); });
    }
  }

  /** A bullet passed close to someone: crack audio for the player, suppression for bots. */
  reportNearMiss(origin, dir, endPoint, shooter) {
    for (const e of this.damageables) {
      if (!e.alive || e === shooter) continue;
      // Distance from the entity's head to the bullet's line.
      const hx = e.pos.x - origin.x, hy = (e.pos.y + e.height * 0.85) - origin.y, hz = e.pos.z - origin.z;
      const t = hx * dir.x + hy * dir.y + hz * dir.z;
      if (t <= 0) continue;
      const travel = Math.hypot(endPoint.x - origin.x, endPoint.y - origin.y, endPoint.z - origin.z);
      if (t > travel + 1) continue;
      const px = hx - dir.x * t, py = hy - dir.y * t, pz = hz - dir.z * t;
      const d = Math.hypot(px, py, pz);
      if (d > 2.6) continue;
      if (e.isPlayer) {
        audio.whizz({ x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t }, 1);
        this.render.post.fx.aberrationBoost = Math.min(1, this.render.post.fx.aberrationBoost + 0.25);
      } else {
        e.suppression = clamp01(e.suppression + 0.35 * (1 - d / 2.6));
        if (shooter) e.blackboard?.report(shooter, shooter.pos, this.time, 0.3, e.id);
      }
    }
  }

  emitNoise(pos, loudness, kind, source) {
    for (const a of this.agents) {
      if (a.isPlayer || !a.alive || a === source) continue;
      // Teammates' own gunfire shouldn't send a squad chasing itself.
      if (source && a.team === source.team && kind !== 'gunshot') continue;
      a.hearNoise(pos, loudness, kind);
    }
  }

  /* -------------------------------------------------------------- grenades */

  spawnGrenade({ type, owner, fuse, pos, vel }) {
    const def = GRENADES[type];
    if (!def) return;
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.075, 1),
      this.materials.solid(type === 'frag' ? 0x3d4a34 : type === 'flash' ? 0xb0b6bd : 0x4a4a52, { rough: 0.5, metal: 0.4 }),
    );
    mesh.castShadow = true;
    this.render.scene.add(mesh);
    const light = type === 'frag' ? null : null;
    this.grenades.push({
      type, def, owner, mesh,
      pos: { ...pos }, vel: { ...vel },
      fuse, age: 0, rest: 0, exploded: false,
      spin: { x: rand(-8, 8), y: rand(-8, 8), z: rand(-8, 8) },
    });
    // Bots hear a grenade land and react to it.
    this.emitNoise(pos, 18, 'grenade', owner);
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.age += dt;
      g.fuse -= dt;

      if (g.rest < 3) {
        g.vel.y -= 21 * dt;
        const steps = Math.max(1, Math.ceil(Math.hypot(g.vel.x, g.vel.y, g.vel.z) * dt / 0.25));
        for (let s = 0; s < steps; s++) {
          const sd = dt / steps;
          const nx = g.pos.x + g.vel.x * sd;
          const ny = g.pos.y + g.vel.y * sd;
          const nz = g.pos.z + g.vel.z * sd;
          const dx = nx - g.pos.x, dy = ny - g.pos.y, dz = nz - g.pos.z;
          const len = Math.hypot(dx, dy, dz);
          const hit = len > 1e-5
            ? this.collision.raycast(g.pos.x, g.pos.y, g.pos.z, dx / len, dy / len, dz / len, len + 0.075, 'solid')
            : null;
          if (hit) {
            // Reflect with damping; grenades settle instead of rolling forever.
            const n = hit.normal;
            const dot = g.vel.x * n.x + g.vel.y * n.y + g.vel.z * n.z;
            g.vel.x = (g.vel.x - 2 * dot * n.x) * 0.42;
            g.vel.y = (g.vel.y - 2 * dot * n.y) * 0.42;
            g.vel.z = (g.vel.z - 2 * dot * n.z) * 0.42;
            g.pos.x = hit.point.x + n.x * 0.09;
            g.pos.y = hit.point.y + n.y * 0.09;
            g.pos.z = hit.point.z + n.z * 0.09;
            const speed = Math.hypot(g.vel.x, g.vel.y, g.vel.z);
            if (speed > 1.2) audio.impact(g.pos, hit.brush.surface);
            if (speed < 0.7) g.rest += dt * 4;
            break;
          }
          g.pos.x = nx; g.pos.y = ny; g.pos.z = nz;
        }
      }

      g.mesh.position.set(g.pos.x, g.pos.y, g.pos.z);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;

      if (g.fuse <= 0 && !g.exploded) {
        g.exploded = true;
        this._detonate(g);
        this.render.scene.remove(g.mesh);
        g.mesh.geometry.dispose();
        this.grenades.splice(i, 1);
      }
    }
  }

  _detonate(g) {
    const { type, def, owner, pos } = g;
    if (type === 'frag') {
      this.effects.explosion(pos.x, pos.y, pos.z, def.radius * 0.55);
      audio.explosion(pos, 1);
      const hits = explosionDamage(this.collision, this.damageables, pos, def.radius, def.damage, owner, true);
      for (const h of hits) this.applyDamage(h.entity, h.damage, owner, 'body', { x: 0, y: 1, z: 0 });
      // Scorch the ground and shove the camera.
      const down = this.collision.raycast(pos.x, pos.y, pos.z, 0, -1, 0, 4, 'solid');
      if (down) this.effects.decals.add(down.point.x, down.point.y, down.point.z, 0, 1, 0, 1.6, 30);
      const pd = Math.hypot(this.player.pos.x - pos.x, this.player.pos.z - pos.z);
      if (pd < def.radius * 2.2) {
        const k = 1 - clamp01(pd / (def.radius * 2.2));
        this.player.shake.nudge(rand(-8, 8) * k, rand(-6, 8) * k, rand(-5, 5) * k);
      }
    } else if (type === 'flash') {
      this.effects.glow.spawn({
        x: pos.x, y: pos.y, z: pos.z, life: 0.3, size: 3, sizeEnd: 9,
        color: { r: 1, g: 1, b: 1 }, alpha: 1, alphaEnd: 0,
      });
      audio.explosion(pos, 0.4);
      const fwd = this.player.forwardVector(new THREE.Vector3());
      const secs = flashIntensity(this.collision, this.player, fwd, pos, def.radius, def.blind);
      if (secs > 0.2) {
        this._flashUntil = this.time + secs;
        this._flashPeak = secs;
        audio.concuss(Math.min(2.4, secs));
      }
      for (const a of this.agents) {
        if (a.isPlayer || !a.alive) continue;
        const af = new THREE.Vector3(-Math.sin(a.aimYaw), 0, -Math.cos(a.aimYaw));
        const s = flashIntensity(this.collision, a, af, pos, def.radius, def.blind);
        if (s > 0.2) {
          // Blinded bots lose their target and their aim goes to pieces.
          a.perception.reset();
          a.suppression = 1;
          a.aimSettle = 0;
          a._blindUntil = this.time + s;
        }
      }
    } else if (type === 'smoke') {
      this._spawnSmokeCloud(pos, def);
      audio.explosion(pos, 0.25);
    }
  }

  _spawnSmokeCloud(pos, def) {
    const duration = def.duration ?? 12;
    const emit = () => {
      for (let i = 0; i < 4; i++) {
        const a = rand(0, TAU), r = rand(0, def.radius * 0.8);
        this.effects.smoke.spawn({
          x: pos.x + Math.cos(a) * r, y: pos.y + rand(0, 2.2), z: pos.z + Math.sin(a) * r,
          vx: rand(-0.25, 0.25), vy: rand(0.05, 0.35), vz: rand(-0.25, 0.25),
          life: rand(3.5, 6), size: rand(1.6, 2.6), sizeEnd: rand(3.2, 4.6),
          color: { r: 0.72, g: 0.74, b: 0.78 }, colorEnd: { r: 0.55, g: 0.57, b: 0.6 },
          alpha: 0.5, alphaEnd: 0, drag: 1.2, rotVel: rand(-0.4, 0.4),
        });
      }
    };
    for (let t = 0; t < duration; t += 0.25) this.schedule(t, emit);
  }

  schedule(delay, fn) { this.timers.push({ at: this.time + delay, fn }); }

  spawnSpikeMarker(spike) {
    this.clearSpikeMarker();
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.44, 0.16),
      this.materials.solid(0x2a2f36, { rough: 0.5, metal: 0.6 }),
    );
    body.position.y = 0.22;
    body.castShadow = true;
    g.add(body);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 8),
      this.materials.emissive(0xff3b30, 8),
    );
    lamp.position.set(0, 0.4, 0.09);
    g.add(lamp);
    g.position.set(spike.x, spike.y, spike.z);
    this.render.scene.add(g);
    const light = new THREE.PointLight(0xff3b30, 6, 8, 2);
    light.position.set(spike.x, spike.y + 0.5, spike.z);
    this.render.scene.add(light);
    this.spikeMarker = { group: g, lamp, light };
  }

  clearSpikeMarker() {
    if (!this.spikeMarker) return;
    this.render.scene.remove(this.spikeMarker.group);
    this.render.scene.remove(this.spikeMarker.light);
    this.spikeMarker.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.spikeMarker = null;
  }

  /**
   * Fill `out` with everyone `self` may shoot. In free-for-all that's everybody
   * else; in team modes it's the other side.
   * @param {number} team
   * @param {object|null} self entity to exclude
   * @param {Array} out reused array, cleared in place
   */
  /** Dev helper: hide the world and paint a neutral backdrop to inspect the weapon. */
  setShowcase(on, color = 0xb4bcc6) {
    this.mapGroup.visible = !on;
    this.render.sky.visible = !on;
    for (const a of this.agents) if (!a.isPlayer) a.character.root.visible = !on;
    this.render.scene.background = on ? new THREE.Color(color) : null;
    this.render.scene.fog = on ? null : this.render.scene.fog;
    this._showcaseFog = on ? (this._showcaseFog ?? this.render.scene.fog) : this._showcaseFog;
    if (!on && this._showcaseFog) this.render.scene.fog = this._showcaseFog;
    this.hud.setVisible(!on);
  }

  enemiesOf(team, self = null, out = []) {
    out.length = 0;
    const ffa = this.mode ? !this.mode.teamBased : false;
    for (let i = 0; i < this.damageables.length; i++) {
      const e = this.damageables[i];
      if (!e.alive || e === self) continue;
      if (!ffa && e.team === team) continue;
      out.push(e);
    }
    return out;
  }

  /* ----------------------------------------------------------------- frame */

  fixedUpdate(dt) {
    if (!this.running || this.paused) return;
    this.time += dt;

    // Timers.
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.time >= this.timers[i].at) {
        const fn = this.timers[i].fn;
        this.timers.splice(i, 1);
        try { fn(); } catch (err) { console.error('scheduled task failed', err); }
      }
    }

    // Respawns.
    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      if (this.time >= this._respawnQueue[i].at) {
        const e = this._respawnQueue[i].entity;
        this._respawnQueue.splice(i, 1);
        if (this.mode?.respawn) this.spawnEntity(e);
      }
    }

    // Blackboards.
    for (const bb of this.blackboards) if (bb) bb.update(dt, this.time);
    this._objectiveTimer -= dt;
    if (this._objectiveTimer <= 0) {
      this._objectiveTimer = 0.9;
      this.mode?.assignObjectives();
      for (let t = 0; t < this.blackboards.length; t++) {
        const bb = this.blackboards[t];
        if (!bb) continue;
        bb.assignRoles(this.agents.filter((a) => a.team === t && !a.isPlayer), this.time, bb.objectiveFocus);
      }
    }

    // Player.
    if (!this.movementLocked) {
      this.player.update(dt, this.input);
    } else {
      // During a buy phase the player can look around but not move or shoot.
      const look = this.input.takeLook(0);
      this.player.yaw += look.yaw;
      this.player.pitch = clamp(this.player.pitch + look.pitch, -1.54, 1.54);
      this.player.viewModel.update(dt, { speed: 0, grounded: true, crouching: false, lookDx: look.yaw, lookDy: look.pitch });
    }

    // Agents.
    for (const a of this.agents) {
      if (a.isPlayer) continue;
      if (a._blindUntil && this.time < a._blindUntil) {
        // Blinded: still moves, but can't perceive or shoot.
        a.perception.visible.clear();
        a.perception.awareness.clear();
      }
      a.update(dt);
    }

    this._updateGrenades(dt);

    // Fell out of the world: put them back rather than letting them drop forever.
    for (const e of this.damageables) {
      if (e.alive && e.pos.y < this.killY) {
        if (this.mode?.respawn || e.isPlayer) this.spawnEntity(e);
        else this.applyDamage(e, 9999, null, 'body', { x: 0, y: -1, z: 0 });
      }
    }

    this.mode?.update(dt);
  }

  frame(dt) {
    const r = this.render;
    r.updateDynamicRes(this.loop.fps, dt);

    if (!this.running) {
      // Menu backdrop: a slow orbit so the front end isn't a static image.
      const t = performance.now() * 0.00006;
      r.camera.position.set(Math.cos(t) * 26, 9 + Math.sin(t * 1.7) * 2, Math.sin(t) * 26);
      r.camera.lookAt(0, 3, 0);
      r.camera.fov = 60;
      r.camera.updateProjectionMatrix();
      r.updateShadowFocus(0, 0, 0);
      r.render(performance.now() * 0.001);
      this.input.endFrame();
      return;
    }

    const p = this.player;
    p.applyCamera(r.camera, r.viewCamera, this.settings);
    r.updateShadowFocus(p.pos.x, p.pos.y, p.pos.z);

    // Muzzle light decay.
    if (this._muzzleLightTimer > 0) {
      this._muzzleLightTimer -= dt;
      const k = clamp01(this._muzzleLightTimer / 0.045);
      r.muzzleLight.intensity *= k;
      r.viewMuzzleLight.intensity *= k;
      if (this._muzzleLightTimer <= 0) {
        r.muzzleLight.visible = false;
        r.viewMuzzleLight.visible = false;
      }
    }

    // Screen effects decay.
    const fx = r.post.fx;
    fx.hitFlash = damp(fx.hitFlash, 0, 7, dt);
    fx.aberrationBoost = damp(fx.aberrationBoost, 0, 4, dt);
    fx.damage = p.alive ? damp(fx.damage, clamp01(1 - p.health / p.maxHealth) * 0.75, 3, dt) : damp(fx.damage, 1, 4, dt);
    fx.adrenaline = p.alive ? clamp01((0.35 - p.health / p.maxHealth) * 2.4) : 0;
    fx.scopeDark = p.def?.scoped ? p.viewModel.adsAmount * 0.55 : 0;
    if (this._flashUntil && this.time < this._flashUntil) {
      const left = this._flashUntil - this.time;
      fx.flash = clamp01(left / Math.max(0.3, this._flashPeak)) ** 0.6;
    } else fx.flash = damp(fx.flash, 0, 6, dt);

    // Audio listener follows the camera.
    const fwd = p.forwardVector(this._scratchVec);
    audio.updateListener(p.eyePos, fwd, { x: 0, y: 1, z: 0 });

    this.effects.update(dt);

    if (this.spikeMarker) {
      const blink = 0.5 + 0.5 * Math.sin(this.time * 8);
      this.spikeMarker.lamp.material.emissiveIntensity = 3 + blink * 10;
      this.spikeMarker.light.intensity = 2 + blink * 8;
    }

    r.render(this.time);

    if (!this.paused) this.hud.update(dt, this.hudState());
    this.input.endFrame();
  }

  /* -------------------------------------------------------------- hud data */

  hudState() {
    const p = this.player;
    this._radarContacts.length = 0;
    this._radarObjectives.length = 0;
    this._worldMarkers.length = 0;

    // Allies always show; enemies show only while the squad actually knows.
    for (const e of this.damageables) {
      if (!e.alive || e === p) continue;
      if (this.mode?.teamBased && e.team === p.team) {
        this._radarContacts.push({ x: e.pos.x, y: e.pos.y, z: e.pos.z, kind: 'ally' });
      }
    }
    const bb = this.blackboards[p.team];
    if (bb) {
      for (const c of bb.contacts.values()) {
        const age = this.time - c.lastSeen;
        if (age > 5) continue;
        this._radarContacts.push({ x: c.x, y: c.y, z: c.z, kind: 'enemy', fade: clamp01(1 - age / 5) });
      }
    }

    // Objective markers, both on the radar and projected into the world.
    const ms = this.mode ? this.mode.hudState() : { mode: '', scores: [0, 0], timeLeft: 0, teamBased: true };
    const addMarker = (x, y, z, label, color, shape = 'diamond') => {
      this._radarObjectives.push({ x, z, label, color });
      const v = this._scratchVec.set(x, y, z).project(this.render.camera);
      const onScreen = v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
      this._worldMarkers.push({
        x: clamp(v.x * 0.5 + 0.5, 0.03, 0.97),
        y: clamp(-v.y * 0.5 + 0.5, 0.05, 0.95),
        onScreen,
        label, color, shape,
        distance: Math.hypot(x - p.pos.x, y - p.pos.y, z - p.pos.z),
        alpha: onScreen ? 0.95 : 0,
      });
    };

    let progress = null;
    if (ms.zones) {
      for (const z of ms.zones) {
        const col = z.owner === -1 ? '#c8d2dc' : z.owner === p.team ? '#4ff2c8' : '#ff6b6b';
        addMarker(z.x, z.y + 1.6, z.z, z.id, col);
        const d = Math.hypot(p.pos.x - z.x, p.pos.z - z.z);
        if (d < z.radius && p.alive) {
          progress = {
            value: Math.abs(z.progress),
            label: z.contested ? 'CONTESTED' : z.owner === p.team ? 'HELD' : 'CAPTURING',
            color: z.contested ? '#ffc65c' : '#4ff2c8',
          };
        }
      }
    }
    if (ms.spike) {
      if (ms.phase === 'planted') {
        addMarker(ms.spike.x, ms.spike.y + 0.6, ms.spike.z, 'SPIKE', '#ff3b30');
        if (p.team !== ms.attackTeam && Math.hypot(p.pos.x - ms.spike.x, p.pos.z - ms.spike.z) < 1.8) {
          progress = { value: ms.defuseProgress, label: 'DEFUSE', color: '#4fc3f7' };
          this.hud.prompt('HOLD [F] TO DEFUSE');
        }
      } else if (p.team === ms.attackTeam) {
        const site = this.mode.targetSite;
        if (site) addMarker(site.x, site.y + 2, site.z, site.id, '#ffb347');
        if (p.hasSpike) {
          const at = this.mode._siteAt(p.pos);
          if (at) {
            progress = { value: ms.plantProgress, label: 'PLANT', color: '#ff9d2e' };
            this.hud.prompt('HOLD [F] TO PLANT');
          } else this.hud.prompt('CARRYING SPIKE');
        }
      } else {
        for (const s of this.mode.sites) addMarker(s.x, s.y + 2, s.z, s.id, '#8aa0b4');
      }
    }

    return {
      player: p,
      mode: ms,
      mapName: this.mapDef?.name ?? '',
      entities: this.damageables,
      spread: p.currentSpread(),
      fps: this.loop.fps,
      drawCalls: this.render.renderer.info.render.calls,
      agentCount: this.agents.filter((a) => a.alive && !a.isPlayer).length,
      radarContacts: this._radarContacts,
      radarObjectives: this._radarObjectives,
      worldMarkers: this._worldMarkers,
      progress,
    };
  }
}
