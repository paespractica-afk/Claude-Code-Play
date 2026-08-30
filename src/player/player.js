// Player controller: movement, camera, and weapon handling.
//
// Recoil follows the CS/Valorant model — the spray pattern punches your actual
// view angles, bullets follow the punched view, and the punch decays. That makes
// every pattern learnable by pulling against it, instead of random spray.

import * as THREE from 'three';
import { Spring, Spring3, clamp, clamp01, lerp, damp, rand, gauss, TAU } from '../core/math.js';
import { BodyMover } from '../world/physics.js';
import { WEAPONS, fireInterval, GRENADES } from '../weapons/defs.js';
import { ViewModel, VMState } from '../weapons/viewmodel.js';
import { traceShot, applySpread, patternAt, HITZONE } from '../weapons/combat.js';
import { audio } from '../core/audio.js';

const MOVE = {
  walk: 5.6,
  sprint: 8.1,
  crouch: 2.95,
  adsScale: 0.56,
  accelGround: 72,
  accelAir: 16,
  friction: 10.5,
  gravity: 23,
  jumpVel: 6.35,
  stepHeight: 0.52,
  radius: 0.36,
  height: 1.78,
  crouchHeight: 1.16,
  airControl: 0.42,
};

export class Player {
  constructor(game) {
    this.game = game;
    this.world = game.collision;
    this.mover = new BodyMover(game.collision);

    this.pos = new THREE.Vector3(0, 2, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = MOVE.height;
    this.radius = MOVE.radius;
    this.eyeHeight = MOVE.height * 0.93;

    this.grounded = false;
    this.wasGrounded = false;
    this.crouching = false;
    this.crouchAmount = 0;
    this.sprinting = false;
    this.moveSpeed = 0;
    this.groundSurface = 'concrete';

    // Combat state
    this.team = 0;
    this.alive = true;
    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.maxArmor = 50;
    this.lastDamageTime = -99;
    this.regenDelay = 4.5;
    this.regenRate = 22;
    this.regenEnabled = true;
    this.tagUntil = 0;
    this.isPlayer = true;
    this.name = 'YOU';
    this.kills = 0; this.deaths = 0; this.assists = 0; this.score = 0;
    this.killStreak = 0;

    // Weapons
    this.loadout = ['kestrel', 'sidewinder', 'knife'];
    this.slotIndex = 0;
    this.lastSlotIndex = 1;
    this.ammo = {};
    this.reserve = {};
    this.def = null;
    this.fireTimer = 0;
    this.sprayIndex = 0;
    this.sprayRecover = 0;
    this.triggerHeld = false;
    this.firedThisPress = false;
    this.reloading = false;
    this.reloadEndsAt = 0;
    this.shellReloadPending = 0;
    this.wantAds = false;
    this.adsLocked = false;
    this.shotsSinceSmoke = 0;

    // Grenades
    this.grenades = { frag: 1, flash: 2, smoke: 1 };
    this.grenadeType = 'frag';
    this.cookStart = -1;

    // Camera rig
    this.recoilYaw = 0;
    this.recoilPitch = 0;
    this.recoilRecoverX = 0;
    this.recoilRecoverY = 0;
    this.shake = new Spring3(70, 9);
    this.landDip = new Spring(90, 13, 0);
    this.lean = new Spring(110, 17, 0);
    this.fovSpring = new Spring(90, 16, 1);
    this.viewModel = new ViewModel(game.render.viewRig, game.effects);

    // Footsteps
    this.stepDistance = 0;
    this.lastStepFoot = 0;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._shotDir = { x: 0, y: 0, z: 0 };
    this._muzzleWorld = new THREE.Vector3();
    this._delta = { x: 0, y: 0, z: 0 };

    this.onFireEvent = null;
    this.onHitEvent = null;
    this.onKillEvent = null;
    this.onDeathEvent = null;
    this.onNoiseEvent = null;
  }

  /* ------------------------------------------------------------ lifecycle -- */

  setLoadout(list) {
    this.loadout = list.slice();
    this.ammo = {};
    this.reserve = {};
    for (const id of this.loadout) {
      const d = WEAPONS[id];
      if (!d) continue;
      this.ammo[id] = d.mag;
      this.reserve[id] = d.reserve;
    }
    this.slotIndex = 0;
    this.lastSlotIndex = Math.min(1, this.loadout.length - 1);
    this._equip(0, true);
  }

  spawn(x, y, z, yaw = 0) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.alive = true;
    this.health = this.maxHealth;
    this.crouching = false;
    this.crouchAmount = 0;
    this.height = MOVE.height;
    this.recoilYaw = this.recoilPitch = 0;
    this.recoilRecoverX = this.recoilRecoverY = 0;
    this.sprayIndex = 0;
    this.reloading = false;
    this.shellReloadPending = 0;
    this.cookStart = -1;
    this.shake.reset();
    this.landDip.set(0);
    this.viewModel.cancelAnimation();
    this._equip(this.slotIndex, true);
  }

  get eyePos() {
    return {
      x: this.pos.x,
      y: this.pos.y + this.eyeHeight + this.landDip.value * 0.08,
      z: this.pos.z,
    };
  }

  get currentWeaponId() { return this.loadout[this.slotIndex]; }

  /* -------------------------------------------------------------- weapons -- */

  _equip(index, instant = false) {
    index = clamp(index, 0, this.loadout.length - 1);
    const id = this.loadout[index];
    const def = WEAPONS[id];
    if (!def) return;
    this.slotIndex = index;
    this.def = def;
    this.reloading = false;
    this.shellReloadPending = 0;
    this.sprayIndex = 0;
    this.fireTimer = 0;
    this.viewModel.setWeapon(def);
    if (instant) {
      this.viewModel.play(VMState.IDLE, 0.01);
    } else {
      this.viewModel.play(VMState.DRAW, def.drawTime);
      audio.mech(null, 'switch', 0.4);
    }
  }

  switchTo(index) {
    if (index === this.slotIndex || index < 0 || index >= this.loadout.length) return;
    if (this.viewModel.state === VMState.HOLSTER) return;
    const from = this.slotIndex;
    const def = this.def;
    this.viewModel.play(VMState.HOLSTER, def ? def.holsterTime : 0.3, () => {
      this.lastSlotIndex = from;
      this._equip(index);
    });
    this.reloading = false;
    this.shellReloadPending = 0;
  }

  swapLast() { this.switchTo(this.lastSlotIndex); }

  startReload() {
    const d = this.def;
    if (!d || d.melee) return;
    if (this.reloading || this.viewModel.isBusy()) return;
    const have = this.ammo[d.id] ?? 0;
    const spare = this.reserve[d.id] ?? 0;
    if (have >= d.mag || spare <= 0) return;

    if (d.shellReload) {
      this.shellReloadPending = Math.min(d.mag - have, spare);
      this.reloading = true;
      this._beginShellInsert();
      return;
    }
    this.reloading = true;
    const empty = have === 0;
    const time = empty ? d.reloadEmptyTime : d.reloadTime;
    this.viewModel._rackAtEnd = empty;
    this.viewModel.play(VMState.RELOAD, time, () => this._finishReload());
    this.wantAds = false;
    audio.mech(null, 'magOut', 0.5);
    // Queue the mechanical sounds so they land on the animation beats.
    this._queueSound(time * 0.5, 'magIn', 0.55);
    if (empty) this._queueSound(time * 0.82, 'bolt', 0.5);
    this.onNoiseEvent?.(this.pos, 12, 'reload');
  }

  _beginShellInsert() {
    const d = this.def;
    this.viewModel.play(VMState.SHELL_INSERT, d.reloadTime, () => {
      this.ammo[d.id] = Math.min(d.mag, (this.ammo[d.id] ?? 0) + 1);
      this.reserve[d.id] = Math.max(0, (this.reserve[d.id] ?? 0) - 1);
      this.shellReloadPending--;
      audio.mech(null, 'magIn', 0.45);
      if (this.shellReloadPending > 0 && this.ammo[d.id] < d.mag && (this.reserve[d.id] ?? 0) > 0 && this.triggerHeld === false) {
        this._beginShellInsert();
      } else {
        this.reloading = false;
        this.viewModel.play(VMState.BOLT, 0.42);
        audio.mech(null, 'bolt', 0.5);
      }
    });
  }

  _finishReload() {
    const d = this.def;
    const need = d.mag - (this.ammo[d.id] ?? 0);
    const take = Math.min(need, this.reserve[d.id] ?? 0);
    this.ammo[d.id] = (this.ammo[d.id] ?? 0) + take;
    this.reserve[d.id] = (this.reserve[d.id] ?? 0) - take;
    this.reloading = false;
  }

  _queueSound(delay, kind, level) {
    this.game.schedule(delay, () => { if (this.alive) audio.mech(null, kind, level); });
  }

  cancelReload() {
    if (!this.reloading) return;
    this.reloading = false;
    this.shellReloadPending = 0;
    this.viewModel.cancelAnimation();
  }

  /* ------------------------------------------------------------- shooting -- */

  canFire() {
    if (!this.alive || !this.def) return false;
    if (this.viewModel.isBusy()) return false;
    if (this.fireTimer > 0) return false;
    if (this.sprinting && this.moveSpeed > MOVE.walk * 1.05) return false;
    if (this.def.melee) return true;
    if ((this.ammo[this.def.id] ?? 0) <= 0) return false;
    return true;
  }

  /** Current bullet-cone spread in degrees, given stance and motion. */
  currentSpread() {
    const d = this.def;
    if (!d) return 0;
    const ads = this.viewModel.adsAmount;
    let base = lerp(d.spread.hip, d.spread.ads, ads);
    const speed = this.moveSpeed;
    if (!this.grounded) base *= d.spread.airMul;
    else if (speed > 0.6) base *= lerp(1, d.spread.moveMul, clamp01(speed / MOVE.walk));
    if (this.crouching && this.grounded && speed < 0.6) base *= d.spread.crouchMul;
    return base;
  }

  tryFire(now) {
    const d = this.def;
    if (!this.canFire()) {
      // Dry fire feedback, once per trigger press.
      if (d && !d.melee && (this.ammo[d.id] ?? 0) <= 0 && !this.firedThisPress && !this.viewModel.isBusy()) {
        this.firedThisPress = true;
        audio.mech(null, 'dryFire', 0.5);
        if ((this.reserve[d.id] ?? 0) > 0) this.startReload();
      }
      return;
    }
    if (!d.auto && this.firedThisPress) return;
    this.firedThisPress = true;

    if (d.melee) { this._melee(); return; }

    this.fireTimer = fireInterval(d);
    this.ammo[d.id] = (this.ammo[d.id] ?? 0) - 1;

    // --- direction, including the current recoil punch ---
    const eye = this.eyePos;
    const yaw = this.yaw + this.recoilYaw;
    const pitch = clamp(this.pitch + this.recoilPitch, -1.55, 1.55);
    this._fwd.set(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ).normalize();
    this._right.crossVectors(this._fwd, this._up).normalize();
    const upv = new THREE.Vector3().crossVectors(this._right, this._fwd).normalize();

    const spread = this.currentSpread();
    const pellets = d.pellets ?? 1;
    const results = [];
    for (let i = 0; i < pellets; i++) {
      applySpread(this._fwd, this._right, upv, spread, 0, 0, this._shotDir);
      const res = traceShot({
        world: this.world,
        entities: this.game.damageables,
        origin: eye,
        dir: this._shotDir,
        def: d,
        shooter: this,
        maxDist: 220,
        friendlyFire: this.game.friendlyFire,
      });
      results.push({ res, dir: { ...this._shotDir } });
    }

    // --- recoil punch (applied to the view, so bullets follow it) ---
    const [px, py] = patternAt(d, this.sprayIndex);
    const r = d.recoil;
    const jitterX = gauss(0, 0.05) * r.horizontal;
    this.recoilYaw += (px * r.horizontal + jitterX) * Math.PI / 180;
    this.recoilPitch += (py * r.vertical + Math.abs(gauss(0, 0.04))) * Math.PI / 180;
    this.sprayIndex++;
    this.sprayRecover = 0;

    // Visual kick on top of the punch.
    const shakeAmt = r.viewKick * this.game.settings.cameraShake;
    this.shake.nudge(rand(-0.4, 0.4) * shakeAmt, rand(0.1, 0.5) * shakeAmt, rand(-0.3, 0.3) * shakeAmt);
    this.viewModel.onFire(1);

    // --- audio / visual FX ---
    audio.shot(null, { ...(d.sound || {}), level: (d.sound?.level ?? 1) * 0.85 });
    const fx = this.game.effects;
    const mz = this.viewModel.muzzleLocal(this._muzzleWorld);
    fx.muzzleView(mz, d.weight * 0.9 + 0.4);
    this.game.render.viewMuzzleLight.visible = true;
    this.game.render.viewMuzzleLight.intensity = 3.2 * (d.suppressed ? 0.3 : 1);
    this.game.render.viewMuzzleLight.position.copy(mz);
    this.game.render.muzzleLight.visible = true;
    this.game.render.muzzleLight.intensity = 6 * (d.suppressed ? 0.2 : 1);
    this.game.render.muzzleLight.position.set(eye.x + this._fwd.x, eye.y + this._fwd.y, eye.z + this._fwd.z);
    this.game._muzzleLightTimer = 0.045;

    // Shell ejection, offset to the right of the view.
    if (!d.shellReload) {
      const ejectDir = this._right;
      fx.shells.eject(
        eye.x + ejectDir.x * 0.28 + this._fwd.x * 0.35, eye.y - 0.12, eye.z + ejectDir.z * 0.28 + this._fwd.z * 0.35,
        ejectDir.x * rand(1.6, 3.2) + this.vel.x, rand(1.4, 2.6) + this.vel.y * 0.5, ejectDir.z * rand(1.6, 3.2) + this.vel.z,
      );
    }

    this.shotsSinceSmoke++;
    if (this.shotsSinceSmoke > 4) {
      this.shotsSinceSmoke = 0;
      fx.barrelSmoke(mz.x, mz.y, mz.z, 0.6);
    }

    // --- resolve hits ---
    let anyHit = false, anyKill = false, headshot = false;
    for (let i = 0; i < results.length; i++) {
      const { res, dir } = results[i];
      if (d.tracerEvery && (this.game.shotCounter % d.tracerEvery === 0 || pellets > 1)) {
        const start = { x: mz.x, y: mz.y, z: mz.z };
        // Tracer starts near the muzzle in world space, not view space.
        fx.tracer(
          eye.x + this._fwd.x * 0.6 + this._right.x * 0.16, eye.y - 0.08, eye.z + this._fwd.z * 0.6 + this._right.z * 0.16,
          dir.x, dir.y, dir.z, 260, 0.085,
        );
      }
      if (res.wallHit) {
        const wh = res.wallHit;
        fx.impact(wh.point.x, wh.point.y, wh.point.z, wh.normal.x, wh.normal.y, wh.normal.z, wh.brush.surface, 1);
        audio.impact(wh.point, wh.brush.surface);
      }
      for (const hit of res.hits) {
        anyHit = true;
        if (hit.zone === HITZONE.HEAD) headshot = true;
        fx.bloodSpray(hit.point.x, hit.point.y, hit.point.z, dir.x, dir.y, dir.z, 1);
        const killed = this.game.applyDamage(hit.entity, hit.damage, this, hit.zone, dir);
        if (killed) anyKill = true;
        this.onHitEvent?.(hit, killed);
      }
    }
    this.game.shotCounter++;
    if (anyHit) this.game.hud.hitmarker(headshot, anyKill);
    this.onFireEvent?.(d, eye, this._fwd);
    this.onNoiseEvent?.(this.pos, d.suppressed ? 22 : 75, 'gunshot');

    // Bolt-action cycle locks the weapon between shots.
    if (d.boltAction && (this.ammo[d.id] ?? 0) > 0) {
      this.game.schedule(0.12, () => {
        if (this.alive && this.def === d && !this.viewModel.isBusy()) this.viewModel.play(VMState.BOLT, 0.75);
      });
    }
    if ((this.ammo[d.id] ?? 0) === 0 && (this.reserve[d.id] ?? 0) > 0) {
      this.game.schedule(0.18, () => { if (this.alive && this.def === d) this.startReload(); });
    }
  }

  _melee() {
    const d = WEAPONS.knife;
    this.fireTimer = fireInterval(this.def);
    this.viewModel.play(VMState.MELEE, 0.55);
    const eye = this.eyePos;
    const yaw = this.yaw + this.recoilYaw;
    const pitch = this.pitch + this.recoilPitch;
    this._fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
    // The hit lands part-way through the swing, not on the button press.
    this.game.schedule(0.16, () => {
      if (!this.alive) return;
      const res = traceShot({
        world: this.world, entities: this.game.damageables, origin: eye,
        dir: this._fwd, def: d, shooter: this, maxDist: d.range ?? 2.4,
        friendlyFire: this.game.friendlyFire,
      });
      if (res.hits.length) {
        const hit = res.hits[0];
        // Backstab: hitting someone from behind is lethal.
        const e = hit.entity;
        const facing = e.yaw !== undefined
          ? Math.cos(e.yaw) * -this._fwd.z + Math.sin(e.yaw) * -this._fwd.x
          : 0;
        const dmg = facing > 0.55 ? (d.backstab ?? 200) : hit.damage;
        this.game.effects.bloodSpray(hit.point.x, hit.point.y, hit.point.z, this._fwd.x, this._fwd.y, this._fwd.z, 1.6);
        audio.impact(hit.point, 'flesh');
        const killed = this.game.applyDamage(e, dmg, this, hit.zone, this._fwd);
        this.game.hud.hitmarker(false, killed);
      } else if (res.wallHit && res.wallHit.dist < (d.range ?? 2.4)) {
        const wh = res.wallHit;
        this.game.effects.impact(wh.point.x, wh.point.y, wh.point.z, wh.normal.x, wh.normal.y, wh.normal.z, wh.brush.surface, 0.5);
        audio.impact(wh.point, wh.brush.surface);
      }
    });
    audio.mech(null, 'click', 0.35);
  }

  /* ------------------------------------------------------------ grenades -- */

  startCook() {
    if (!this.alive || this.viewModel.isBusy()) return;
    if ((this.grenades[this.grenadeType] ?? 0) <= 0) return;
    if (this.cookStart >= 0) return;
    this.cookStart = this.game.time;
    audio.mech(null, 'pinPull', 0.5);
  }

  releaseGrenade() {
    if (this.cookStart < 0) return;
    const cooked = this.game.time - this.cookStart;
    this.cookStart = -1;
    const type = this.grenadeType;
    const g = GRENADES[type];
    if (!g || (this.grenades[type] ?? 0) <= 0) return;
    this.grenades[type]--;
    const eye = this.eyePos;
    const yaw = this.yaw + this.recoilYaw;
    const pitch = this.pitch + this.recoilPitch;
    const dir = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch) + 0.16,
      -Math.cos(yaw) * Math.cos(pitch),
    ).normalize();
    const fuse = g.cook ? Math.max(0.35, g.fuse - cooked) : g.fuse;
    this.game.spawnGrenade({
      type, owner: this, fuse,
      pos: { x: eye.x + dir.x * 0.5, y: eye.y - 0.1, z: eye.z + dir.z * 0.5 },
      vel: { x: dir.x * g.throwSpeed + this.vel.x, y: dir.y * g.throwSpeed + this.vel.y, z: dir.z * g.throwSpeed + this.vel.z },
    });
    this.viewModel.swayPos.nudge(0, -0.06, 0.06);
    this.viewModel.swayRot.nudge(-2.5, 0, 0);
  }

  cycleGrenade() {
    const types = Object.keys(GRENADES);
    let i = types.indexOf(this.grenadeType);
    for (let k = 1; k <= types.length; k++) {
      const t = types[(i + k) % types.length];
      if ((this.grenades[t] ?? 0) > 0) { this.grenadeType = t; return; }
    }
  }

  /* -------------------------------------------------------------- damage -- */

  takeDamage(amount, source, zone, dir) {
    if (!this.alive) return false;
    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.lastDamageTime = this.game.time;
    this.tagUntil = this.game.time + 0.35;
    this.shake.nudge(rand(-1.6, 1.6), rand(-1.2, 1.6), rand(-1, 1));
    this.viewModel.onHurt();
    audio.ui('hurt');
    this.game.hud.damageIndicator(source, dir);
    this.game.render.post.fx.hitFlash = Math.min(1, this.game.render.post.fx.hitFlash + 0.55);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.onDeathEvent?.(source, zone);
      return true;
    }
    return false;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  giveArmor(amount) {
    this.armor = Math.min(this.maxArmor, this.armor + amount);
  }

  /* -------------------------------------------------------------- update -- */

  update(dt, input) {
    if (!this.alive) {
      this.shake.update(dt);
      this.landDip.update(dt);
      this.fovSpring.update(dt);
      return;
    }

    // ---- look ----
    const adsAmt = this.viewModel.adsAmount;
    const look = input.takeLook(adsAmt);
    this.yaw += look.yaw;
    this.pitch = clamp(this.pitch + look.pitch, -1.54, 1.54);
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;
    this._lookDx = look.yaw;
    this._lookDy = look.pitch;

    // Recoil punch decay. Counter-pulling steals from the punch first, which is
    // what lets a player "hold" a spray pattern flat.
    const rec = this.def?.recoil?.recovery ?? 8;
    const decay = 1 - Math.exp(-rec * dt);
    const dyaw = this.recoilYaw * decay;
    const dpitch = this.recoilPitch * decay;
    this.recoilYaw -= dyaw;
    this.recoilPitch -= dpitch;
    this.sprayRecover += dt;
    if (this.sprayRecover > 0.42 && !this.triggerHeld) this.sprayIndex = 0;

    // ---- stance ----
    const wantCrouch = this.game.settings.toggleCrouch ? this.crouching : input.isDown('crouch');
    this._applyCrouch(wantCrouch, dt);

    // ---- movement input ----
    let mx = 0, mz = 0;
    if (input.isDown('forward')) mz -= 1;
    if (input.isDown('back')) mz += 1;
    if (input.isDown('left')) mx -= 1;
    if (input.isDown('right')) mx += 1;
    const mag = Math.hypot(mx, mz);
    if (mag > 0) { mx /= mag; mz /= mag; }

    const wantSprint = (input.isDown('sprint') || (this.game.settings.autoSprint && mz < -0.5))
      && mz < -0.3 && !this.crouching && this.grounded && !this.reloading && adsAmt < 0.2;
    this.sprinting = wantSprint && mag > 0;

    // ---- speed ----
    let target = MOVE.walk;
    if (this.crouching) target = MOVE.crouch;
    else if (this.sprinting) target = MOVE.sprint;
    if (adsAmt > 0.01) target *= lerp(1, MOVE.adsScale, adsAmt);
    if (input.isDown('walk')) target *= 0.5;
    if (this.game.time < this.tagUntil) target *= 0.72;
    if (this.def) target *= 1 - clamp01((this.def.weight - 0.5) * 0.09);

    // ---- accelerate ----
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const wishX = mx * cy - mz * sy;
    const wishZ = -mx * sy - mz * cy;
    const accel = this.grounded ? MOVE.accelGround : MOVE.accelAir * MOVE.airControl;

    if (this.grounded) {
      // Friction first, then acceleration — gives crisp starts and stops.
      const speed = Math.hypot(this.vel.x, this.vel.z);
      if (speed > 0.01) {
        const drop = Math.max(speed, 3.0) * MOVE.friction * dt;
        const scale = Math.max(0, speed - drop) / speed;
        this.vel.x *= scale; this.vel.z *= scale;
      } else { this.vel.x = 0; this.vel.z = 0; }
    }

    if (mag > 0) {
      const current = this.vel.x * wishX + this.vel.z * wishZ;
      const add = clamp(target - current, 0, accel * dt);
      this.vel.x += wishX * add;
      this.vel.z += wishZ * add;
    }

    // Cap horizontal speed on the ground so diagonals aren't faster.
    if (this.grounded) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > target) {
        const s = target / hs;
        this.vel.x *= s; this.vel.z *= s;
      }
    }

    // ---- jump / gravity ----
    if (input.isDown('jump') && this.grounded && this._jumpCooldown <= 0) {
      this.vel.y = MOVE.jumpVel;
      this.grounded = false;
      this._jumpCooldown = 0.28;
      this.viewModel.swayPos.nudge(0, -0.05, 0);
      audio.step(null, this.groundSurface, 0.2);
    }
    this._jumpCooldown = Math.max(0, (this._jumpCooldown ?? 0) - dt);
    this.vel.y -= MOVE.gravity * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    // ---- integrate ----
    this._delta.x = this.vel.x * dt;
    this._delta.y = this.vel.y * dt;
    this._delta.z = this.vel.z * dt;
    this.wasGrounded = this.grounded;
    const res = this.mover.move(this.pos, this.radius, this.height, this._delta, MOVE.stepHeight, true);
    this.grounded = res.grounded;
    if (res.groundSurface) this.groundSurface = res.groundSurface;
    if (res.grounded && this.vel.y < 0) this.vel.y = 0;
    if (res.ceiling && this.vel.y > 0) this.vel.y = 0;
    if (res.wall) {
      // Kill the velocity component into the wall so we don't stick.
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > 0.1) { this.vel.x *= 0.72; this.vel.z *= 0.72; }
    }

    // Landing.
    if (this.grounded && !this.wasGrounded) {
      const impact = clamp01(-this._lastFallSpeed / 14);
      if (impact > 0.05) {
        this.landDip.nudge(-impact * 5.5);
        this.viewModel.onLand(impact * 1.6);
        audio.step(null, this.groundSurface, 0.3 + impact * 0.4);
        this.onNoiseEvent?.(this.pos, 8 + impact * 14, 'land');
        if (impact > 0.85) this.takeDamage((impact - 0.85) * 120, null, 'body', { x: 0, y: -1, z: 0 });
      }
    }
    this._lastFallSpeed = this.vel.y;

    this.moveSpeed = Math.hypot(this.vel.x, this.vel.z);

    // ---- footsteps ----
    if (this.grounded && this.moveSpeed > 0.6) {
      this.stepDistance += this.moveSpeed * dt;
      const stride = this.sprinting ? 2.15 : this.crouching ? 2.6 : 1.85;
      if (this.stepDistance > stride) {
        this.stepDistance = 0;
        const vol = this.sprinting ? 0.42 : this.crouching ? 0.1 : 0.26;
        audio.step({ x: this.pos.x, y: this.pos.y, z: this.pos.z }, this.groundSurface, vol);
        this.viewModel.onStep(this.sprinting ? 1.3 : 0.8);
        this.onNoiseEvent?.(this.pos, this.sprinting ? 26 : this.crouching ? 3 : 15, 'footstep');
      }
    }

    // ---- weapon input ----
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    const wasHeld = this.triggerHeld;
    this.triggerHeld = input.mouse.left && !this.game.paused;
    if (!this.triggerHeld) this.firedThisPress = false;
    if (this.triggerHeld) this.tryFire(this.game.time);

    const adsInput = this.game.settings.toggleAds
      ? this.wantAds
      : input.mouse.right;
    this.wantAds = adsInput && !this.sprinting && !this.viewModel.isBusy();
    this.viewModel.setAds(this.wantAds);
    this.viewModel.setSprint(this.sprinting);

    if (input.wasPressed('reload')) this.startReload();
    if (input.wasPressed('slot1')) this.switchTo(0);
    if (input.wasPressed('slot2')) this.switchTo(1);
    if (input.wasPressed('slot3')) this.switchTo(2);
    if (input.wasPressed('swap')) this.swapLast();
    if (input.wasPressed('melee') && this.slotIndex !== 2) this._quickMelee();
    if (input.wasPressed('inspect') && !this.viewModel.isBusy()) this.viewModel.play(VMState.INSPECT, 2.2);
    if (input.mouse.wheel !== 0) this.switchTo((this.slotIndex + (input.mouse.wheel > 0 ? 1 : -1) + this.loadout.length) % this.loadout.length);

    if (input.isDown('grenade')) this.startCook();
    else if (this.cookStart >= 0) this.releaseGrenade();

    // Cooking too long blows up in your hand — a real risk, as intended.
    if (this.cookStart >= 0) {
      const g = GRENADES[this.grenadeType];
      if (g?.cook && this.game.time - this.cookStart > g.fuse) {
        this.releaseGrenade();
      }
    }

    // ---- regeneration ----
    if (this.regenEnabled && this.health < this.maxHealth && this.game.time - this.lastDamageTime > this.regenDelay) {
      this.health = Math.min(this.maxHealth, this.health + this.regenRate * dt);
    }

    // ---- camera springs ----
    this.shake.setTarget(0, 0, 0);
    this.shake.update(dt);
    this.landDip.target = 0;
    this.landDip.update(dt);
    const targetFov = lerp(1, this.def?.adsFovScale ?? 0.7, adsAmt);
    this.fovSpring.target = targetFov;
    this.fovSpring.update(dt);

    // ---- view model ----
    this.viewModel.settings.viewBob = this.game.settings.viewBob;
    this.viewModel.settings.weaponSway = this.game.settings.weaponSway;
    this.viewModel.update(dt, {
      speed: this.moveSpeed,
      grounded: this.grounded,
      crouching: this.crouching,
      lookDx: this._lookDx,
      lookDy: this._lookDy,
    });
  }

  _quickMelee() {
    if (this.viewModel.isBusy()) return;
    const saved = this.slotIndex;
    const knifeIndex = this.loadout.indexOf('knife');
    if (knifeIndex === -1) return;
    this._equip(knifeIndex, true);
    this.firedThisPress = false;
    this._melee();
    this.game.schedule(0.6, () => {
      if (this.alive && this.slotIndex === knifeIndex) this._equip(saved, true);
    });
  }

  _applyCrouch(want, dt) {
    if (want && !this.crouching) {
      this.crouching = true;
    } else if (!want && this.crouching) {
      // Only stand if there's headroom.
      if (this.mover.fits(this.pos.x, this.pos.y + 0.02, this.pos.z, this.radius, MOVE.height)) {
        this.crouching = false;
      }
    }
    const targetH = this.crouching ? MOVE.crouchHeight : MOVE.height;
    const prev = this.height;
    this.height = damp(this.height, targetH, 14, dt);
    // Growing upward can push us into a ceiling; verify and revert if so.
    if (this.height > prev && !this.mover.fits(this.pos.x, this.pos.y + 0.02, this.pos.z, this.radius, this.height)) {
      this.height = prev;
      this.crouching = true;
    }
    this.crouchAmount = clamp01((MOVE.height - this.height) / (MOVE.height - MOVE.crouchHeight));
    this.eyeHeight = this.height * 0.93;
  }

  /** Write the final camera transform. Called after update, once per frame. */
  applyCamera(camera, viewCamera, settings) {
    const eye = this.eyePos;
    camera.position.set(eye.x, eye.y, eye.z);
    const shakeScale = settings.cameraShake;
    camera.rotation.set(
      clamp(this.pitch + this.recoilPitch + this.shake.y.value * 0.012 * shakeScale, -1.56, 1.56),
      this.yaw + this.recoilYaw + this.shake.x.value * 0.012 * shakeScale,
      this.shake.z.value * 0.01 * shakeScale + this.lean.value * 0.06,
      'YXZ',
    );
    const baseFov = settings.fov;
    const speedFov = clamp01((this.moveSpeed - MOVE.walk) / (MOVE.sprint - MOVE.walk)) * 5;
    camera.fov = baseFov * this.fovSpring.value + speedFov * (1 - this.viewModel.adsAmount);
    camera.updateProjectionMatrix();
    viewCamera.rotation.copy(camera.rotation);
    viewCamera.fov = lerp(62, 48, this.viewModel.adsAmount);
    viewCamera.updateProjectionMatrix();
  }

  forwardVector(out = new THREE.Vector3()) {
    const yaw = this.yaw + this.recoilYaw;
    const pitch = this.pitch + this.recoilPitch;
    return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
  }
}

export { MOVE };
