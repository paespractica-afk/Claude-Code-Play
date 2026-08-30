// View-model rig and animation.
//
// Nothing here snaps. Poses are targets fed to critically-damped springs, and
// timed animations (reload, draw, inspect) are evaluated as smooth curves over
// normalised time, then layered additively on top of the pose.

import * as THREE from 'three';
import { Spring, Spring3, clamp, clamp01, lerp, damp, ease, rand, TAU } from '../core/math.js';
import { buildWeaponModel, disposeWeaponModel } from './model.js';
import { mergeRigid } from '../render/rig.js';

/** Smooth 0->1 window; `a` and `b` are the phase boundaries within a clip. */
const win = (t, a, b) => clamp01((t - a) / (b - a || 1));
const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
/** Rises to 1 at the middle of [a,b] and returns to 0 — for "out and back" motion. */
const pulse = (t, a, b) => {
  const x = win(t, a, b);
  return Math.sin(x * Math.PI);
};

export const VMState = {
  IDLE: 'idle',
  FIRING: 'firing',
  RELOAD: 'reload',
  DRAW: 'draw',
  HOLSTER: 'holster',
  INSPECT: 'inspect',
  MELEE: 'melee',
  SHELL_INSERT: 'shellInsert',
  BOLT: 'bolt',
};

export class ViewModel {
  /** @param {THREE.Object3D} viewRig a node parented to the view camera */
  constructor(viewRig, effects) {
    this.scene = viewRig;
    this.effects = effects;

    this.root = new THREE.Group();     // whole rig, receives sway/bob/recoil
    this.holder = new THREE.Group();   // per-weapon pose (hip/ADS/sprint)
    this.anim = new THREE.Group();     // additive animation layer (reload etc.)
    this.root.add(this.holder);
    this.holder.add(this.anim);
    this.scene.add(this.root);

    this.model = null;
    this.def = null;

    // --- springs ---
    this.swayPos = new Spring3(90, 15);
    this.swayRot = new Spring3(80, 14);
    this.recoilPos = new Spring3(260, 22);
    this.recoilRot = new Spring3(200, 19);
    this.adsSpring = new Spring(150, 24, 0);
    this.sprintSpring = new Spring(90, 16, 0);
    this.dipSpring = new Spring(120, 16, 0);
    this.crouchSpring = new Spring(110, 17, 0);
    this.lowReady = new Spring(100, 16, 0);

    // --- state ---
    this.state = VMState.IDLE;
    this.stateTime = 0;
    this.stateDuration = 0;
    this.bobPhase = 0;
    this.breathPhase = 0;
    this.time = 0;
    this.adsTarget = 0;
    this.sprintTarget = 0;
    this.pendingCallbacks = [];
    this.settings = { viewBob: 1, weaponSway: 1 };

    // Per-weapon pose offsets, resolved from the model's aim point.
    this.hipPos = new THREE.Vector3(0.13, -0.115, -0.26);
    this.hipRot = new THREE.Euler(0.02, -0.06, 0.03);
    this.adsPos = new THREE.Vector3();
    this.adsRot = new THREE.Euler(0, 0, 0);

    this._tmp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._muzzleWorld = new THREE.Vector3();
  }

  /** Swap in a weapon model and recompute its pose offsets. */
  setWeapon(def) {
    if (this.model) {
      this.anim.remove(this.model.root);
      disposeWeaponModel(this.model);
    }
    this.def = def;
    this.model = buildWeaponModel(def);
    // Collapse the gun into four meshes: the animated magazine, bolt and
    // trigger, plus everything static. Thirty-plus draw calls become four.
    const animated = new Set();
    for (const key of ['magazine', 'bolt', 'trigger']) {
      const part = this.model.parts[key];
      if (part && part !== this.model.root) { mergeRigid(part); animated.add(part); }
    }
    mergeRigid(this.model.root, animated);
    // Real-scale guns fill half the screen; shooters draw them smaller and
    // closer so the sights still line up but the view stays readable.
    this.model.root.scale.setScalar(0.80);
    this.anim.add(this.model.root);

    // Hip pose scales a little with weapon weight so heavy guns sit lower.
    const w = def.weight ?? 1;
    // Far enough forward that the stock is not magnified into the corner, and
    // yawed so the barrel angles toward the crosshair rather than pointing
    // end-on at the camera.
    this.hipPos.set(0.140 + w * 0.008, -0.052 - w * 0.012, -0.38 - w * 0.022);
    this.hipRot.set(0.028, 0.145, 0.052);

    // ADS: put the weapon's aim point on the camera axis.
    const S = 0.80;
    const ap = this.model.parts.aimPoint.position;
    const dist = def.scoped ? -0.16 : -0.235;
    this.adsPos.set(-ap.x * S, -ap.y * S, dist - ap.z * S);
    this.adsRot.set(0, 0, 0);

    // Reset every spring so a weapon swap can't inherit the last gun's motion.
    this.swayPos.reset(); this.swayRot.reset();
    this.recoilPos.reset(); this.recoilRot.reset();
    this._partBase = {
      magazine: this.model.parts.magazine ? this.model.parts.magazine.position.clone() : null,
      magazineRot: this.model.parts.magazine ? this.model.parts.magazine.rotation.clone() : null,
      bolt: this.model.parts.bolt ? this.model.parts.bolt.position.clone() : null,
      trigger: this.model.parts.trigger ? this.model.parts.trigger.position.clone() : null,
    };
    return this.model;
  }

  play(state, duration, onDone = null) {
    this.state = state;
    this.stateTime = 0;
    this.stateDuration = Math.max(0.001, duration);
    this._onDone = onDone;
  }

  isBusy() {
    return this.state === VMState.RELOAD || this.state === VMState.DRAW ||
           this.state === VMState.HOLSTER || this.state === VMState.MELEE ||
           this.state === VMState.SHELL_INSERT || this.state === VMState.BOLT;
  }

  cancelAnimation() {
    if (this.state !== VMState.IDLE) {
      this.state = VMState.IDLE;
      this.stateTime = 0;
      this._onDone = null;
    }
  }

  /** A shot was fired: kick the springs and cycle the action. */
  onFire(recoilScale = 1) {
    const r = this.def?.recoil ?? { kick: 1, viewKick: 1 };
    const k = r.kick * recoilScale;
    this.recoilPos.nudge(rand(-0.006, 0.006) * k, 0.012 * k, 0.085 * k);
    this.recoilRot.nudge(rand(-0.5, 0.5) * k, rand(-0.35, 0.35) * k, -0.16 * k);
    this._actionTime = 0;
    this._actionCycle = this.def?.boltAction ? 0 : Math.min(0.09, 40 / (this.def?.rpm ?? 600));
  }

  onLand(impact = 1) { this.dipSpring.nudge(-1.8 * clamp(impact, 0, 2.2)); }
  onStep(strength = 1) { this.swayPos.nudge(0, -0.02 * strength, 0); }
  onHurt() { this.swayRot.nudge(rand(-2, 2), rand(-2, 2), rand(-2, 2)); }

  setAds(on) { this.adsTarget = on ? 1 : 0; }
  setSprint(on) { this.sprintTarget = on ? 1 : 0; }
  get adsAmount() { return this.adsSpring.value; }

  /** World-space muzzle position of the view model (for flash placement). */
  muzzleLocal(out = new THREE.Vector3()) {
    if (!this.model) return out.set(0, 0, -0.5);
    this.model.parts.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.model.parts.muzzle.matrixWorld);
  }

  update(dt, ctx) {
    if (!this.model) return;
    this.time += dt;
    const s = this.settings;

    // ---- state clock ----
    if (this.state !== VMState.IDLE && this.state !== VMState.FIRING) {
      this.stateTime += dt;
      if (this.stateTime >= this.stateDuration) {
        const cb = this._onDone;
        this.state = VMState.IDLE;
        this._onDone = null;
        if (cb) cb();
      }
    }

    // ---- pose blending ----
    // Sprinting and reloading both force the weapon out of the aim pose.
    const canAds = !this.isBusy() && this.sprintTarget < 0.5;
    this.adsSpring.target = canAds ? this.adsTarget : 0;
    this.adsSpring.update(dt);
    this.sprintSpring.target = this.sprintTarget;
    this.sprintSpring.update(dt);
    this.lowReady.target = this.isBusy() && this.state !== VMState.MELEE ? 1 : 0;
    this.lowReady.update(dt);
    this.dipSpring.update(dt);
    this.crouchSpring.target = ctx.crouching ? 1 : 0;
    this.crouchSpring.update(dt);

    const ads = clamp01(this.adsSpring.value);
    const sprint = clamp01(this.sprintSpring.value) * (1 - ads);

    // Base pose = lerp(hip, ads), then rotated aside for sprint.
    const px = lerp(this.hipPos.x, this.adsPos.x, ads);
    const py = lerp(this.hipPos.y, this.adsPos.y, ads);
    const pz = lerp(this.hipPos.z, this.adsPos.z, ads);
    const rx = lerp(this.hipRot.x, this.adsRot.x, ads);
    const ry = lerp(this.hipRot.y, this.adsRot.y, ads);
    const rz = lerp(this.hipRot.z, this.adsRot.z, ads);

    // Sprint pose: canted across the body, muzzle down and out.
    const sp = smoothstep(sprint);
    this.holder.position.set(
      px + sp * 0.06,
      py + sp * -0.055 + this.crouchSpring.value * 0.012,
      pz + sp * 0.07,
    );
    this.holder.rotation.set(
      rx + sp * -0.45,
      ry + sp * 0.72,
      rz + sp * -0.34,
    );

    // Low-ready during reloads keeps the gun readable and out of the crosshair.
    const lr = this.lowReady.value;
    this.holder.position.y += lr * -0.045;
    this.holder.position.z += lr * 0.02;
    this.holder.rotation.x += lr * -0.14;

    // ---- sway from look input ----
    const swayScale = (1 - ads * 0.72) * s.weaponSway;
    const lookX = clamp(ctx.lookDx ?? 0, -0.06, 0.06);
    const lookY = clamp(ctx.lookDy ?? 0, -0.06, 0.06);
    this.swayPos.setTarget(
      clamp(-lookX * 1.6, -0.05, 0.05) * swayScale,
      clamp(lookY * 1.2, -0.05, 0.05) * swayScale,
      0,
    );
    this.swayRot.setTarget(
      clamp(-lookY * 4.0, -0.25, 0.25) * swayScale,
      clamp(lookX * 4.5, -0.25, 0.25) * swayScale,
      clamp(lookX * 3.2, -0.2, 0.2) * swayScale,
    );
    this.swayPos.update(dt);
    this.swayRot.update(dt);

    // ---- walk bob (figure-eight) ----
    const speed = ctx.speed ?? 0;
    const grounded = ctx.grounded !== false;
    const bobSpeed = clamp(speed / 5.6, 0, 1.7);
    if (grounded) this.bobPhase += dt * (6.2 + bobSpeed * 4.2) * bobSpeed;
    const bobAmt = bobSpeed * (1 - ads * 0.82) * s.viewBob * (grounded ? 1 : 0.15);
    const bobX = Math.sin(this.bobPhase) * 0.018 * bobAmt;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.014 * bobAmt;
    const bobRz = Math.sin(this.bobPhase) * 0.03 * bobAmt;
    const bobRx = Math.cos(this.bobPhase * 2) * 0.012 * bobAmt;

    // ---- idle breathing ----
    this.breathPhase += dt * 1.15;
    const breathe = (1 - Math.min(1, bobSpeed * 2)) * (1 - ads * 0.55);
    const brY = Math.sin(this.breathPhase) * 0.0035 * breathe;
    const brX = Math.sin(this.breathPhase * 0.63 + 1.1) * 0.0025 * breathe;
    const brRx = Math.sin(this.breathPhase * 0.8) * 0.008 * breathe;

    // ---- recoil springs ----
    this.recoilPos.setTarget(0, 0, 0);
    this.recoilRot.setTarget(0, 0, 0);
    this.recoilPos.update(dt);
    this.recoilRot.update(dt);

    // ---- compose root transform ----
    this.root.position.set(
      this.swayPos.x.value + bobX + brX + this.recoilPos.x.value,
      this.swayPos.y.value + bobY + brY + this.recoilPos.y.value + this.dipSpring.value * 0.035,
      this.recoilPos.z.value,
    );
    this.root.rotation.set(
      this.swayRot.x.value * 0.35 + bobRx + brRx + this.recoilRot.x.value * 0.06 + this.dipSpring.value * 0.05,
      this.swayRot.y.value * 0.35 + this.recoilRot.y.value * 0.05,
      this.swayRot.z.value * 0.35 + bobRz + this.recoilRot.z.value * 0.05,
    );

    // ---- animation layer ----
    this.anim.position.set(0, 0, 0);
    this.anim.rotation.set(0, 0, 0);
    this._resetParts();
    this._animateAction(dt);
    switch (this.state) {
      case VMState.RELOAD: this._animReload(this.stateTime / this.stateDuration); break;
      case VMState.SHELL_INSERT: this._animShellInsert(this.stateTime / this.stateDuration); break;
      case VMState.BOLT: this._animBolt(this.stateTime / this.stateDuration); break;
      case VMState.DRAW: this._animDraw(this.stateTime / this.stateDuration); break;
      case VMState.HOLSTER: this._animHolster(this.stateTime / this.stateDuration); break;
      case VMState.INSPECT: this._animInspect(this.stateTime / this.stateDuration); break;
      case VMState.MELEE: this._animMelee(this.stateTime / this.stateDuration); break;
      default: break;
    }
  }

  _resetParts() {
    const b = this._partBase;
    const p = this.model.parts;
    if (!b) return;
    if (p.magazine && b.magazine) { p.magazine.position.copy(b.magazine); p.magazine.rotation.copy(b.magazineRot); p.magazine.visible = true; }
    if (p.bolt && b.bolt) p.bolt.position.copy(b.bolt);
    if (p.trigger && b.trigger) p.trigger.position.copy(b.trigger);
  }

  /** Slide/bolt cycling and trigger pull, driven by time since the last shot. */
  _animateAction(dt) {
    if (this._actionTime === undefined) return;
    this._actionTime += dt;
    const p = this.model.parts;
    const cycle = this._actionCycle ?? 0.08;
    if (cycle > 0 && p.bolt && this._partBase?.bolt) {
      const t = clamp01(this._actionTime / cycle);
      // Fast rearward travel, slower return — how a real action feels.
      const travel = t < 0.4 ? ease.outQuint(t / 0.4) : 1 - ease.outCubic((t - 0.4) / 0.6);
      p.bolt.position.z = this._partBase.bolt.z + travel * 0.035;
    }
    if (p.trigger && this._partBase?.trigger) {
      const t = clamp01(this._actionTime / 0.09);
      p.trigger.position.z = this._partBase.trigger.z + (1 - t) * 0.004;
    }
  }

  /** Magazine reload: tilt, drop, insert, seat, rack. */
  _animReload(t) {
    const p = this.model.parts;
    const a = this.anim;

    // Whole-gun motion: tilt in, hold, return.
    const tilt = pulse(t, 0, 0.92);
    a.rotation.z = tilt * 0.42;
    a.rotation.x = tilt * -0.12;
    a.rotation.y = tilt * 0.2;
    a.position.y = tilt * -0.035;
    a.position.x = tilt * 0.02;

    if (p.magazine && this._partBase?.magazine) {
      const base = this._partBase.magazine;
      // Old magazine falls away.
      const drop = win(t, 0.12, 0.34);
      // New magazine comes up from below and seats.
      const insert = win(t, 0.42, 0.72);
      if (t < 0.38) {
        const d = ease.inOutCubic(drop);
        p.magazine.position.set(base.x, base.y - d * 0.34, base.z + d * 0.02);
        p.magazine.rotation.z = this._partBase.magazineRot.z + d * 0.5;
        p.magazine.visible = drop < 0.98;
      } else {
        const i = ease.outCubic(insert);
        p.magazine.visible = insert > 0.02;
        p.magazine.position.set(base.x, base.y - (1 - i) * 0.3, base.z);
        p.magazine.rotation.z = this._partBase.magazineRot.z + (1 - i) * -0.35;
        // Little settle bump as it clicks home.
        if (insert >= 1) p.magazine.position.y = base.y + Math.sin((t - 0.72) * 60) * 0.0015 * Math.max(0, 1 - (t - 0.72) * 6);
      }
    }

    // Charging handle rack at the end (only on an empty reload).
    if (this._rackAtEnd && p.bolt && this._partBase?.bolt) {
      const rack = pulse(t, 0.74, 0.94);
      p.bolt.position.z = this._partBase.bolt.z + rack * 0.05;
      a.rotation.z += rack * -0.1;
    }
  }

  /** Shotgun: one shell at a time, hand comes up under the receiver. */
  _animShellInsert(t) {
    const a = this.anim;
    const lift = pulse(t, 0, 1);
    a.rotation.z = lift * 0.30;
    a.rotation.x = lift * -0.08;
    a.position.y = lift * -0.022;
    const p = this.model.parts;
    if (p.bolt && this._partBase?.bolt) {
      const rack = pulse(t, 0.55, 1);
      p.bolt.position.z = this._partBase.bolt.z + rack * 0.06;
    }
  }

  /** Bolt-action cycle between sniper shots. */
  _animBolt(t) {
    const p = this.model.parts;
    const a = this.anim;
    a.rotation.z = pulse(t, 0, 1) * 0.16;
    a.rotation.y = pulse(t, 0, 1) * 0.1;
    if (p.bolt && this._partBase?.bolt) {
      const back = win(t, 0.1, 0.45);
      const fwd = win(t, 0.55, 0.92);
      const travel = ease.outCubic(back) - ease.inOutCubic(fwd);
      p.bolt.position.z = this._partBase.bolt.z + travel * 0.08;
      p.bolt.rotation.z = -travel * 1.1;
    }
  }

  _animDraw(t) {
    const e = ease.outCubic(clamp01(t));
    const a = this.anim;
    a.position.y = (1 - e) * -0.32;
    a.position.z = (1 - e) * 0.1;
    a.rotation.x = (1 - e) * 0.9;
    a.rotation.z = (1 - e) * -0.5;
    // Tiny settle overshoot at the end so it lands with weight.
    const settle = Math.max(0, 1 - Math.abs(t - 0.82) * 9);
    a.rotation.x += settle * 0.035;
  }

  _animHolster(t) {
    const e = ease.inOutCubic(clamp01(t));
    const a = this.anim;
    a.position.y = e * -0.34;
    a.position.z = e * 0.08;
    a.rotation.x = e * 0.95;
    a.rotation.z = e * -0.55;
  }

  _animInspect(t) {
    const a = this.anim;
    const lift = pulse(t, 0, 1);
    a.position.set(lift * -0.04, lift * 0.05, lift * 0.12);
    a.rotation.y = Math.sin(t * Math.PI * 2) * 0.9 * smoothstep(Math.min(1, t * 3)) * (1 - smoothstep(Math.max(0, (t - 0.75) * 4)));
    a.rotation.z = lift * 0.35;
    a.rotation.x = lift * -0.22;
    const p = this.model.parts;
    if (p.magazine && this._partBase?.magazine && t > 0.35 && t < 0.7) {
      const k = pulse(t, 0.35, 0.7);
      p.magazine.position.y = this._partBase.magazine.y - k * 0.05;
    }
  }

  _animMelee(t) {
    const a = this.anim;
    // Wind up, snap forward, recover.
    const windup = win(t, 0, 0.28);
    const strike = win(t, 0.28, 0.46);
    const recover = win(t, 0.46, 1);
    const w = ease.outCubic(windup) * (1 - strike);
    const s = ease.outQuint(strike) * (1 - ease.inOutCubic(recover));
    a.position.set(w * 0.09 - s * 0.05, w * 0.05 - s * 0.03, w * 0.11 - s * 0.34);
    a.rotation.set(w * -0.5 + s * 0.55, w * 0.9 - s * 1.0, w * -0.6 + s * 0.5);
  }

  dispose() {
    if (this.model) disposeWeaponModel(this.model);
    this.scene.remove(this.root);
  }
}
