// The bot.
//
// Decisions come from a utility layer: every tick a set of candidate actions is
// scored against the current situation (health, ammo, cover quality, squad role,
// contact age, objective pressure) and the best one wins, with hysteresis so
// bots commit instead of twitching between plans.
//
// Aim is modelled as a human would do it: a turn-rate-limited sweep onto the
// target, a slowly-drifting error that converges the longer the target is
// tracked, imperfect recoil compensation, and burst discipline by weapon class.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, dampAngle, shortAngle, rand, randInt, gauss, pick, TAU, Spring } from '../core/math.js';
import { BodyMover } from '../world/physics.js';
import { WEAPONS, fireInterval, GRENADES } from '../weapons/defs.js';
import { traceShot, applySpread, patternAt, HITZONE } from '../weapons/combat.js';
import { Character } from './character.js';
import { Perception } from './perception.js';
import { ROLE } from './blackboard.js';
import { audio } from '../core/audio.js';

export const DIFFICULTY = {
  recruit: { reaction: 0.62, aimError: 3.4, converge: 0.9, recoilSkill: 0.25, burstSkill: 0.3, tactics: 0.3, hp: 100, aggressionBias: -0.1 },
  regular: { reaction: 0.38, aimError: 2.1, converge: 1.5, recoilSkill: 0.5, burstSkill: 0.55, tactics: 0.55, hp: 100, aggressionBias: 0 },
  veteran: { reaction: 0.24, aimError: 1.25, converge: 2.4, recoilSkill: 0.72, burstSkill: 0.78, tactics: 0.78, hp: 100, aggressionBias: 0.08 },
  elite: { reaction: 0.15, aimError: 0.7, converge: 3.4, recoilSkill: 0.88, burstSkill: 0.92, tactics: 0.95, hp: 100, aggressionBias: 0.16 },
};

const NAMES = [
  'VIPER', 'ASH', 'KILO', 'RAVEN', 'ONYX', 'HOLLOW', 'SABLE', 'DRIFT', 'JUNO', 'CINDER',
  'TALON', 'MARROW', 'ECHO', 'VESPER', 'GRIT', 'NOMAD', 'HALO', 'RUST', 'SPECTRE', 'WARD',
  'BISHOP', 'CANDOR', 'DELTA', 'EMBER', 'FLINT', 'GLASS', 'HAVEN', 'IRIS',
];
let nameCursor = 0;

const ACTION = {
  IDLE: 'idle',
  ENGAGE: 'engage',
  PEEK: 'peek',
  TAKE_COVER: 'cover',
  FLANK: 'flank',
  ADVANCE: 'advance',
  RETREAT: 'retreat',
  SEARCH: 'search',
  INVESTIGATE: 'investigate',
  RELOAD: 'reload',
  GRENADE: 'grenade',
  OBJECTIVE: 'objective',
  HOLD: 'hold',
  REGROUP: 'regroup',
};

let agentIdCounter = 1;

export class Agent {
  constructor(game, team, opts = {}) {
    this.id = `bot${agentIdCounter++}`;
    this.game = game;
    this.world = game.collision;
    this.nav = game.nav;
    this.team = team;
    this.mover = new BodyMover(game.collision);
    this.isPlayer = false;
    this.isBot = true;

    const diffName = opts.difficulty || game.settings.difficulty || 'regular';
    this.difficulty = DIFFICULTY[diffName] || DIFFICULTY.regular;

    // Personality — every bot plays a bit differently within its skill band.
    this.profile = {
      aggression: clamp01(rand(0.25, 0.85) + this.difficulty.aggressionBias),
      patience: rand(0.2, 0.9),
      preferredRange: rand(8, 32),
      teamwork: rand(0.3, 1),
      jitter: rand(0.6, 1.4),          // strafe personality
      trigger: rand(0.85, 1.15),       // burst length personality
      peekStyle: pick(['wide', 'tight', 'jiggle']),
    };
    this.name = opts.name || NAMES[(nameCursor++) % NAMES.length];

    // Body
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.radius = 0.36;
    this.height = 1.78;
    this.standHeight = 1.78;
    this.crouchHeight = 1.16;
    this.eyeHeight = 1.66;
    this.yaw = rand(-Math.PI, Math.PI);
    this.pitch = 0;
    this.grounded = false;
    this.moveSpeed = 0;
    this.crouching = false;
    this.forward = new THREE.Vector3(0, 0, -1);

    // Stats
    this.alive = true;
    this.maxHealth = this.difficulty.hp;
    this.health = this.maxHealth;
    this.armor = 0;
    this.kills = 0; this.deaths = 0; this.assists = 0; this.score = 0;
    this.lastDamageTime = -99;
    this.lastAttacker = null;
    this.regenEnabled = true;
    this.regenDelay = 6;
    this.regenRate = 12;
    this.suppression = 0;

    // Weapons
    this.loadout = opts.loadout || ['kestrel', 'sidewinder', 'knife'];
    this.slotIndex = 0;
    this.def = WEAPONS[this.loadout[0]] || WEAPONS.kestrel;
    this.ammo = {};
    this.reserve = {};
    for (const id of this.loadout) {
      const d = WEAPONS[id];
      if (d) { this.ammo[id] = d.mag; this.reserve[id] = d.reserve; }
    }
    this.fireTimer = 0;
    this.sprayIndex = 0;
    this.reloading = false;
    this.reloadEnd = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.grenades = { frag: 1, flash: 1, smoke: 0 };
    this.grenadeCooldown = rand(6, 16);

    // Perception + memory
    this.perception = new Perception(this);
    this.target = null;
    this.targetTrackTime = 0;
    this.lastTargetSeen = -99;
    this.lastKnownTarget = null;
    this.aimSettle = 0;

    // Aim state
    this.aimYaw = this.yaw;
    this.aimPitch = 0;
    this.aimNoisePhase = rand(0, 100);
    this.recoilYaw = 0;
    this.recoilPitch = 0;

    // Navigation
    this.path = null;
    this.pathIndex = 0;
    this.pathGoal = null;
    this.repathTimer = 0;
    this.stuckTimer = 0;
    this.lastPos = new THREE.Vector3();
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;

    // Decision state
    this.action = ACTION.IDLE;
    this.actionTime = 0;
    this.decisionTimer = rand(0, 0.25);
    this.coverNode = null;
    this.peekPhase = 0;
    this.holdSpot = null;
    this.objective = null;      // set by the game mode
    this.objectivePriority = 0;
    this.searchPoints = [];
    this.wanderTarget = null;

    // Visuals
    this.character = new Character(team, opts.charOpts);
    this.character.setWeapon(this.def);
    this.character.onFootstep = () => this._footstep();
    game.render.scene.add(this.character.root);
    this.character.root.visible = true;

    this._tmp = new THREE.Vector3();
    this._dir = { x: 0, y: 0, z: 0 };
    this._delta = { x: 0, y: 0, z: 0 };
    this._muzzle = new THREE.Vector3();
    this._desiredMove = new THREE.Vector3();
  }

  get blackboard() { return this.game.blackboards[this.team]; }

  /* ------------------------------------------------------------ lifecycle -- */

  spawn(x, y, z, yaw = rand(-Math.PI, Math.PI)) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.pitch = this.aimPitch = 0;
    this.alive = true;
    this.health = this.maxHealth;
    this.suppression = 0;
    this.crouching = false;
    this.height = this.standHeight;
    this.reloading = false;
    this.fireTimer = 0;
    this.sprayIndex = 0;
    this.path = null;
    this.action = ACTION.IDLE;
    this.target = null;
    this.perception.reset();
    this.character.revive();
    this.character.root.visible = true;
    for (const id of this.loadout) {
      const d = WEAPONS[id];
      if (d) { this.ammo[id] = d.mag; this.reserve[id] = d.reserve; }
    }
    this._equip(0);
  }

  setLoadout(list) {
    this.loadout = list.slice();
    this.ammo = {}; this.reserve = {};
    for (const id of this.loadout) {
      const d = WEAPONS[id];
      if (d) { this.ammo[id] = d.mag; this.reserve[id] = d.reserve; }
    }
    this._equip(0);
  }

  _equip(index) {
    index = clamp(index, 0, this.loadout.length - 1);
    this.slotIndex = index;
    this.def = WEAPONS[this.loadout[index]] || WEAPONS.sidewinder;
    this.character.setWeapon(this.def);
    this.reloading = false;
    this.sprayIndex = 0;
    this.burstLeft = 0;
  }

  despawn() {
    this.blackboard?.releaseClaims(this.id);
    this.character.root.visible = false;
  }

  dispose() {
    this.game.render.scene.remove(this.character.root);
    this.character.dispose();
  }

  /* --------------------------------------------------------------- damage -- */

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
    this.lastAttacker = source;
    this.suppression = clamp01(this.suppression + 0.45);
    this.character.onHit(dir ? dir.x : 0);

    // Being shot from an unseen angle makes the bot spin toward the threat and
    // publish a contact — the same information a player gets from a hit marker.
    if (source && source.alive) {
      this.blackboard?.report(source, source.pos, this.game.time, 0.55, this.id, source.vel);
      const aw = this.perception.awareness.get(source.id) ?? 0;
      this.perception.awareness.set(source.id, Math.max(aw, 0.5));
      if (!this.perception.visible.has(source.id)) {
        this.lastKnownTarget = { x: source.pos.x, y: source.pos.y, z: source.pos.z, time: this.game.time };
        // Force a re-decision so it reacts now, not on the next scheduled tick.
        this.decisionTimer = 0;
      }
    }
    if (this.health <= 0) {
      this.health = 0;
      this.die(source, dir);
      return true;
    }
    return false;
  }

  die(source, dir) {
    this.alive = false;
    this.deaths++;
    this.vel.set(0, 0, 0);
    this.path = null;
    this.character.die(dir ? -dir.x : 0, dir ? -dir.z : 1);
    this.blackboard?.releaseClaims(this.id);
    this.blackboard?.releasePush(this.id);
    this.perception.reset();
  }

  heal(v) { this.health = Math.min(this.maxHealth, this.health + v); }

  /* ---------------------------------------------------------------- sense -- */

  _senseConfig() {
    const alert = this.perception.alertness;
    return {
      fov: lerp(0.95, 1.25, alert),     // half-angle, radians (~110°..143°)
      range: lerp(55, 85, alert),
      reaction: this.difficulty.reaction * lerp(1.35, 0.85, alert) * lerp(1.2, 0.85, this.profile.aggression),
      forget: 0.5,
    };
  }

  hearNoise(pos, loudness, kind) {
    if (!this.alive) return;
    this.perception.hear(pos, loudness, kind, this.game.time, this.world);
  }

  /* ------------------------------------------------------------- decision -- */

  _score(action, ctx) {
    const p = this.profile;
    const t = this.difficulty.tactics;
    const hpFrac = this.health / this.maxHealth;
    const ammoFrac = this.def.melee ? 1 : (this.ammo[this.def.id] ?? 0) / this.def.mag;
    const hasTarget = !!ctx.target;
    const targetDist = ctx.targetDist;
    const contactAge = ctx.contactAge;
    const role = this.blackboard ? this.blackboard.roleOf(this.id) : ROLE.SUPPORT;

    switch (action) {
      case ACTION.ENGAGE: {
        if (!hasTarget || ammoFrac <= 0) return -Infinity;
        let s = 5.5 + p.aggression * 2;
        // Fighting from cover is preferable; fighting in the open while hurt is not.
        s += ctx.inCover ? 1.3 : -0.4;
        s -= (1 - hpFrac) * 2.6 * (1 - p.aggression);
        // Range preference: bots with SMGs want to close, snipers want distance.
        const rangeFit = 1 - clamp01(Math.abs(targetDist - this._idealRange()) / 34);
        s += rangeFit * 2.2;
        if (this.suppression > 0.5) s -= this.suppression * 1.5 * (1 - t);
        return s;
      }
      case ACTION.PEEK: {
        if (!ctx.contact || ammoFrac <= 0) return -Infinity;
        if (ctx.canSeeTarget) return -Infinity;   // already engaging
        if (contactAge > 6) return -Infinity;
        let s = 3.4 + t * 1.6;
        s += ctx.inCover ? 1.5 : -1.0;
        s += p.aggression * 1.4;
        s -= (1 - hpFrac) * 1.8;
        if (role === ROLE.ANCHOR) s += 0.8;
        return s;
      }
      case ACTION.TAKE_COVER: {
        if (!ctx.contact) return -Infinity;
        let s = 2.0 + (1 - hpFrac) * 5.5;
        s += this.suppression * 3.0;
        s += ctx.inCover ? -3.2 : 1.8;   // already covered? don't re-cover
        s += (1 - p.aggression) * 1.4;
        if (ammoFrac < 0.15) s += 2.0;
        return s;
      }
      case ACTION.RETREAT: {
        if (!ctx.contact) return -Infinity;
        if (hpFrac > 0.32) return -Infinity;
        return 4.5 + (1 - hpFrac) * 6 + (1 - p.aggression) * 2 - t * 0.5;
      }
      case ACTION.FLANK: {
        if (!ctx.contact || contactAge > 8) return -Infinity;
        if (targetDist < 9) return -Infinity;
        let s = 1.4 + t * 2.4 + p.aggression * 1.6;
        if (role === ROLE.FLANK) s += 3.2;
        if (role === ROLE.LURK) s += 1.4;
        if (role === ROLE.ANCHOR) s -= 2.5;
        s -= (1 - hpFrac) * 2;
        // Don't flank if a squadmate already has the push token and is close.
        if (this.blackboard?.pushToken && this.blackboard.pushToken !== this.id) s += 0.8;
        return s;
      }
      case ACTION.ADVANCE: {
        if (!ctx.contact) return -Infinity;
        let s = 1.6 + p.aggression * 2.6 + t * 0.8;
        if (role === ROLE.ENTRY) s += 2.4;
        if (role === ROLE.ANCHOR) s -= 3;
        s -= (1 - hpFrac) * 3.2;
        s += clamp01((targetDist - this._idealRange()) / 25) * 2.0;
        if (ammoFrac < 0.25) s -= 2;
        return s;
      }
      case ACTION.SEARCH: {
        if (ctx.contact && contactAge < 3) return -Infinity;
        if (!this.lastKnownTarget && !ctx.noise) return -Infinity;
        return 2.4 + p.aggression * 1.2 + t * 0.6;
      }
      case ACTION.INVESTIGATE: {
        if (!ctx.noise) return -Infinity;
        if (hasTarget) return -Infinity;
        return 1.9 + ctx.noise.strength * 2.2 + p.aggression;
      }
      case ACTION.RELOAD: {
        if (this.def.melee) return -Infinity;
        if (ammoFrac > 0.34) return -Infinity;
        if ((this.reserve[this.def.id] ?? 0) <= 0) return -Infinity;
        let s = (1 - ammoFrac) * 6.5;
        if (ammoFrac === 0) s += 4;
        // Reloading with an enemy in your face is a losing play.
        if (ctx.canSeeTarget && targetDist < 18) s -= 5.5 * t;
        if (ctx.inCover) s += 2.2;
        return s;
      }
      case ACTION.GRENADE: {
        if (this.grenadeCooldown > 0) return -Infinity;
        if (!ctx.contact) return -Infinity;
        if (!this._hasGrenade()) return -Infinity;
        if (targetDist < 6 || targetDist > 26) return -Infinity;
        let s = 2.0 + t * 2.6;
        // Best used on someone holding an angle you can't push.
        if (!ctx.canSeeTarget && contactAge < 4) s += 2.2;
        if (ctx.inCover) s += 0.8;
        return s;
      }
      case ACTION.OBJECTIVE: {
        if (!this.objective) return -Infinity;
        let s = 2.2 + this.objectivePriority * 4.5;
        if (ctx.canSeeTarget && targetDist < 22) s -= 3.5 * (1 - p.aggression);
        s -= (1 - hpFrac) * 1.5;
        return s;
      }
      case ACTION.HOLD: {
        let s = 1.2 + p.patience * 1.6;
        if (role === ROLE.ANCHOR) s += 1.8;
        if (role === ROLE.LURK) s += 1.0;
        if (ctx.contact && contactAge < 4) s -= 1.5;
        if (ctx.inCover) s += 0.8;
        return s;
      }
      case ACTION.REGROUP: {
        if (!this.blackboard) return -Infinity;
        if (ctx.aliveAllies === 0) return -Infinity;
        if (ctx.nearestAllyDist < 14) return -Infinity;
        return 1.0 + (1 - hpFrac) * 2.0 + p.teamwork * 1.6;
      }
      default:
        return 0.5;
    }
  }

  _idealRange() {
    const cls = this.def.class;
    if (cls === 'Sniper') return 40;
    if (cls === 'Shotgun') return 6;
    if (cls === 'SMG') return 12;
    if (cls === 'LMG') return 26;
    if (cls === 'Pistol') return 14;
    return this.profile.preferredRange;
  }

  _hasGrenade() {
    return (this.grenades.frag ?? 0) > 0 || (this.grenades.flash ?? 0) > 0;
  }

  _decide(ctx) {
    const candidates = [
      ACTION.ENGAGE, ACTION.PEEK, ACTION.TAKE_COVER, ACTION.RETREAT, ACTION.FLANK,
      ACTION.ADVANCE, ACTION.SEARCH, ACTION.INVESTIGATE, ACTION.RELOAD,
      ACTION.GRENADE, ACTION.OBJECTIVE, ACTION.HOLD, ACTION.REGROUP,
    ];
    let best = ACTION.HOLD, bestScore = -Infinity;
    for (const a of candidates) {
      let s = this._score(a, ctx);
      if (!Number.isFinite(s)) continue;
      // Hysteresis: staying the course is worth something, so bots commit.
      if (a === this.action) s += 1.1 + Math.min(1.2, this.actionTime * 0.35);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    if (best !== this.action) {
      this._exitAction(this.action);
      this.action = best;
      this.actionTime = 0;
      this._enterAction(best, ctx);
    }
  }

  _exitAction(a) {
    if (a === ACTION.FLANK || a === ACTION.ADVANCE) this.blackboard?.releasePush(this.id);
  }

  _enterAction(a, ctx) {
    const bb = this.blackboard;
    switch (a) {
      case ACTION.TAKE_COVER: this._planCover(ctx, false); break;
      case ACTION.RETREAT: this._planCover(ctx, true); break;
      case ACTION.FLANK: this._planFlank(ctx); break;
      case ACTION.ADVANCE: this._planAdvance(ctx); break;
      case ACTION.SEARCH: this._planSearch(ctx); break;
      case ACTION.INVESTIGATE:
        if (ctx.noise) this._setGoal({ x: ctx.noise.x, y: ctx.noise.y, z: ctx.noise.z });
        break;
      case ACTION.RELOAD: this._startReload(); break;
      case ACTION.GRENADE: this._throwGrenade(ctx); break;
      case ACTION.OBJECTIVE:
        if (this.objective) this._setGoal(this.objective);
        break;
      case ACTION.HOLD: this._planHold(ctx); break;
      case ACTION.REGROUP: {
        const ally = ctx.nearestAlly;
        if (ally) this._setGoal({ x: ally.pos.x, y: ally.pos.y, z: ally.pos.z });
        break;
      }
      case ACTION.PEEK:
        this.peekPhase = 0;
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        break;
      default: break;
    }
  }

  /* ------------------------------------------------------------- planning -- */

  _threatPoints(ctx) {
    const out = [];
    if (ctx.target) out.push({ x: ctx.target.entity.pos.x, y: ctx.target.entity.pos.y + 1.6, z: ctx.target.entity.pos.z });
    else if (ctx.contact) out.push({ x: ctx.contact.x, y: ctx.contact.y + 1.6, z: ctx.contact.z });
    if (!out.length && this.lastKnownTarget) out.push({ x: this.lastKnownTarget.x, y: this.lastKnownTarget.y + 1.6, z: this.lastKnownTarget.z });
    return out;
  }

  _planCover(ctx, away) {
    const threats = this._threatPoints(ctx);
    if (!threats.length || !this.nav) { this._planHold(ctx); return; }
    const t = threats[0];
    const dx = this.pos.x - t.x, dz = this.pos.z - t.z;
    const l = Math.hypot(dx, dz) || 1;
    const res = this.nav.findCover(this.pos.x, this.pos.y, this.pos.z, threats, {
      searchRadius: away ? 26 : 15,
      minDist: away ? 6 : 1.2,
      preferForward: away ? { x: dx / l, z: dz / l } : null,
      requireLos: !away,
    });
    if (res && res.node) {
      this.coverNode = res.node;
      this._setGoal(res.node);
      this.blackboard?.claim(this.id, res.node.x, res.node.z);
    } else this._planHold(ctx);
  }

  _planFlank(ctx) {
    const threats = this._threatPoints(ctx);
    if (!threats.length || !this.nav) { this._planHold(ctx); return; }
    const t = threats[0];
    // Approach from a direction the target isn't already watching.
    const facing = ctx.target?.entity;
    const bias = facing
      ? { x: -Math.sin(facing.yaw ?? 0), z: -Math.cos(facing.yaw ?? 0) }
      : { x: (this.pos.x - t.x), z: (this.pos.z - t.z) };
    const bl = Math.hypot(bias.x, bias.z) || 1;
    bias.x /= bl; bias.z /= bl;
    const res = this.nav.findFiringPosition(this.pos.x, this.pos.y, this.pos.z, t, {
      searchRadius: 30, minDistToTarget: 7, maxDistToTarget: 45, flankBias: bias,
    });
    if (res && res.node && !this.blackboard?.isClaimed(this.id, res.node.x, res.node.z, 3)) {
      this._setGoal(res.node);
      this.blackboard?.claim(this.id, res.node.x, res.node.z, 3);
      this.blackboard?.requestPush(this.id, this.game.time);
    } else this._planAdvance(ctx);
  }

  _planAdvance(ctx) {
    const threats = this._threatPoints(ctx);
    if (!threats.length) { this._planWander(); return; }
    const t = threats[0];
    const ideal = this._idealRange();
    const dx = t.x - this.pos.x, dz = t.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // Aim for a point at the ideal engagement range along the approach line.
    const stopAt = clamp(d - ideal, 2, d - 2);
    const gx = this.pos.x + (dx / d) * stopAt;
    const gz = this.pos.z + (dz / d) * stopAt;
    if (this.nav) {
      const cover = this.nav.findCover(gx, this.pos.y, gz, threats, { searchRadius: 8, requireLos: true });
      if (cover?.node) { this._setGoal(cover.node); this.blackboard?.requestPush(this.id, this.game.time); return; }
    }
    this._setGoal({ x: gx, y: this.pos.y, z: gz });
    this.blackboard?.requestPush(this.id, this.game.time);
  }

  _planSearch(ctx) {
    const lk = this.lastKnownTarget || (ctx.contact ? { x: ctx.contact.x, y: ctx.contact.y, z: ctx.contact.z } : null);
    if (!lk) { this._planWander(); return; }
    // Search fans out from the last known position rather than walking to it
    // and standing there.
    if (!this.searchPoints.length) {
      const base = this.nav?.nearest(lk.x, lk.y, lk.z);
      if (base) {
        this.searchPoints.push({ x: base.x, y: base.y, z: base.z });
        for (let i = 0; i < 3; i++) {
          const a = rand(0, TAU);
          const r = rand(4, 11);
          const n = this.nav.nearest(base.x + Math.cos(a) * r, base.y, base.z + Math.sin(a) * r, 4);
          if (n) this.searchPoints.push({ x: n.x, y: n.y, z: n.z });
        }
      }
    }
    const next = this.searchPoints.shift();
    if (next) this._setGoal(next);
    else this._planWander();
  }

  _planHold(ctx) {
    const threats = this._threatPoints(ctx);
    if (threats.length && this.nav) {
      const res = this.nav.findCover(this.pos.x, this.pos.y, this.pos.z, threats, { searchRadius: 7, requireLos: true });
      if (res?.node) { this.holdSpot = res.node; this._setGoal(res.node); return; }
    }
    this.holdSpot = null;
    this.path = null;
    this.pathGoal = null;
  }

  _planWander() {
    if (!this.nav) return;
    const focus = this.blackboard?.objectiveFocus;
    let node = null;
    if (focus && Math.random() < 0.65) {
      const a = rand(0, TAU), r = rand(4, 16);
      node = this.nav.nearest(focus.x + Math.cos(a) * r, focus.y ?? this.pos.y, focus.z + Math.sin(a) * r, 6);
    }
    if (!node) node = this.nav.randomNode(this.pos, 12);
    if (node) this._setGoal(node);
  }

  _setGoal(point) {
    if (!point || !this.nav) return;
    this.pathGoal = { x: point.x, y: point.y ?? this.pos.y, z: point.z };
    this.repathTimer = 0;
    this._repath();
  }

  _repath() {
    if (!this.pathGoal || !this.nav) { this.path = null; return; }
    // Avoid pathing straight through a known enemy position.
    const bb = this.blackboard;
    const danger = bb ? [...bb.contacts.values()].filter((c) => this.game.time - c.lastSeen < 5) : [];
    const costFn = danger.length
      ? (node) => {
        let extra = 0;
        for (const c of danger) {
          const d2 = (node.x - c.x) ** 2 + (node.z - c.z) ** 2;
          if (d2 < 25) extra += (25 - d2) * 0.18 * (1 - this.profile.aggression);
        }
        return extra;
      }
      : null;
    const p = this.nav.findPath(this.pos, this.pathGoal, costFn);
    this.path = p && p.length ? p : null;
    this.pathIndex = 0;
    if (!this.path) {
      // Unreachable: fall back to a nearby reachable node so we don't freeze.
      const alt = this.nav.nearest(this.pathGoal.x, this.pathGoal.y, this.pathGoal.z, 10);
      if (alt) {
        const p2 = this.nav.findPath(this.pos, alt);
        if (p2 && p2.length) { this.path = p2; this.pathGoal = { x: alt.x, y: alt.y, z: alt.z }; }
      }
    }
  }

  /* -------------------------------------------------------------- combat -- */

  _startReload() {
    const d = this.def;
    if (this.reloading || d.melee) return;
    const have = this.ammo[d.id] ?? 0;
    const spare = this.reserve[d.id] ?? 0;
    if (have >= d.mag || spare <= 0) return;
    this.reloading = true;
    const time = have === 0 ? d.reloadEmptyTime : d.reloadTime;
    const total = d.shellReload ? Math.min(d.mag - have, spare) * d.reloadTime : time;
    this.reloadEnd = this.game.time + total;
    this.character.startReload(total);
    audio.mech(this.pos, 'magOut', 0.32);
  }

  _finishReload() {
    const d = this.def;
    const need = d.mag - (this.ammo[d.id] ?? 0);
    const take = Math.min(need, this.reserve[d.id] ?? 0);
    this.ammo[d.id] = (this.ammo[d.id] ?? 0) + take;
    this.reserve[d.id] = (this.reserve[d.id] ?? 0) - take;
    this.reloading = false;
    this.sprayIndex = 0;
    audio.mech(this.pos, 'magIn', 0.3);
  }

  _throwGrenade(ctx) {
    const type = (this.grenades.frag ?? 0) > 0 ? 'frag' : 'flash';
    if ((this.grenades[type] ?? 0) <= 0) return;
    const t = ctx.target ? ctx.target.entity.pos : (ctx.contact || this.lastKnownTarget);
    if (!t) return;
    this.grenades[type]--;
    this.grenadeCooldown = rand(14, 28);
    const g = GRENADES[type];
    const from = { x: this.pos.x, y: this.pos.y + 1.5, z: this.pos.z };
    // Ballistic-ish lead: aim above the target, scaled by distance.
    const dx = t.x - from.x, dz = t.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    const inaccuracy = (1 - this.difficulty.tactics) * 4;
    const aimX = dx / d + gauss(0, 0.05) * inaccuracy;
    const aimZ = dz / d + gauss(0, 0.05) * inaccuracy;
    const lift = clamp(d / 40, 0.15, 0.65);
    this.game.spawnGrenade({
      type, owner: this, fuse: g.fuse * rand(0.75, 1),
      pos: from,
      vel: { x: aimX * g.throwSpeed * 0.9, y: lift * g.throwSpeed, z: aimZ * g.throwSpeed * 0.9 },
    });
    this.blackboard?.say(this.id, `${type} out`, this.game.time, 'grenade');
  }

  /** Where the bot wants to point, including lead and error. */
  _computeAimTarget(target, dt) {
    const e = target.entity;
    const from = { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
    // Aim height: chest normally, head as skill rises and the target settles.
    const headBias = clamp01((this.difficulty.tactics - 0.35) * 1.4) * clamp01(this.aimSettle - 0.35);
    const aimY = e.pos.y + e.height * lerp(0.68, 0.92, headBias);

    let tx = e.pos.x, ty = aimY, tz = e.pos.z;

    // Lead the target by bullet travel time.
    const dist = Math.hypot(tx - from.x, ty - from.y, tz - from.z);
    const speed = this.def.muzzleVelocity ?? 700;
    const travel = dist / speed;
    const leadSkill = this.difficulty.tactics;
    if (e.vel) {
      tx += e.vel.x * travel * leadSkill;
      tz += e.vel.z * travel * leadSkill;
    }

    // Error model: a slow drift plus a convergence term that shrinks while the
    // bot tracks the same target, then a suppression penalty.
    this.aimNoisePhase += dt * 2.2;
    const settleFactor = 1 / (1 + this.aimSettle * this.difficulty.converge);
    const baseErr = this.difficulty.aimError * settleFactor;
    const suppressPenalty = 1 + this.suppression * 2.2 * (1 - this.difficulty.tactics);
    const movePenalty = 1 + clamp01(this.moveSpeed / 6) * 1.1;
    const errDeg = baseErr * suppressPenalty * movePenalty;
    const errRad = errDeg * Math.PI / 180;
    const driftX = Math.sin(this.aimNoisePhase * 1.7) * 0.5 + Math.sin(this.aimNoisePhase * 0.41) * 0.5;
    const driftY = Math.cos(this.aimNoisePhase * 1.3) * 0.5 + Math.cos(this.aimNoisePhase * 0.53) * 0.5;

    const dx = tx - from.x, dy = ty - from.y, dz = tz - from.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return {
      yaw: yaw + driftX * errRad,
      pitch: pitch + driftY * errRad,
      dist,
    };
  }

  _updateCombat(dt, ctx) {
    const d = this.def;
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.burstPause = Math.max(0, this.burstPause - dt);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);

    if (this.reloading && this.game.time >= this.reloadEnd) this._finishReload();

    // Recoil punch decays exactly like the player's.
    const rec = d.recoil?.recovery ?? 8;
    const decay = 1 - Math.exp(-rec * dt);
    this.recoilYaw -= this.recoilYaw * decay;
    this.recoilPitch -= this.recoilPitch * decay;

    const target = ctx.target;
    if (!target) {
      this.aimSettle = Math.max(0, this.aimSettle - dt * 1.6);
      this.targetTrackTime = 0;
      this.character.setAiming(false);
      return;
    }

    // Tracking the same target for longer tightens the aim.
    if (this.target !== target.entity) { this.aimSettle = 0; this.targetTrackTime = 0; }
    this.target = target.entity;
    this.targetTrackTime += dt;
    this.aimSettle = Math.min(3.5, this.aimSettle + dt);

    const aim = this._computeAimTarget(target, dt);

    // Turn-rate-limited aim. Big corrections start fast then ease in — a flick
    // followed by a micro-adjust, which is how people actually aim.
    const dyaw = shortAngle(this.aimYaw, aim.yaw);
    const dpitch = aim.pitch - this.aimPitch;
    const err = Math.hypot(dyaw, dpitch);
    const baseTurn = lerp(4.5, 13, this.difficulty.tactics);
    const turnRate = baseTurn * (0.45 + clamp01(err / 0.9) * 1.6);
    const maxStep = turnRate * dt;
    this.aimYaw += clamp(dyaw, -maxStep, maxStep);
    this.aimPitch = clamp(this.aimPitch + clamp(dpitch, -maxStep, maxStep), -1.3, 1.3);

    this.character.setAiming(true);

    // --- decide whether to pull the trigger ---
    const awareness = this.perception.awareness.get(target.entity.id) ?? 0;
    if (awareness < 0.98) return;
    if (this.reloading || this.fireTimer > 0 || this.burstPause > 0) return;
    if ((this.ammo[d.id] ?? 0) <= 0) { this._startReload(); return; }

    // Only fire once actually pointed at the target.
    const aimTolerance = lerp(0.09, 0.022, this.difficulty.tactics) * (1 + clamp01(aim.dist / 60));
    if (Math.abs(shortAngle(this.aimYaw, aim.yaw)) > aimTolerance) return;
    if (Math.abs(this.aimPitch - aim.pitch) > aimTolerance) return;

    // Don't shoot a teammate in the back.
    if (this._allyInLine(target.entity)) return;

    // Shotguns hold fire until the target is actually in range.
    if (d.class === 'Shotgun' && aim.dist > 16) return;
    if (d.class === 'Sniper' && aim.dist < 6 && Math.random() < 0.6) return;

    this._fire(target.entity, aim);
  }

  _allyInLine(target) {
    const from = { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
    const dx = target.pos.x - from.x, dy = (target.pos.y + 1) - from.y, dz = target.pos.z - from.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    for (const a of this.game.damageables) {
      if (a === this || !a.alive || a.team !== this.team) continue;
      const ax = a.pos.x - from.x, ay = (a.pos.y + a.height * 0.5) - from.y, az = a.pos.z - from.z;
      const t = ax * nx + ay * ny + az * nz;
      if (t <= 0.5 || t >= dist) continue;
      const px = ax - nx * t, py = ay - ny * t, pz = az - nz * t;
      if (Math.hypot(px, py, pz) < a.radius + 0.35) return true;
    }
    return false;
  }

  _fire(targetEntity, aim) {
    const d = this.def;
    this.fireTimer = fireInterval(d);
    this.ammo[d.id] = (this.ammo[d.id] ?? 0) - 1;

    // Burst discipline: length depends on weapon, range and skill.
    if (this.burstLeft <= 0) {
      const dist = aim.dist;
      let len;
      if (!d.auto) len = 1;
      else if (d.class === 'SMG') len = dist < 14 ? randInt(6, 14) : randInt(3, 6);
      else if (d.class === 'LMG') len = dist < 20 ? randInt(8, 16) : randInt(4, 8);
      else len = dist < 14 ? randInt(5, 10) : dist < 30 ? randInt(3, 6) : randInt(1, 3);
      // Low-skill bots hold the trigger longer than they should.
      len = Math.round(len * lerp(1.6, 1.0, this.difficulty.burstSkill) * this.profile.trigger);
      this.burstLeft = Math.max(1, len);
    }
    this.burstLeft--;
    if (this.burstLeft <= 0) {
      const pause = lerp(0.55, 0.16, this.difficulty.burstSkill) * rand(0.75, 1.35);
      this.burstPause = d.auto ? pause : Math.max(pause, fireInterval(d) * rand(1.1, 2.4));
      this.sprayIndex = 0;
    }

    // Firing direction: aim direction + recoil punch + spread.
    const yaw = this.aimYaw + this.recoilYaw;
    const pitch = clamp(this.aimPitch + this.recoilPitch, -1.4, 1.4);
    const fwd = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    };
    const right = { x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) };
    const up = {
      x: right.y * fwd.z - right.z * fwd.y,
      y: right.z * fwd.x - right.x * fwd.z,
      z: right.x * fwd.y - right.y * fwd.x,
    };

    const spreadMul = 1 + clamp01(this.moveSpeed / 6) * (d.spread.moveMul - 1) + this.suppression * 0.8;
    const spread = lerp(d.spread.hip, d.spread.ads, 0.85) * spreadMul;
    const pellets = d.pellets ?? 1;

    const origin = { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
    const muzzle = this.character.muzzleWorld(this._muzzle);
    for (let i = 0; i < pellets; i++) {
      applySpread(fwd, right, up, spread, 0, 0, this._dir);
      const res = traceShot({
        world: this.world, entities: this.game.damageables, origin,
        dir: this._dir, def: d, shooter: this, maxDist: 220,
        friendlyFire: this.game.friendlyFire,
      });
      if (d.tracerEvery && this.game.shotCounter % d.tracerEvery === 0) {
        this.game.effects.tracer(muzzle.x, muzzle.y, muzzle.z, this._dir.x, this._dir.y, this._dir.z, 250, 0.1);
      }
      if (res.wallHit) {
        const wh = res.wallHit;
        this.game.effects.impact(wh.point.x, wh.point.y, wh.point.z, wh.normal.x, wh.normal.y, wh.normal.z, wh.brush.surface, 1);
        audio.impact(wh.point, wh.brush.surface);
        // Near-miss crack for the player, and suppression for anyone nearby.
        this.game.reportNearMiss(origin, this._dir, res.endPoint, this);
      }
      for (const hit of res.hits) {
        this.game.effects.bloodSpray(hit.point.x, hit.point.y, hit.point.z, this._dir.x, this._dir.y, this._dir.z, 1);
        this.game.applyDamage(hit.entity, hit.damage, this, hit.zone, this._dir);
      }
    }
    this.game.shotCounter++;

    // Recoil punch, imperfectly compensated by skill.
    const [px, py] = patternAt(d, this.sprayIndex);
    const comp = this.difficulty.recoilSkill;
    this.recoilYaw += (px * d.recoil.horizontal * (1 - comp * 0.85)) * Math.PI / 180;
    this.recoilPitch += (py * d.recoil.vertical * (1 - comp * 0.9)) * Math.PI / 180;
    this.sprayIndex++;

    this.character.onFire();
    this.game.effects.muzzleWorld(muzzle.x, muzzle.y, muzzle.z, fwd.x, fwd.y, fwd.z, 1);
    audio.shot({ x: this.pos.x, y: this.pos.y + 1.5, z: this.pos.z }, d.sound || {});
    this.game.emitNoise(this.pos, d.suppressed ? 22 : 75, 'gunshot', this);

    if ((this.ammo[d.id] ?? 0) <= 0) this._startReload();
  }

  /* ------------------------------------------------------------ movement -- */

  _followPath(dt, ctx) {
    this._desiredMove.set(0, 0, 0);
    if (!this.path || this.pathIndex >= this.path.length) return false;

    const wp = this.path[this.pathIndex];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const arrive = this.pathIndex === this.path.length - 1 ? 0.55 : 0.9;
    if (dist < arrive) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) { this.path = null; return false; }
      return true;
    }
    this._desiredMove.set(dx / dist, 0, dz / dist);
    return true;
  }

  /** Keep out of squadmates' personal space so a squad doesn't merge into one blob. */
  _separation(out) {
    let sx = 0, sz = 0, n = 0;
    for (const a of this.game.agents) {
      if (a === this || !a.alive || a.team !== this.team) continue;
      const dx = this.pos.x - a.pos.x, dz = this.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 6.25 || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const w = (2.5 - d) / 2.5;
      sx += (dx / d) * w; sz += (dz / d) * w; n++;
    }
    if (n) { out.x += sx * 0.9; out.z += sz * 0.9; }
  }

  _updateMovement(dt, ctx) {
    const move = this._desiredMove;
    this._separation(move);

    // Combat strafing: bots that are engaging slide side to side instead of
    // standing still, and peekers oscillate around their cover edge.
    let strafing = false;
    if (this.action === ACTION.ENGAGE && ctx.target) {
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = rand(0.5, 1.5) / this.profile.jitter;
        this.strafeDir *= -1;
      }
      const t = ctx.target.entity;
      const tx = t.pos.x - this.pos.x, tz = t.pos.z - this.pos.z;
      const l = Math.hypot(tx, tz) || 1;
      const perpX = -tz / l, perpZ = tx / l;
      // Don't strafe out of cover if we're using it.
      const strafeAmt = ctx.inCover ? 0.35 : 0.9;
      move.x += perpX * this.strafeDir * strafeAmt;
      move.z += perpZ * this.strafeDir * strafeAmt;
      // Close the gap or back off toward the ideal range.
      const ideal = this._idealRange();
      const rangeErr = clamp((l - ideal) / 12, -1, 1);
      move.x += (tx / l) * rangeErr * 0.55;
      move.z += (tz / l) * rangeErr * 0.55;
      strafing = true;
    } else if (this.action === ACTION.PEEK && ctx.contact) {
      this.peekPhase += dt * (this.profile.peekStyle === 'jiggle' ? 3.6 : 1.5);
      const tx = ctx.contact.x - this.pos.x, tz = ctx.contact.z - this.pos.z;
      const l = Math.hypot(tx, tz) || 1;
      const perpX = -tz / l, perpZ = tx / l;
      const swing = Math.sin(this.peekPhase) * (this.profile.peekStyle === 'wide' ? 1 : 0.6);
      move.x += perpX * this.strafeDir * swing;
      move.z += perpZ * this.strafeDir * swing;
      strafing = true;
    }

    const len = Math.hypot(move.x, move.z);
    if (len > 1) { move.x /= len; move.z /= len; }

    // ---- speed selection ----
    const engaged = !!ctx.target;
    let speed;
    if (this.action === ACTION.RETREAT) speed = 8.1;
    else if (engaged) speed = 4.6;
    else if (this.action === ACTION.HOLD || this.action === ACTION.SEARCH) speed = 3.2;
    else if (ctx.contact && ctx.contactAge < 5) speed = 5.6;
    else speed = 7.4;
    if (this.crouching) speed = Math.min(speed, 2.9);

    // ---- crouch decision ----
    const wantCrouch =
      (this.action === ACTION.HOLD && engaged && this.profile.patience > 0.5) ||
      (ctx.inCover && this.suppression > 0.45) ||
      (this.action === ACTION.ENGAGE && ctx.inCover && ctx.targetDist > 20 && this.profile.patience > 0.6);
    this._applyCrouch(wantCrouch, dt);

    // ---- accelerate ----
    const accel = this.grounded ? 55 : 12;
    if (this.grounded) {
      const s = Math.hypot(this.vel.x, this.vel.z);
      if (s > 0.01) {
        const drop = Math.max(s, 3) * 10 * dt;
        const scale = Math.max(0, s - drop) / s;
        this.vel.x *= scale; this.vel.z *= scale;
      } else { this.vel.x = 0; this.vel.z = 0; }
    }
    if (len > 0.01) {
      const cur = this.vel.x * move.x + this.vel.z * move.z;
      const add = clamp(speed - cur, 0, accel * dt);
      this.vel.x += move.x * add;
      this.vel.z += move.z * add;
    }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && hs > speed) { const s = speed / hs; this.vel.x *= s; this.vel.z *= s; }

    this.vel.y -= 23 * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    this._delta.x = this.vel.x * dt;
    this._delta.y = this.vel.y * dt;
    this._delta.z = this.vel.z * dt;
    const res = this.mover.move(this.pos, this.radius, this.height, this._delta, 0.52, true);
    this.grounded = res.grounded;
    if (res.grounded && this.vel.y < 0) this.vel.y = 0;
    if (res.ceiling && this.vel.y > 0) this.vel.y = 0;
    if (res.groundSurface) this.groundSurface = res.groundSurface;
    this.moveSpeed = Math.hypot(this.vel.x, this.vel.z);

    // ---- stuck detection ----
    const moved = this.pos.distanceToSquared(this.lastPos);
    if (len > 0.2 && moved < 0.0004) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.7) {
        this.stuckTimer = 0;
        // Try a fresh path; if we're wedged, sidestep and jump.
        this._repath();
        this.vel.x += rand(-3, 3);
        this.vel.z += rand(-3, 3);
        if (this.grounded && Math.random() < 0.4) this.vel.y = 6;
      }
    } else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 0.5);
    this.lastPos.copy(this.pos);
  }

  _applyCrouch(want, dt) {
    if (want && !this.crouching) this.crouching = true;
    else if (!want && this.crouching) {
      if (this.mover.fits(this.pos.x, this.pos.y + 0.02, this.pos.z, this.radius, this.standHeight)) this.crouching = false;
    }
    const targetH = this.crouching ? this.crouchHeight : this.standHeight;
    const prev = this.height;
    this.height = damp(this.height, targetH, 12, dt);
    if (this.height > prev && !this.mover.fits(this.pos.x, this.pos.y + 0.02, this.pos.z, this.radius, this.height)) {
      this.height = prev;
      this.crouching = true;
    }
    this.eyeHeight = this.height * 0.93;
  }

  _footstep() {
    if (!this.alive || this.moveSpeed < 0.6) return;
    const vol = this.moveSpeed > 6 ? 0.42 : this.crouching ? 0.08 : 0.26;
    audio.step({ x: this.pos.x, y: this.pos.y, z: this.pos.z }, this.groundSurface || 'concrete', vol);
    this.game.emitNoise(this.pos, this.moveSpeed > 6 ? 26 : this.crouching ? 3 : 15, 'footstep', this);
  }

  /* --------------------------------------------------------------- update -- */

  update(dt) {
    if (!this.alive) {
      this.character.update(dt, {});
      this.character.root.position.copy(this.pos);
      return;
    }

    const time = this.game.time;
    this.forward.set(-Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw)).normalize();

    // ---- perception ----
    this.perception.update(dt, this.game.enemiesOf(this.team), this.world, time, this._senseConfig());

    // Publish everything we can see.
    for (const [id, v] of this.perception.visible) {
      const aw = this.perception.awareness.get(id) ?? 0;
      if (aw > 0.25) this.blackboard?.report(v.entity, v.entity.pos, time, aw, this.id, v.entity.vel);
    }

    // ---- build decision context ----
    const target = this.perception.primaryTarget();
    const contact = this.blackboard?.bestContact(time, 10) ?? null;
    if (target) {
      this.lastTargetSeen = time;
      this.lastKnownTarget = { x: target.entity.pos.x, y: target.entity.pos.y, z: target.entity.pos.z, time };
    }
    const threats = [];
    if (target) threats.push({ x: target.entity.pos.x, y: target.entity.pos.y + 1.6, z: target.entity.pos.z });
    else if (contact) threats.push({ x: contact.x, y: contact.y + 1.6, z: contact.z });

    let inCover = false;
    if (threats.length) {
      const t = threats[0];
      inCover = !this.world.lineOfSight(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z, t.x, t.y, t.z);
    }

    let nearestAlly = null, nearestAllyDist = Infinity, aliveAllies = 0;
    for (const a of this.game.agents) {
      if (a === this || a.team !== this.team) continue;
      if (!a.alive) continue;
      aliveAllies++;
      const d = Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z);
      if (d < nearestAllyDist) { nearestAllyDist = d; nearestAlly = a; }
    }

    const ctx = {
      target,
      contact,
      contactAge: contact ? time - contact.lastSeen : Infinity,
      canSeeTarget: !!target,
      targetDist: target ? target.dist : (contact ? Math.hypot(contact.x - this.pos.x, contact.z - this.pos.z) : Infinity),
      inCover,
      noise: this.perception.loudestNoise(time),
      nearestAlly, nearestAllyDist, aliveAllies,
    };

    // ---- decide ----
    this.decisionTimer -= dt;
    if (this.decisionTimer <= 0) {
      this.decisionTimer = rand(0.2, 0.42);
      this._decide(ctx);
    }
    this.actionTime += dt;

    // ---- act ----
    this._followPath(dt, ctx);
    // Re-path periodically so a moving objective or target stays tracked.
    this.repathTimer -= dt;
    if (this.repathTimer <= 0) {
      this.repathTimer = rand(0.6, 1.2);
      if (this.pathGoal) {
        const dg = Math.hypot(this.pathGoal.x - this.pos.x, this.pathGoal.z - this.pos.z);
        if (!this.path && dg > 1.2) this._repath();
      }
      // Chasing behaviours re-target the enemy's current position.
      if ((this.action === ACTION.ADVANCE || this.action === ACTION.FLANK) && ctx.contact) {
        const goalDrift = this.pathGoal ? Math.hypot(this.pathGoal.x - ctx.contact.x, this.pathGoal.z - ctx.contact.z) : Infinity;
        if (goalDrift > 12) this._enterAction(this.action, ctx);
      }
      if (this.action === ACTION.OBJECTIVE && this.objective) {
        const drift = this.pathGoal ? Math.hypot(this.pathGoal.x - this.objective.x, this.pathGoal.z - this.objective.z) : Infinity;
        if (drift > 3) this._setGoal(this.objective);
      }
      if (this.action === ACTION.HOLD && !this.path && !this.holdSpot && Math.random() < 0.35) this._planWander();
      if (this.action === ACTION.SEARCH && !this.path) this._planSearch(ctx);
    }

    this._updateMovement(dt, ctx);
    this._updateCombat(dt, ctx);

    // Face where we're aiming when engaged; otherwise face where we're going.
    if (target || (contact && ctx.contactAge < 3)) {
      this.yaw = dampAngle(this.yaw, this.aimYaw, 16, dt);
      this.pitch = damp(this.pitch, this.aimPitch, 16, dt);
    } else {
      const moveYaw = this.moveSpeed > 0.4 ? Math.atan2(-this.vel.x, -this.vel.z) : this.yaw;
      // Scan the environment while moving instead of staring straight ahead.
      const scan = Math.sin(time * 0.7 + this.aimNoisePhase) * 0.45 * this.profile.patience;
      this.yaw = dampAngle(this.yaw, moveYaw + scan, 5, dt);
      this.aimYaw = dampAngle(this.aimYaw, this.yaw, 5, dt);
      this.pitch = damp(this.pitch, 0, 4, dt);
      this.aimPitch = damp(this.aimPitch, 0, 4, dt);
    }

    // ---- decay ----
    this.suppression = Math.max(0, this.suppression - dt * 0.55);
    if (this.regenEnabled && this.health < this.maxHealth && time - this.lastDamageTime > this.regenDelay) {
      this.health = Math.min(this.maxHealth, this.health + this.regenRate * dt);
    }

    // ---- visuals ----
    this.character.root.position.copy(this.pos);
    this.character.root.rotation.y = this.yaw;
    this.character.lookYaw = shortAngle(this.yaw, this.aimYaw);
    this.character.update(dt, {
      speed: this.moveSpeed,
      aimPitch: this.pitch,
      crouch: clamp01((this.standHeight - this.height) / (this.standHeight - this.crouchHeight)),
      grounded: this.grounded,
    });
  }
}

export { ACTION };
