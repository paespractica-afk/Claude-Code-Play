// Procedural humanoid: a small skeleton of boxes animated by curve-driven
// joint angles. No skinning, no external rigs — but it walks, aims, reacts to
// hits, and falls over convincingly.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, dampAngle, shortAngle, rand, TAU, Spring } from '../core/math.js';
import { buildWeaponModel } from '../weapons/model.js';
import { buildSkinned, mergeRigid, createPartMaterial } from '../render/rig.js';

const TEAM_COLORS = [
  { primary: 0x2c3e5c, secondary: 0x1a2436, accent: 0x4fc3f7, light: 0x4fc3f7 },
  { primary: 0x5c2f2c, secondary: 0x36201a, accent: 0xff7043, light: 0xff7043 },
  { primary: 0x2f4a2c, secondary: 0x1e2e1a, accent: 0x9ccc65, light: 0x9ccc65 },
];

function m(color, rough = 0.72, metal = 0.06, emissive = null, ei = 1) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal,
    emissive: emissive ? new THREE.Color(emissive) : 0x000000,
    emissiveIntensity: ei,
  });
}

function limbBox(w, h, d, mat, yOffset = -h / 2) {
  // Pivot at the top of the box so rotations read like joints.
  const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  g.position.y = yOffset;
  g.castShadow = true;
  g.receiveShadow = true;
  const pivot = new THREE.Group();
  pivot.add(g);
  return pivot;
}

export class Character {
  constructor(team = 0, opts = {}) {
    this.team = team;
    const c = TEAM_COLORS[team % TEAM_COLORS.length];
    const shade = opts.shade ?? 1;
    const mSuit = m(new THREE.Color(c.primary).multiplyScalar(shade).getHex(), 0.82, 0.04);
    const mArmor = m(new THREE.Color(c.secondary).multiplyScalar(shade).getHex(), 0.55, 0.35);
    const mSkin = m(0x8d6449, 0.86, 0.02);
    const mDark = m(0x14161a, 0.7, 0.2);
    const mAccent = m(c.accent, 0.4, 0.5, c.accent, 0.8);
    const mVisor = m(0x0a1418, 0.12, 0.85, c.light, 0.35);
    this.materials = [mSuit, mArmor, mSkin, mDark, mAccent, mVisor];
    this.teamColor = c;

    this.root = new THREE.Group();

    // --- hips / spine ---
    this.hips = new THREE.Group();
    this.hips.position.y = 0.94;
    this.root.add(this.hips);
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.2), mSuit);
    pelvis.castShadow = true;
    this.hips.add(pelvis);
    this.hips.add(this._mesh(new THREE.BoxGeometry(0.34, 0.06, 0.22), mDark, 0, 0.02, 0));

    this.spine = new THREE.Group();
    this.spine.position.y = 0.1;
    this.hips.add(this.spine);
    this.chest = new THREE.Group();
    this.chest.position.y = 0.14;
    this.spine.add(this.chest);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.24), mSuit);
    torso.position.y = 0.19;
    torso.castShadow = true;
    this.chest.add(torso);
    // Plate carrier.
    this.chest.add(this._mesh(new THREE.BoxGeometry(0.36, 0.3, 0.28), mArmor, 0, 0.2, 0));
    this.chest.add(this._mesh(new THREE.BoxGeometry(0.1, 0.06, 0.02), mAccent, 0, 0.3, 0.14));
    // Pouches.
    for (const sx of [-0.11, 0, 0.11]) this.chest.add(this._mesh(new THREE.BoxGeometry(0.08, 0.09, 0.05), mDark, sx, 0.1, 0.15));
    // Shoulder pads.
    this.chest.add(this._mesh(new THREE.BoxGeometry(0.1, 0.12, 0.18), mArmor, -0.22, 0.33, 0));
    this.chest.add(this._mesh(new THREE.BoxGeometry(0.1, 0.12, 0.18), mArmor, 0.22, 0.33, 0));

    // --- neck / head ---
    this.neck = new THREE.Group();
    this.neck.position.y = 0.42;
    this.chest.add(this.neck);
    this.head = new THREE.Group();
    this.neck.add(this.head);
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.22, 0.21), mSkin);
    skull.position.y = 0.11;
    skull.castShadow = true;
    this.head.add(skull);
    // Helmet.
    this.head.add(this._mesh(new THREE.BoxGeometry(0.22, 0.14, 0.24), mArmor, 0, 0.16, -0.005));
    this.head.add(this._mesh(new THREE.BoxGeometry(0.225, 0.04, 0.05), mArmor, 0, 0.1, -0.10));
    // Visor / goggles with a team-coloured glow so targets read at distance.
    this.head.add(this._mesh(new THREE.BoxGeometry(0.2, 0.055, 0.03), mVisor, 0, 0.115, 0.105));
    this.head.add(this._mesh(new THREE.BoxGeometry(0.02, 0.035, 0.03), mAccent, 0.085, 0.175, 0.09));

    // --- arms ---
    this.armL = this._makeArm(mSuit, mArmor, mDark, -1);
    this.armR = this._makeArm(mSuit, mArmor, mDark, 1);
    this.armL.group.position.set(-0.24, 0.36, 0);
    this.armR.group.position.set(0.24, 0.36, 0);
    this.chest.add(this.armL.group);
    this.chest.add(this.armR.group);

    // --- legs ---
    this.legL = this._makeLeg(mSuit, mDark, mArmor);
    this.legR = this._makeLeg(mSuit, mDark, mArmor);
    this.legL.group.position.set(-0.1, -0.06, 0);
    this.legR.group.position.set(0.1, -0.06, 0);
    this.hips.add(this.legL.group);
    this.hips.add(this.legR.group);

    // --- weapon mount on the right hand ---
    this.weaponMount = new THREE.Group();
    this.weaponMount.position.set(0, -0.26, 0);
    this.weapon = null;

    // --- collapse the rig into a single skinned mesh ---
    // Forty-odd little boxes would be forty-odd draw calls per character; baked
    // into one skinned geometry it is one, with PBR values carried per vertex.
    const parts = [
      { node: this.hips }, { node: this.spine }, { node: this.chest },
      { node: this.neck }, { node: this.head },
      { node: this.armL.group }, { node: this.armL.upper }, { node: this.armL.forearm },
      { node: this.armR.group }, { node: this.armR.upper }, { node: this.armR.forearm },
      { node: this.legL.group }, { node: this.legL.thigh }, { node: this.legL.shin }, { node: this.legL.foot },
      { node: this.legR.group }, { node: this.legR.thigh }, { node: this.legR.shin }, { node: this.legR.foot },
    ];
    const skinned = buildSkinned(this.root, parts);
    this.skinnedMesh = skinned.mesh;
    this.boneList = skinned.boneList;
    // Re-point every animated reference at its bone; the original groups are
    // now empty and detached.
    const B = (n) => skinned.bones.get(n) || n;
    this.root.remove(this.hips);
    this.hips = B(this.hips);
    this.spine = B(this.spine);
    this.chest = B(this.chest);
    this.neck = B(this.neck);
    this.head = B(this.head);
    for (const arm of [this.armL, this.armR]) {
      arm.group = B(arm.group); arm.upper = B(arm.upper); arm.forearm = B(arm.forearm);
    }
    for (const leg of [this.legL, this.legR]) {
      leg.group = B(leg.group); leg.thigh = B(leg.thigh); leg.shin = B(leg.shin); leg.foot = B(leg.foot);
    }
    this.hipsRest = this.hips.position.y;
    this.armR.forearm.add(this.weaponMount);

    // --- animation state ---
    this.phase = rand(0, TAU);
    this.speed = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.crouch = 0;
    this.crouchTarget = 0;
    this.dead = false;
    this.deathTime = 0;
    this.deathTilt = 0;
    this.deathSpin = 0;
    this.hitReact = new Spring(120, 12, 0);
    this.recoilSpring = new Spring(220, 16, 0);
    this.aimBlend = 0;
    this.aimTarget = 0;
    this.reloadTime = -1;
    this.reloadDuration = 1;
    this.breath = rand(0, TAU);
    this.footPlant = [0, 0];
    this.onFootstep = null;
    this._prevPhase = 0;
  }

  _mesh(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  }

  _makeArm(mSuit, mArmor, mDark, side) {
    const group = new THREE.Group();
    const upper = limbBox(0.11, 0.26, 0.12, mSuit);
    group.add(upper);
    const forearm = new THREE.Group();
    forearm.position.y = -0.26;
    upper.add(forearm);
    const foreMesh = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.25, 0.105), mSuit);
    foreMesh.position.y = -0.125;
    foreMesh.castShadow = true;
    forearm.add(foreMesh);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.09), mDark);
    hand.position.y = -0.28;
    hand.castShadow = true;
    forearm.add(hand);
    // Elbow pad.
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.11), mArmor);
    pad.position.y = -0.02;
    forearm.add(pad);
    return { group, upper, forearm, hand };
  }

  _makeLeg(mSuit, mDark, mArmor) {
    const group = new THREE.Group();
    const thigh = limbBox(0.14, 0.4, 0.16, mSuit);
    group.add(thigh);
    const shin = new THREE.Group();
    shin.position.y = -0.4;
    thigh.add(shin);
    shin.add(limbBox(0.12, 0.4, 0.13, mSuit));
    const knee = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.14), mArmor);
    knee.position.y = -0.02;
    shin.add(knee);
    const foot = new THREE.Group();
    foot.position.set(0, -0.4, 0);
    const footMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.25), mDark);
    footMesh.position.set(0, -0.03, 0.04);
    footMesh.castShadow = true;
    foot.add(footMesh);
    shin.add(foot);
    return { group, thigh, shin, foot };
  }

  setWeapon(def) {
    if (this.weapon) {
      this.weaponMount.remove(this.weapon.root);
      this.weapon.root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    }
    if (!def) { this.weapon = null; return; }
    this.weapon = buildWeaponModel(def);
    mergeRigid(this.weapon.root);
    this.weapon.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    // Seat the gun in the hand: grip at the palm, barrel level and forward.
    // These angles were solved against the shouldered arm pose — the mount
    // inherits the forearm's twist, so they are not a simple axis flip.
    this.weapon.root.position.set(-0.04, -0.02, -0.02);
    this.weapon.root.rotation.set(-0.289, -0.547, 0.361);
    this.weaponMount.add(this.weapon.root);
    this.weaponDef = def;
  }

  muzzleWorld(out = new THREE.Vector3()) {
    if (!this.weapon) return out.copy(this.root.position).setY(this.root.position.y + 1.5);
    this.weapon.parts.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.weapon.parts.muzzle.matrixWorld);
  }

  onFire() { this.recoilSpring.nudge(-9); }
  onHit(dir) { this.hitReact.nudge(rand(4, 9) * (dir > 0 ? 1 : -1)); }

  die(dirX, dirZ) {
    if (this.dead) return;
    this.dead = true;
    this.deathTime = 0;
    // Fall away from the shot, with a bit of spin so no two deaths match.
    this.deathTilt = Math.atan2(dirX, dirZ);
    this.deathSpin = rand(-0.7, 0.7);
    this.deathFall = rand(0.55, 0.9);
  }

  revive() {
    this.dead = false;
    this.deathTime = 0;
    this.root.rotation.set(0, this.root.rotation.y, 0);
    this.hips.position.y = this.hipsRest;
    this.hips.rotation.set(0, 0, 0);
  }

  setAiming(on) { this.aimTarget = on ? 1 : 0; }
  startReload(duration) { this.reloadTime = 0; this.reloadDuration = duration; }

  update(dt, opts = {}) {
    const { speed = 0, yaw = 0, aimPitch = 0, crouch = 0, grounded = true } = opts;

    if (this.dead) { this._updateDeath(dt); return; }

    this.speed = damp(this.speed, speed, 12, dt);
    this.crouchTarget = crouch;
    this.crouch = damp(this.crouch, this.crouchTarget, 11, dt);
    this.aimBlend = damp(this.aimBlend, this.aimTarget, 11, dt);
    this.hitReact.target = 0;
    this.hitReact.update(dt);
    this.recoilSpring.target = 0;
    this.recoilSpring.update(dt);
    this.breath += dt * 1.3;

    // Body faces movement/aim direction; the model itself is rotated by the owner.
    const gait = clamp01(this.speed / 6.2);
    const run = clamp01((this.speed - 3.4) / 3.5);
    const stride = 5.4 + run * 4.2;
    this._prevPhase = this.phase;
    if (grounded) this.phase += dt * stride * Math.max(0.15, gait);
    if (this.phase > TAU) {
      this.phase -= TAU;
      this._prevPhase -= TAU;
    }
    // Footstep events on the down-beats of the cycle.
    for (const [i, mark] of [[0, 0], [1, Math.PI]]) {
      if (this._prevPhase < mark && this.phase >= mark && gait > 0.15) this.onFootstep?.(i);
    }

    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const amp = gait;

    // --- legs ---
    this.legL.thigh.rotation.x = s * 0.72 * amp - this.crouch * 0.85;
    this.legR.thigh.rotation.x = -s * 0.72 * amp - this.crouch * 0.85;
    this.legL.shin.rotation.x = clamp(-Math.min(0, Math.sin(this.phase - 0.7)) * 1.25 * amp, 0, 1.5) + this.crouch * 1.5;
    this.legR.shin.rotation.x = clamp(-Math.min(0, Math.sin(this.phase + Math.PI - 0.7)) * 1.25 * amp, 0, 1.5) + this.crouch * 1.5;
    this.legL.foot.rotation.x = -this.legL.shin.rotation.x * 0.55 - this.legL.thigh.rotation.x * 0.25;
    this.legR.foot.rotation.x = -this.legR.shin.rotation.x * 0.55 - this.legR.thigh.rotation.x * 0.25;
    this.legL.group.rotation.z = 0.03;
    this.legR.group.rotation.z = -0.03;

    // --- hips: bob, sway and crouch drop ---
    const bob = -Math.abs(c) * 0.045 * amp;
    this.hips.position.y = this.hipsRest - this.crouch * 0.42 + bob + Math.sin(this.breath) * 0.006 * (1 - amp);
    this.hips.rotation.z = s * 0.05 * amp;
    this.hips.rotation.y = -s * 0.16 * amp;
    this.hips.rotation.x = this.crouch * 0.22 + run * 0.12;

    // --- spine counter-rotates against the hips (natural counter-sway) ---
    this.spine.rotation.y = s * 0.13 * amp;
    this.spine.rotation.x = -this.crouch * 0.1 + run * 0.1 + this.hitReact.value * 0.02;
    this.chest.rotation.z = -s * 0.04 * amp + this.hitReact.value * 0.015;

    // --- aim: chest pitches, head tracks ---
    const aim = this.aimBlend;
    this.chest.rotation.x = lerp(this.chest.rotation.x, -aimPitch * 0.45, 0.85);
    this.neck.rotation.x = dampAngle(this.neck.rotation.x, -aimPitch * 0.5, 16, dt);
    this.head.rotation.x = dampAngle(this.head.rotation.x, -aimPitch * 0.25, 14, dt);
    this.head.rotation.y = dampAngle(this.head.rotation.y, clamp(this.lookYaw, -0.9, 0.9), 10, dt);

    // --- arms: weapon-carry pose blended toward a shouldered aim ---
    // The joint angles below were solved so the trigger hand lands on the grip
    // and the support hand on the handguard; the limb pivots hang downward, so
    // a POSITIVE x rotation swings the arm forward.
    const recoil = this.recoilSpring.value * 0.01;
    const swayL = -s * 0.30 * amp * (1 - aim * 0.75);
    const swayR = s * 0.30 * amp * (1 - aim * 0.75);

    // Right arm holds the grip.
    this.armR.upper.rotation.x = lerp(1.34 + swayR, 1.60 - aimPitch * 0.35, aim) - recoil;
    this.armR.upper.rotation.y = lerp(-0.34, -0.50, aim);
    this.armR.upper.rotation.z = lerp(0.14, -0.05, aim);
    this.armR.forearm.rotation.x = lerp(-1.30, -1.35, aim) + recoil * 1.4;
    this.armR.forearm.rotation.y = lerp(0.33, 0.50, aim);

    // Left arm supports the handguard, reaching across the body.
    this.armL.upper.rotation.x = lerp(1.21 + swayL, 1.55 - aimPitch * 0.35, aim) - recoil * 0.6;
    this.armL.upper.rotation.y = lerp(0.90, 0.90, aim);
    this.armL.upper.rotation.z = lerp(0.05, 0.05, aim);
    this.armL.forearm.rotation.x = lerp(-0.83, -0.72, aim) + recoil;
    this.armL.forearm.rotation.y = lerp(0.21, -0.22, aim);

    // --- reload: right hand dips to the mag well, weapon tilts ---
    if (this.reloadTime >= 0) {
      this.reloadTime += dt;
      const t = clamp01(this.reloadTime / this.reloadDuration);
      const k = Math.sin(t * Math.PI);
      this.armL.upper.rotation.x -= k * 0.55;
      this.armL.upper.rotation.y -= k * 0.55;
      this.armL.forearm.rotation.x -= k * 0.45;
      this.armR.upper.rotation.z += k * 0.12;
      if (this.weapon) this.weapon.root.rotation.z = k * 0.5;
      if (t >= 1) { this.reloadTime = -1; if (this.weapon) this.weapon.root.rotation.z = 0; }
    }

    // Weapon-side hit flinch.
    this.chest.rotation.y = this.hitReact.value * 0.03;
  }

  _updateDeath(dt) {
    this.deathTime += dt;
    const t = clamp01(this.deathTime / 1.1);
    const e = 1 - Math.pow(1 - t, 3);
    // Collapse: hips drop, body rotates onto its back/side.
    this.hips.position.y = lerp(this.hipsRest, 0.22, e);
    this.hips.rotation.x = lerp(0, this.deathFall * 1.6, e);
    this.hips.rotation.z = lerp(0, this.deathSpin, e);
    this.spine.rotation.x = lerp(this.spine.rotation.x, 0.4, dt * 4);
    this.chest.rotation.x = lerp(this.chest.rotation.x, 0.3, dt * 4);
    this.neck.rotation.x = lerp(this.neck.rotation.x, 0.5, dt * 5);
    // Limbs go slack.
    for (const arm of [this.armL, this.armR]) {
      arm.upper.rotation.x = lerp(arm.upper.rotation.x, 0.15 + rand(-0.05, 0.05), dt * 4);
      arm.upper.rotation.y = lerp(arm.upper.rotation.y, 0, dt * 4);
      arm.upper.rotation.z = lerp(arm.upper.rotation.z, arm === this.armL ? -0.55 : 0.55, dt * 4);
      arm.forearm.rotation.x = lerp(arm.forearm.rotation.x, -0.3, dt * 4);
      arm.forearm.rotation.y = lerp(arm.forearm.rotation.y, 0, dt * 4);
    }
    for (const leg of [this.legL, this.legR]) {
      leg.thigh.rotation.x = lerp(leg.thigh.rotation.x, 0.9, dt * 4);
      leg.shin.rotation.x = lerp(leg.shin.rotation.x, 0.4, dt * 4);
    }

  }

  setDim(amount) {
    // Vertex colours are multiplied by the material colour, so one value dims
    // the whole character.
    if (this.skinnedMesh) this.skinnedMesh.material.color.setScalar(amount);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose?.(); }
    });
    for (const mat of this.materials) mat.dispose();
    if (this.weapon) this.weapon.root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
  }
}

export { TEAM_COLORS };
