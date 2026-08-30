// Per-agent perception: vision cone, line of sight, hearing, and an awareness
// build-up so bots don't snap onto a target the instant it becomes visible.

import { clamp, clamp01, lerp } from '../core/math.js';

export class Perception {
  constructor(agent) {
    this.agent = agent;
    this.awareness = new Map();   // enemyId -> 0..1
    this.visible = new Map();     // enemyId -> { entity, dist, dot, point }
    this.heard = [];              // recent noise events
    this.lastLosCheck = new Map();
    this.checkCursor = 0;
    this.alertness = 0;           // rises with contact, decays in quiet
  }

  /**
   * @param {object} cfg
   *   fov       cone half-angle in radians
   *   range     max sight distance
   *   reaction  seconds to go from spotting to full awareness (centre of view)
   */
  update(dt, enemies, world, time, cfg) {
    const a = this.agent;
    const eye = { x: a.pos.x, y: a.pos.y + a.eyeHeight, z: a.pos.z };
    const fwd = a.forward;
    this.visible.clear();

    // Spread LOS raycasts across frames: at most 3 targets per tick.
    const perTick = Math.min(enemies.length, 3);
    for (let k = 0; k < enemies.length; k++) {
      const e = enemies[k];
      if (!e.alive) { this.awareness.delete(e.id); continue; }

      const dx = e.pos.x - eye.x;
      const dy = (e.pos.y + e.height * 0.75) - eye.y;
      const dz = e.pos.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > cfg.range) { this._decay(e, dt); continue; }

      const inv = 1 / (dist || 1);
      const dot = (dx * inv) * fwd.x + (dy * inv) * fwd.y + (dz * inv) * fwd.z;
      const angle = Math.acos(clamp(dot, -1, 1));

      // Peripheral vision: a wider, less reliable cone outside the focus cone.
      const inFocus = angle < cfg.fov;
      const inPeriph = angle < cfg.fov * 1.55;
      if (!inFocus && !inPeriph) { this._decay(e, dt); continue; }

      // Only re-check LOS every ~90ms per target, staggered.
      const last = this.lastLosCheck.get(e.id) ?? -99;
      let los = this._losCache?.get(e.id) ?? false;
      if (time - last > 0.09) {
        los = this._checkLos(world, eye, e);
        this.lastLosCheck.set(e.id, time);
        if (!this._losCache) this._losCache = new Map();
        this._losCache.set(e.id, los);
      }
      if (!los) { this._decay(e, dt); continue; }

      this.visible.set(e.id, { entity: e, dist, dot, angle, focus: inFocus });

      // Awareness rate: fastest dead-centre and close; slower at the edges,
      // at range, against a crouching or slow-moving target.
      const centreFactor = lerp(0.28, 1, clamp01((dot - Math.cos(cfg.fov * 1.55)) / (1 - Math.cos(cfg.fov * 1.55) + 1e-6)));
      const distFactor = lerp(1, 0.35, clamp01(dist / cfg.range));
      const motion = e.moveSpeed !== undefined ? clamp01(e.moveSpeed / 5) : 0.5;
      const motionFactor = lerp(0.65, 1.25, motion);
      const stanceFactor = e.crouching ? 0.72 : 1;
      const rate = (1 / Math.max(0.05, cfg.reaction)) * centreFactor * distFactor * motionFactor * stanceFactor;
      const cur = this.awareness.get(e.id) ?? 0;
      this.awareness.set(e.id, clamp01(cur + rate * dt));
      this.alertness = clamp01(this.alertness + dt * 1.5);
    }

    // Decay everything not seen this frame.
    for (const [id, v] of this.awareness) {
      if (!this.visible.has(id)) this.awareness.set(id, clamp01(v - dt * cfg.forget));
    }
    this.alertness = clamp01(this.alertness - dt * 0.12);
    this.heard = this.heard.filter((h) => time - h.time < 6);
  }

  _decay(e, dt) {
    const cur = this.awareness.get(e.id);
    if (cur !== undefined) this.awareness.set(e.id, clamp01(cur - dt * 0.7));
  }

  /** Try the chest first, then head and feet — mirrors what a player can shoot. */
  _checkLos(world, eye, e) {
    const targets = [
      [e.pos.x, e.pos.y + e.height * 0.72, e.pos.z],
      [e.pos.x, e.pos.y + e.height * 0.95, e.pos.z],
      [e.pos.x, e.pos.y + e.height * 0.35, e.pos.z],
    ];
    for (const [tx, ty, tz] of targets) {
      if (world.lineOfSight(eye.x, eye.y, eye.z, tx, ty, tz)) return true;
    }
    return false;
  }

  /** A noise the agent can hear. Loudness falls off with distance and walls. */
  hear(pos, loudness, kind, time, world) {
    const a = this.agent;
    const d = Math.hypot(pos.x - a.pos.x, pos.z - a.pos.z);
    if (d > loudness) return false;
    const muffled = world.lineOfSight(a.pos.x, a.pos.y + a.eyeHeight, a.pos.z, pos.x, pos.y + 1.2, pos.z) ? 1 : 0.55;
    const strength = (1 - d / loudness) * muffled;
    if (strength < 0.12) return false;
    // Hearing gives a direction, not a pinpoint — accuracy scales with loudness.
    const err = (1 - strength) * 5.5;
    this.heard.push({
      x: pos.x + (Math.random() - 0.5) * err,
      y: pos.y,
      z: pos.z + (Math.random() - 0.5) * err,
      strength, kind, time,
    });
    if (this.heard.length > 8) this.heard.shift();
    this.alertness = clamp01(this.alertness + strength * 0.6);
    return true;
  }

  loudestNoise(time, maxAge = 4) {
    let best = null;
    for (const h of this.heard) {
      if (time - h.time > maxAge) continue;
      const score = h.strength - (time - h.time) * 0.1;
      if (!best || score > best.score) best = { ...h, score };
    }
    return best;
  }

  /** The enemy this agent is most confident about right now. */
  primaryTarget() {
    let best = null, bestScore = -1;
    for (const [id, v] of this.visible) {
      const aw = this.awareness.get(id) ?? 0;
      if (aw < 0.15) continue;
      // Prefer close, centred, low-health targets.
      const hp = v.entity.health !== undefined ? clamp01(1 - v.entity.health / 100) : 0;
      const score = aw * 2 + (1 - clamp01(v.dist / 60)) * 1.2 + v.dot * 0.6 + hp * 0.8;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  reset() {
    this.awareness.clear();
    this.visible.clear();
    this.heard.length = 0;
    this.lastLosCheck.clear();
    this._losCache?.clear();
    this.alertness = 0;
  }
}
