// Team blackboard: the shared memory that makes a squad behave like a squad.
//
// Agents publish contacts and intentions here; the coordinator hands out roles,
// spatial claims and push permissions so bots take angles instead of queuing up
// in the same doorway.

import { clamp, clamp01, rand } from '../core/math.js';

export const ROLE = {
  ANCHOR: 'anchor',       // holds an angle, doesn't push
  ENTRY: 'entry',         // takes the first duel
  SUPPORT: 'support',     // trades off the entry, plays second contact
  FLANK: 'flank',         // takes a wide angle
  LURK: 'lurk',           // watches the off-angle / rotation path
};

export class Blackboard {
  constructor(team) {
    this.team = team;
    this.contacts = new Map();   // enemyId -> contact record
    this.claims = new Map();     // "x,z" cell key -> agentId
    this.roles = new Map();      // agentId -> ROLE
    this.pushToken = null;       // agentId currently allowed to make the entry
    this.pushTokenUntil = 0;
    this.suppressors = new Set();
    this.objectiveFocus = null;  // mode-supplied point of interest
    this.threatLevel = 0;        // 0..1 rolling estimate of pressure
    this.lastRoleShuffle = -99;
    this.deadAllies = 0;
    this.callouts = [];
  }

  /** Record or refresh a contact. `confidence` 1 = seen right now. */
  report(enemy, pos, time, confidence, reporterId, velocity = null) {
    let c = this.contacts.get(enemy.id);
    if (!c) {
      c = { enemy, x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, lastSeen: time, firstSeen: time, confidence: 0, reporters: new Set(), engaged: 0 };
      this.contacts.set(enemy.id, c);
    }
    if (confidence >= c.confidence || time - c.lastSeen > 0.4) {
      c.x = pos.x; c.y = pos.y; c.z = pos.z;
      if (velocity) { c.vx = velocity.x; c.vy = velocity.y; c.vz = velocity.z; }
    }
    c.lastSeen = Math.max(c.lastSeen, time);
    c.confidence = Math.max(c.confidence, confidence);
    c.reporters.add(reporterId);
  }

  /** Age out stale knowledge. Contacts decay rather than vanishing instantly. */
  update(dt, time) {
    for (const [id, c] of this.contacts) {
      const age = time - c.lastSeen;
      c.confidence = clamp01(c.confidence - dt * 0.22);
      if (!c.enemy.alive || age > 22 || c.confidence <= 0.01) this.contacts.delete(id);
      else if (age > 0.35) {
        // Dead reckoning: assume they kept moving for a moment, then stop.
        const drift = Math.max(0, 1 - age * 0.7);
        c.x += c.vx * dt * drift;
        c.z += c.vz * dt * drift;
      }
    }
    const fresh = [...this.contacts.values()].filter((c) => time - c.lastSeen < 4).length;
    this.threatLevel = clamp01(this.threatLevel + (fresh > 0 ? dt * 0.5 : -dt * 0.25));
    if (this.pushToken && time > this.pushTokenUntil) this.pushToken = null;
    this.callouts = this.callouts.filter((c) => time - c.time < 6);
  }

  bestContact(time, maxAge = 8) {
    let best = null;
    for (const c of this.contacts.values()) {
      const age = time - c.lastSeen;
      if (age > maxAge) continue;
      const score = c.confidence * 2 - age * 0.1;
      if (!best || score > best.score) best = { contact: c, score, age };
    }
    return best ? best.contact : null;
  }

  nearestContact(x, z, time, maxAge = 10) {
    let best = null, bestD = Infinity;
    for (const c of this.contacts.values()) {
      if (time - c.lastSeen > maxAge) continue;
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Claim a spot so two bots don't path onto the same tile. */
  claim(agentId, x, z, radius = 2.2) {
    const key = `${Math.round(x / radius)},${Math.round(z / radius)}`;
    const owner = this.claims.get(key);
    if (owner && owner !== agentId) return false;
    this.claims.set(key, agentId);
    return true;
  }

  isClaimed(agentId, x, z, radius = 2.2) {
    const key = `${Math.round(x / radius)},${Math.round(z / radius)}`;
    const owner = this.claims.get(key);
    return owner !== undefined && owner !== agentId;
  }

  releaseClaims(agentId) {
    for (const [k, v] of this.claims) if (v === agentId) this.claims.delete(k);
  }

  /** Only one bot at a time gets to be the one who swings first. */
  requestPush(agentId, time, duration = 3.5) {
    if (this.pushToken === agentId) { this.pushTokenUntil = time + duration; return true; }
    if (this.pushToken === null) {
      this.pushToken = agentId;
      this.pushTokenUntil = time + duration;
      return true;
    }
    return false;
  }

  releasePush(agentId) { if (this.pushToken === agentId) this.pushToken = null; }

  say(agentId, text, time, kind = 'info') {
    this.callouts.push({ agentId, text, time, kind });
    if (this.callouts.length > 12) this.callouts.shift();
  }

  /**
   * Re-assign roles across the living squad. Called periodically, not per frame.
   * Roles are handed out by position relative to the objective/threat so the
   * squad naturally spreads into entry / support / flank instead of clumping.
   */
  assignRoles(agents, time, focus) {
    if (time - this.lastRoleShuffle < 4) return;
    this.lastRoleShuffle = time;
    const living = agents.filter((a) => a.alive);
    if (!living.length) return;

    const target = focus || this.objectiveFocus || (this.bestContact(time) ?? null);
    if (!target) {
      for (const a of living) this.roles.set(a.id, ROLE.ANCHOR);
      return;
    }

    // Sort by distance to the point of interest.
    const scored = living.map((a) => ({
      a,
      d: Math.hypot(a.pos.x - target.x, a.pos.z - target.z),
      aggression: a.profile.aggression,
    })).sort((p, q) => p.d - q.d);

    const n = scored.length;
    for (let i = 0; i < n; i++) {
      const { a, aggression } = scored[i];
      let role;
      if (i === 0) role = aggression > 0.45 ? ROLE.ENTRY : ROLE.SUPPORT;
      else if (i === 1) role = ROLE.SUPPORT;
      else if (i === n - 1 && n > 3) role = ROLE.LURK;
      else role = aggression > 0.62 ? ROLE.FLANK : ROLE.ANCHOR;
      this.roles.set(a.id, role);
    }
  }

  roleOf(agentId) { return this.roles.get(agentId) || ROLE.SUPPORT; }

  reset() {
    this.contacts.clear();
    this.claims.clear();
    this.roles.clear();
    this.pushToken = null;
    this.threatLevel = 0;
    this.callouts.length = 0;
  }
}
