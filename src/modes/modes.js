// Game modes.
//
// A mode owns win conditions, respawn rules, round flow and — importantly —
// what the AI is trying to do. Each mode publishes objectives onto agents and
// their team blackboard, so the same tactical brain plays bomb defusal, zone
// control or wave survival without any mode-specific AI code.

import { clamp, clamp01, lerp, rand, pick, shuffle } from '../core/math.js';
import { WEAPONS, PRIMARIES, SECONDARIES, GUNGAME_LADDER } from '../weapons/defs.js';
import { audio } from '../core/audio.js';

export class GameMode {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.id = 'base';
    this.name = 'MODE';
    this.teamBased = true;
    this.friendlyFire = false;
    this.respawn = true;
    this.respawnDelay = 4.0;
    this.regen = true;
    this.scores = [0, 0];
    this.timeLimit = 600;
    this.timeLeft = 600;
    this.scoreLimit = 75;
    this.over = false;
    this.winner = -1;
    this.roundActive = true;
    this.message = null;
    this.messageUntil = 0;
    this.events = [];
  }

  init() {}
  update(dt) {
    if (this.over) return;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.finish(this.scores[0] === this.scores[1] ? -1 : (this.scores[0] > this.scores[1] ? 0 : 1)); }
  }
  onKill() {}
  onDamage() {}
  onSpawn() {}
  onRoundReset() {}

  /** Where should this agent be trying to go? Modes override. */
  assignObjectives() {}

  finish(winner) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.game.onMatchEnd(winner);
  }

  announce(text, seconds = 3, kind = 'info') {
    this.message = { text, kind };
    this.messageUntil = this.game.time + seconds;
    this.game.hud.banner(text, seconds, kind);
  }

  hudState() {
    return {
      mode: this.name,
      scores: this.scores,
      scoreLimit: this.scoreLimit,
      timeLeft: this.timeLeft,
      teamBased: this.teamBased,
    };
  }

  /** Default: pick the spawn furthest from the nearest enemy. */
  pickSpawn(entity) {
    const map = this.game.mapBuilder;
    const key = this.teamBased ? entity.team : 'ffa';
    let points = map.spawnPoints[key];
    if (!points || !points.length) points = map.spawnPoints.ffa;
    if (!points || !points.length) return { x: 0, y: 2, z: 0, yaw: 0 };

    const enemies = this.game.damageables.filter((e) => e.alive && e !== entity && (!this.teamBased || e.team !== entity.team));
    let best = points[0], bestScore = -Infinity;
    for (const p of points) {
      let score = rand(0, 3);   // jitter so spawns don't become deterministic
      let nearest = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
        if (d < nearest) nearest = d;
        // Spawning in someone's line of sight is the worst outcome.
        if (d < 30 && this.game.collision.lineOfSight(p.x, p.y + 1.6, p.z, e.pos.x, e.pos.y + 1.6, e.pos.z)) score -= 22;
      }
      score += Math.min(nearest, 45) * 0.35;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }
}

/* ------------------------------------------------------------ deathmatch -- */

export class TeamDeathmatch extends GameMode {
  constructor(game, opts) {
    super(game, opts);
    this.id = 'deathmatch';
    this.name = 'TEAM DEATHMATCH';
    this.scoreLimit = opts.scoreLimit ?? 50;
    this.timeLimit = opts.timeLimit ?? 600;
    this.timeLeft = this.timeLimit;
    this.respawnDelay = 4.0;
  }

  onKill(victim, killer) {
    if (!killer || killer === victim) {
      if (victim) this.scores[1 - victim.team] += 0;   // suicide: no reward
      return;
    }
    if (killer.team === victim.team) { this.scores[killer.team] = Math.max(0, this.scores[killer.team] - 1); return; }
    this.scores[killer.team]++;
    if (this.scores[killer.team] >= this.scoreLimit) this.finish(killer.team);
  }

  assignObjectives() {
    // No fixed objective: bots fight over the map's contested centre so the
    // action stays concentrated instead of degenerating into spawn hunting.
    const focus = this.game.mapBuilder.markers.mid || this.game.mapBuilder.markers.hq || this.game.mapBuilder.markers.atrium;
    for (const bb of this.game.blackboards) {
      bb.objectiveFocus = focus ? { ...focus } : null;
    }
    for (const a of this.game.agents) {
      if (a.isPlayer) continue;
      a.objective = null;
      a.objectivePriority = 0;
    }
  }
}

/* ------------------------------------------------------------- domination -- */

export class Domination extends GameMode {
  constructor(game, opts) {
    super(game, opts);
    this.id = 'domination';
    this.name = 'DOMINATION';
    this.scoreLimit = opts.scoreLimit ?? 250;
    this.timeLimit = opts.timeLimit ?? 720;
    this.timeLeft = this.timeLimit;
    this.respawnDelay = 5.0;
    this.zones = [];
    this.tickAccum = 0;
  }

  init() {
    const src = this.game.mapBuilder.zones.length ? this.game.mapBuilder.zones : this.game.mapBuilder.sites;
    this.zones = src.slice(0, 3).map((z, i) => ({
      id: z.id || String.fromCharCode(65 + i),
      label: z.label || z.id,
      x: z.x, y: z.y, z: z.z, radius: z.radius ?? 6,
      owner: -1,
      progress: 0,        // -1 .. 1, sign is the capturing team
      contested: false,
      presence: [0, 0],
    }));
    if (!this.zones.length) {
      // Fall back to three points spread across the nav graph.
      const nav = this.game.nav;
      for (let i = 0; i < 3; i++) {
        const n = nav.randomNode(null, 0);
        if (n) this.zones.push({ id: String.fromCharCode(65 + i), label: `POINT ${String.fromCharCode(65 + i)}`, x: n.x, y: n.y, z: n.z, radius: 6, owner: -1, progress: 0, contested: false, presence: [0, 0] });
      }
    }
  }

  update(dt) {
    super.update(dt);
    if (this.over) return;

    for (const zone of this.zones) {
      zone.presence[0] = 0;
      zone.presence[1] = 0;
      for (const e of this.game.damageables) {
        if (!e.alive) continue;
        const d = Math.hypot(e.pos.x - zone.x, e.pos.z - zone.z);
        const dy = Math.abs(e.pos.y - zone.y);
        if (d <= zone.radius && dy < 4) zone.presence[e.team]++;
      }
      const [a, bTeam] = zone.presence;
      zone.contested = a > 0 && bTeam > 0;
      if (zone.contested) continue;

      const capper = a > 0 ? 0 : bTeam > 0 ? 1 : -1;
      if (capper === -1) continue;
      const rate = (0.34 + Math.min(zone.presence[capper] - 1, 2) * 0.13) * dt;
      const dir = capper === 0 ? 1 : -1;
      const before = zone.owner;
      zone.progress = clamp(zone.progress + dir * rate, -1, 1);
      if (zone.progress >= 1 && zone.owner !== 0) { zone.owner = 0; this._captured(zone, 0, before); }
      else if (zone.progress <= -1 && zone.owner !== 1) { zone.owner = 1; this._captured(zone, 1, before); }
      else if (zone.owner !== -1 && zone.owner !== capper && Math.abs(zone.progress) < 0.98) zone.owner = -1;
    }

    // Ticket bleed: score accrues per held zone.
    this.tickAccum += dt;
    if (this.tickAccum >= 1) {
      this.tickAccum -= 1;
      for (const t of [0, 1]) {
        const held = this.zones.filter((z) => z.owner === t).length;
        if (held > 0) this.scores[t] += held;
      }
      for (const t of [0, 1]) if (this.scores[t] >= this.scoreLimit) return this.finish(t);
    }
  }

  _captured(zone, team, before) {
    const label = zone.label || zone.id;
    this.announce(`${team === this.game.player.team ? 'CAPTURED' : 'LOST'} — ${label}`, 2.5, team === this.game.player.team ? 'good' : 'bad');
    audio.ui('objective');
  }

  assignObjectives() {
    // Each bot is pushed toward the zone that most needs its attention:
    // contested ones first, then enemy-held, then defending what's ours.
    for (const team of [0, 1]) {
      const bots = this.game.agents.filter((a) => a.alive && !a.isPlayer && a.team === team);
      if (!bots.length) continue;
      const scored = this.zones.map((z) => {
        let want = 1;
        if (z.contested) want = 3.2;
        else if (z.owner === -1) want = 2.4;
        else if (z.owner !== team) want = 2.0;
        else want = 0.9;                       // hold what we have, lightly
        return { zone: z, want };
      });
      const held = this.zones.filter((z) => z.owner === team).length;
      if (held >= 2) for (const s of scored) if (s.zone.owner === team) s.want += 0.9;

      // Assign the nearest bot to each zone in priority order, then spread the rest.
      const pool = bots.slice();
      scored.sort((a, b) => b.want - a.want);
      const bb = this.game.blackboards[team];
      bb.objectiveFocus = scored[0] ? { x: scored[0].zone.x, y: scored[0].zone.y, z: scored[0].zone.z } : null;
      for (const s of scored) {
        if (!pool.length) break;
        pool.sort((p, q) => (
          Math.hypot(p.pos.x - s.zone.x, p.pos.z - s.zone.z) - Math.hypot(q.pos.x - s.zone.x, q.pos.z - s.zone.z)
        ));
        const count = Math.max(1, Math.round(pool.length * (s.want / 6)));
        for (let i = 0; i < count && pool.length; i++) {
          const bot = pool.shift();
          bot.objective = { x: s.zone.x, y: s.zone.y, z: s.zone.z };
          bot.objectivePriority = clamp01(s.want / 3.4);
        }
      }
      for (const bot of pool) {
        const z = pick(this.zones);
        bot.objective = { x: z.x, y: z.y, z: z.z };
        bot.objectivePriority = 0.4;
      }
    }
  }

  hudState() {
    return { ...super.hudState(), zones: this.zones };
  }
}

/* --------------------------------------------------------------- detonate -- */

const PHASE = { BUY: 'buy', LIVE: 'live', PLANTED: 'planted', ENDED: 'ended' };

export class Detonate extends GameMode {
  constructor(game, opts) {
    super(game, opts);
    this.id = 'detonate';
    this.name = 'DETONATE';
    this.respawn = false;
    this.regen = false;
    this.roundsToWin = opts.roundsToWin ?? 7;
    this.scoreLimit = this.roundsToWin;
    this.timeLimit = Infinity;
    this.timeLeft = Infinity;
    this.round = 0;
    this.phase = PHASE.BUY;
    this.phaseTime = 0;
    this.buyTime = 12;
    this.roundTime = 100;
    this.plantTime = 4.0;
    this.defuseTime = 7.0;
    this.spikeTimer = 40;
    this.attackTeam = 0;
    this.sites = [];
    this.spike = { carrier: null, planted: false, x: 0, y: 0, z: 0, site: null, dropped: false };
    this.plantProgress = 0;
    this.defuseProgress = 0;
    this.defuser = null;
    this.targetSite = null;
  }

  init() {
    this.sites = this.game.mapBuilder.sites.map((s) => ({ ...s }));
    if (!this.sites.length) this.sites = [{ id: 'A', x: 0, y: 0, z: 0, radius: 6 }];
    this.startRound(true);
  }

  startRound(first = false) {
    this.round++;
    this.phase = PHASE.BUY;
    this.phaseTime = this.buyTime;
    this.spike.planted = false;
    this.spike.dropped = false;
    this.spike.site = null;
    this.plantProgress = 0;
    this.defuseProgress = 0;
    this.defuser = null;
    this.game.respawnAll();
    // The attackers pick a site to hit this round; defenders don't know which.
    this.targetSite = pick(this.sites);
    this._giveSpike();
    this.announce(first ? 'ROUND 1 — PREPARE' : `ROUND ${this.round}`, 2.5);
    audio.ui('objective');
  }

  _giveSpike() {
    const attackers = this.game.damageables.filter((e) => e.alive && e.team === this.attackTeam);
    if (!attackers.length) return;
    // Prefer the player so they get to make the play.
    const player = attackers.find((a) => a.isPlayer);
    this.spike.carrier = player || pick(attackers);
    this.spike.carrier.hasSpike = true;
    for (const a of attackers) if (a !== this.spike.carrier) a.hasSpike = false;
  }

  update(dt) {
    if (this.over) return;
    this.phaseTime -= dt;

    if (this.phase === PHASE.BUY) {
      this.game.movementLocked = true;
      if (this.phaseTime <= 0) {
        this.phase = PHASE.LIVE;
        this.phaseTime = this.roundTime;
        this.game.movementLocked = false;
        this.announce('GO', 1.2, 'good');
      }
      return;
    }
    this.game.movementLocked = false;

    if (this.phase === PHASE.LIVE) {
      this._updatePlant(dt);
      const attackersAlive = this._aliveCount(this.attackTeam);
      const defendersAlive = this._aliveCount(1 - this.attackTeam);
      if (defendersAlive === 0) return this._endRound(this.attackTeam, 'ATTACKERS ELIMINATED THE DEFENCE');
      if (attackersAlive === 0) return this._endRound(1 - this.attackTeam, 'ATTACKERS ELIMINATED');
      if (this.phaseTime <= 0) return this._endRound(1 - this.attackTeam, 'TIME EXPIRED');
    } else if (this.phase === PHASE.PLANTED) {
      this._updateDefuse(dt);
      if (this.phaseTime <= 0) return this._endRound(this.attackTeam, 'SPIKE DETONATED');
      if (this._aliveCount(1 - this.attackTeam) === 0) return this._endRound(this.attackTeam, 'DEFENCE ELIMINATED');
    } else if (this.phase === PHASE.ENDED) {
      if (this.phaseTime <= 0) {
        if (this.scores[0] >= this.roundsToWin) return this.finish(0);
        if (this.scores[1] >= this.roundsToWin) return this.finish(1);
        // Swap sides at the halfway point.
        if (this.round === this.roundsToWin) {
          this.attackTeam = 1 - this.attackTeam;
          this.announce('SIDES SWAPPED', 3, 'info');
        }
        this.startRound();
      }
    }
  }

  _aliveCount(team) {
    let n = 0;
    for (const e of this.game.damageables) if (e.alive && e.team === team) n++;
    return n;
  }

  _updatePlant(dt) {
    const carrier = this.spike.carrier;
    if (!carrier || !carrier.alive) {
      // Dropped spike: whoever picks it up carries it.
      if (!this.spike.dropped && carrier) {
        this.spike.dropped = true;
        this.spike.x = carrier.pos.x; this.spike.y = carrier.pos.y; this.spike.z = carrier.pos.z;
      }
      if (this.spike.dropped) {
        for (const e of this.game.damageables) {
          if (!e.alive || e.team !== this.attackTeam) continue;
          if (Math.hypot(e.pos.x - this.spike.x, e.pos.z - this.spike.z) < 1.6) {
            this.spike.carrier = e;
            e.hasSpike = true;
            this.spike.dropped = false;
            break;
          }
        }
      }
      return;
    }

    const site = this._siteAt(carrier.pos);
    const planting = site && this._isPlanting(carrier);
    if (planting) {
      this.plantProgress += dt / this.plantTime;
      if (carrier.isPlayer && Math.random() < dt * 8) audio.mech(null, 'click', 0.3);
      if (this.plantProgress >= 1) this._plant(site, carrier);
    } else {
      this.plantProgress = Math.max(0, this.plantProgress - dt * 0.8);
    }
  }

  _isPlanting(e) {
    if (e.isPlayer) return this.game.input.isDown('use') && e.moveSpeed < 1.2;
    // Bots plant when they're on site, reasonably safe, and holding the spike.
    const threat = e.perception ? e.perception.primaryTarget() : null;
    return !threat && e.moveSpeed < 1.5;
  }

  _plant(site, carrier) {
    this.spike.planted = true;
    this.spike.site = site;
    this.spike.x = carrier.pos.x;
    this.spike.y = carrier.pos.y;
    this.spike.z = carrier.pos.z;
    carrier.hasSpike = false;
    this.phase = PHASE.PLANTED;
    this.phaseTime = this.spikeTimer;
    this.plantProgress = 1;
    this.announce(`SPIKE PLANTED — ${site.id}`, 3, this.game.player.team === this.attackTeam ? 'good' : 'bad');
    audio.ui('alarm');
    this.game.spawnSpikeMarker(this.spike);
  }

  _updateDefuse(dt) {
    let defuser = null;
    for (const e of this.game.damageables) {
      if (!e.alive || e.team === this.attackTeam) continue;
      if (Math.hypot(e.pos.x - this.spike.x, e.pos.z - this.spike.z) > 1.8) continue;
      if (Math.abs(e.pos.y - this.spike.y) > 2.5) continue;
      if (e.isPlayer) { if (this.game.input.isDown('use') && e.moveSpeed < 1.2) { defuser = e; break; } }
      else {
        const threat = e.perception ? e.perception.primaryTarget() : null;
        if (!threat && e.moveSpeed < 1.5) { defuser = e; break; }
      }
    }
    this.defuser = defuser;
    if (defuser) {
      this.defuseProgress += dt / this.defuseTime;
      if (defuser.isPlayer && Math.random() < dt * 6) audio.mech(null, 'click', 0.25);
      if (this.defuseProgress >= 1) this._endRound(1 - this.attackTeam, 'SPIKE DEFUSED');
    } else {
      this.defuseProgress = Math.max(0, this.defuseProgress - dt * 0.5);
    }
  }

  _siteAt(pos) {
    for (const s of this.sites) {
      if (Math.hypot(pos.x - s.x, pos.z - s.z) <= s.radius && Math.abs(pos.y - s.y) < 3) return s;
    }
    return null;
  }

  _endRound(winner, reason) {
    this.scores[winner]++;
    this.phase = PHASE.ENDED;
    this.phaseTime = 5;
    this.game.clearSpikeMarker();
    const playerWon = winner === this.game.player.team;
    this.announce(`${reason}`, 4, playerWon ? 'good' : 'bad');
    audio.ui(playerWon ? 'win' : 'lose');
  }

  onKill(victim, killer) {
    if (killer && killer !== victim && killer.team !== victim.team) this.scores[killer.team] += 0;
    if (victim === this.spike.carrier && !this.spike.planted) {
      this.spike.dropped = true;
      this.spike.x = victim.pos.x; this.spike.y = victim.pos.y; this.spike.z = victim.pos.z;
      victim.hasSpike = false;
    }
  }

  assignObjectives() {
    const attackers = this.attackTeam;
    const defenders = 1 - this.attackTeam;
    const bbA = this.game.blackboards[attackers];
    const bbD = this.game.blackboards[defenders];

    if (this.spike.planted) {
      // Attackers hold the plant; defenders converge to retake it.
      const p = { x: this.spike.x, y: this.spike.y, z: this.spike.z };
      bbA.objectiveFocus = p;
      bbD.objectiveFocus = p;
      for (const a of this.game.agents) {
        if (a.isPlayer || !a.alive) continue;
        a.objective = p;
        a.objectivePriority = a.team === defenders ? 0.95 : 0.55;
      }
      return;
    }

    const target = this.targetSite || this.sites[0];
    bbA.objectiveFocus = { x: target.x, y: target.y, z: target.z };
    for (const a of this.game.agents) {
      if (a.isPlayer || !a.alive) continue;
      if (a.team === attackers) {
        // The spike carrier goes to site; the rest take space around it.
        a.objective = { x: target.x, y: target.y, z: target.z };
        a.objectivePriority = a.hasSpike ? 0.9 : 0.5;
      } else {
        // Defenders split across the sites, weighted by what they know.
        if (!a._holdSite || a._holdSiteRound !== this.round) {
          a._holdSite = this.sites[(this.game.agents.indexOf(a) + this.round) % this.sites.length];
          a._holdSiteRound = this.round;
        }
        const known = bbD.bestContact(this.game.time, 5);
        let site = a._holdSite;
        if (known) {
          // If we've seen attackers, rotate toward the site nearest that contact.
          let nearest = this.sites[0], nd = Infinity;
          for (const s of this.sites) {
            const d = Math.hypot(s.x - known.x, s.z - known.z);
            if (d < nd) { nd = d; nearest = s; }
          }
          if (nd < 30) site = nearest;
        }
        a.objective = { x: site.x, y: site.y, z: site.z };
        a.objectivePriority = 0.62;
      }
    }
    bbD.objectiveFocus = { x: target.x, y: target.y, z: target.z };
  }

  hudState() {
    return {
      ...super.hudState(),
      scoreLimit: this.roundsToWin,
      round: this.round,
      phase: this.phase,
      phaseTime: this.phaseTime,
      attackTeam: this.attackTeam,
      spike: this.spike,
      plantProgress: this.plantProgress,
      defuseProgress: this.defuseProgress,
      alive: [this._aliveCount(0), this._aliveCount(1)],
    };
  }
}

/* --------------------------------------------------------------- gun game -- */

export class GunGame extends GameMode {
  constructor(game, opts) {
    super(game, opts);
    this.id = 'gungame';
    this.name = 'GUN GAME';
    this.teamBased = false;
    this.friendlyFire = true;
    this.respawnDelay = 2.5;
    this.timeLimit = opts.timeLimit ?? 900;
    this.timeLeft = this.timeLimit;
    this.ladder = GUNGAME_LADDER;
    this.scoreLimit = this.ladder.length;
    this.levels = new Map();
  }

  init() {
    for (const e of this.game.damageables) {
      this.levels.set(e.id ?? 'player', 0);
      this._applyLevel(e, 0);
    }
  }

  _key(e) { return e.isPlayer ? 'player' : e.id; }

  _applyLevel(e, level) {
    const id = this.ladder[Math.min(level, this.ladder.length - 1)];
    const loadout = id === 'knife' ? ['knife', 'knife', 'knife'] : [id, 'knife', 'knife'];
    if (e.setLoadout) e.setLoadout(loadout);
  }

  levelOf(e) { return this.levels.get(this._key(e)) ?? 0; }

  onKill(victim, killer) {
    if (!killer || killer === victim) {
      // Self-elimination costs a level, so nobody farms the void.
      const cur = this.levelOf(victim);
      this.levels.set(this._key(victim), Math.max(0, cur - 1));
      return;
    }
    const cur = this.levelOf(killer);
    const next = cur + 1;
    this.levels.set(this._key(killer), next);
    if (next >= this.ladder.length) {
      this.finish(killer.isPlayer ? 0 : 1);
      this.game.hud.banner(`${killer.name} COMPLETED THE LADDER`, 5, killer.isPlayer ? 'good' : 'bad');
      return;
    }
    this._applyLevel(killer, next);
    if (killer.isPlayer) {
      audio.ui('levelUp');
      this.game.hud.banner(`LEVEL ${next + 1} — ${WEAPONS[this.ladder[next]].name}`, 2, 'good');
    }
    // A knife kill knocks the victim back a level.
    if (killer.def && killer.def.melee) {
      const vc = this.levelOf(victim);
      if (vc > 0) {
        this.levels.set(this._key(victim), vc - 1);
        this._applyLevel(victim, vc - 1);
        if (victim.isPlayer) this.game.hud.banner('HUMILIATED — LEVEL LOST', 2.5, 'bad');
      }
    }
  }

  onSpawn(e) { this._applyLevel(e, this.levelOf(e)); }

  assignObjectives() {
    for (const bb of this.game.blackboards) bb.objectiveFocus = null;
    for (const a of this.game.agents) { if (!a.isPlayer) { a.objective = null; a.objectivePriority = 0; } }
  }

  hudState() {
    const board = this.game.damageables
      .map((e) => ({ name: e.name, level: this.levelOf(e), isPlayer: !!e.isPlayer }))
      .sort((a, b) => b.level - a.level);
    return {
      ...super.hudState(),
      teamBased: false,
      ladder: this.ladder,
      playerLevel: this.levelOf(this.game.player),
      board: board.slice(0, 8),
    };
  }
}

/* -------------------------------------------------------------- firefight -- */

const WAVE_ARCHETYPES = [
  { id: 'rusher', loadout: ['vector', 'sidewinder', 'knife'], difficulty: 'regular', weight: 3, aggression: 0.85 },
  { id: 'rifleman', loadout: ['kestrel', 'sidewinder', 'knife'], difficulty: 'regular', weight: 3, aggression: 0.5 },
  { id: 'breacher', loadout: ['breaker', 'sidewinder', 'knife'], difficulty: 'veteran', weight: 1.5, aggression: 0.95 },
  { id: 'marksman', loadout: ['shrike', 'ghost', 'knife'], difficulty: 'veteran', weight: 1, aggression: 0.2 },
  { id: 'heavy', loadout: ['havoc', 'sidewinder', 'knife'], difficulty: 'veteran', weight: 1, aggression: 0.4, health: 180 },
  { id: 'elite', loadout: ['warden', 'ghost', 'knife'], difficulty: 'elite', weight: 0.8, aggression: 0.7, health: 140 },
];

export class Firefight extends GameMode {
  constructor(game, opts) {
    super(game, opts);
    this.id = 'firefight';
    this.name = 'FIREFIGHT';
    this.teamBased = true;
    this.respawn = false;
    this.regen = true;
    this.timeLimit = Infinity;
    this.timeLeft = Infinity;
    this.wave = 0;
    this.state = 'prep';       // prep | active | cleared | failed
    this.stateTime = 6;
    this.remaining = 0;
    this.queue = [];
    this.spawnTimer = 0;
    this.maxConcurrent = 8;
    this.credits = 0;
    this.perks = { health: 0, damage: 0, speed: 0, ammo: 0 };
    this.scoreLimit = 0;
  }

  init() {
    // Everyone who isn't the player starts as a hostile that spawns in waves.
    for (const a of this.game.agents) {
      if (a.isPlayer) continue;
      a.team = 1;
      a.alive = false;
      a.despawn();
    }
    this.game.player.team = 0;
    this.announce('HOSTILES INBOUND', 3, 'bad');
  }

  update(dt) {
    if (this.over) return;
    this.stateTime -= dt;

    if (this.state === 'prep') {
      if (this.stateTime <= 0) this._startWave();
      return;
    }

    if (this.state === 'active') {
      this.spawnTimer -= dt;
      const active = this.game.agents.filter((a) => a.alive && a.team === 1).length;
      if (this.queue.length && this.spawnTimer <= 0 && active < this.maxConcurrent) {
        this.spawnTimer = rand(0.4, 1.4);
        this._spawnOne(this.queue.shift());
      }
      this.remaining = this.queue.length + active;
      if (this.remaining === 0) {
        this.state = 'cleared';
        this.stateTime = 8;
        this.credits += 100 + this.wave * 40;
        this.announce(`WAVE ${this.wave} CLEARED`, 3.5, 'good');
        audio.ui('win');
        this.game.player.heal(35);
        this.game.onWaveCleared?.(this.wave, this.credits);
      }
      if (!this.game.player.alive) {
        this.state = 'failed';
        this.finish(1);
        this.game.hud.banner(`OVERRUN ON WAVE ${this.wave}`, 6, 'bad');
      }
      return;
    }

    if (this.state === 'cleared') {
      if (this.stateTime <= 0) {
        this.state = 'prep';
        this.stateTime = 4;
      }
      return;
    }
  }

  _startWave() {
    this.wave++;
    this.state = 'active';
    this.queue = this._buildWave(this.wave);
    this.remaining = this.queue.length;
    this.maxConcurrent = Math.min(12, 5 + Math.floor(this.wave / 2));
    this.spawnTimer = 0;
    this.announce(`WAVE ${this.wave}`, 2.5, 'bad');
    audio.ui('alarm');
  }

  _buildWave(n) {
    const count = Math.min(30, 4 + Math.floor(n * 1.7));
    const out = [];
    // Composition shifts from rushers toward elites as waves climb.
    const pool = WAVE_ARCHETYPES.filter((a) => {
      if (a.id === 'elite') return n >= 6;
      if (a.id === 'heavy') return n >= 4;
      if (a.id === 'marksman') return n >= 3;
      if (a.id === 'breacher') return n >= 2;
      return true;
    });
    const totalWeight = pool.reduce((s, a) => s + a.weight * (a.id === 'rusher' ? Math.max(0.4, 2 - n * 0.12) : 1), 0);
    for (let i = 0; i < count; i++) {
      let r = Math.random() * totalWeight;
      let chosen = pool[0];
      for (const a of pool) {
        const w = a.weight * (a.id === 'rusher' ? Math.max(0.4, 2 - n * 0.12) : 1);
        if (r < w) { chosen = a; break; }
        r -= w;
      }
      out.push(chosen);
    }
    return shuffle(out);
  }

  _spawnOne(archetype) {
    const pool = this.game.agents.filter((a) => !a.alive && a.team === 1);
    const bot = pool.length ? pool[0] : this.game.addAgent(1);
    if (!bot) return;
    bot.setLoadout(archetype.loadout);
    bot.difficulty = { ...(bot.difficulty), ...this._difficultyFor(archetype) };
    bot.profile.aggression = archetype.aggression;
    bot.maxHealth = (archetype.health ?? 100) + this.wave * 4;
    bot.health = bot.maxHealth;
    // Spawn out of the player's sight, at a distance that gives them time.
    const spot = this._hostileSpawn();
    bot.spawn(spot.x, spot.y, spot.z, spot.yaw ?? rand(-Math.PI, Math.PI));
    bot.character.root.visible = true;
    bot.objective = { x: this.game.player.pos.x, y: this.game.player.pos.y, z: this.game.player.pos.z };
    bot.objectivePriority = 0.8;
  }

  _difficultyFor(archetype) {
    const base = { recruit: 0, regular: 1, veteran: 2, elite: 3 }[archetype.difficulty] ?? 1;
    const scaled = clamp(base + Math.floor(this.wave / 5), 0, 3);
    const names = ['recruit', 'regular', 'veteran', 'elite'];
    const DIFF = this.game.difficultyTable;
    return DIFF[names[scaled]] || DIFF.regular;
  }

  _hostileSpawn() {
    const nav = this.game.nav;
    const p = this.game.player;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 26; i++) {
      const n = nav.randomNode(null, 0);
      if (!n) continue;
      const d = Math.hypot(n.x - p.pos.x, n.z - p.pos.z);
      if (d < 16) continue;
      const seen = this.game.collision.lineOfSight(n.x, n.y + 1.6, n.z, p.pos.x, p.pos.y + 1.6, p.pos.z);
      const score = (seen ? -40 : 0) + Math.min(d, 60) * 0.4 + rand(0, 6);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (best) return { x: best.x, y: best.y + 0.05, z: best.z };
    const fallback = this.game.mapBuilder.spawnPoints[1]?.[0] || { x: 0, y: 2, z: 0 };
    return fallback;
  }

  onKill(victim, killer) {
    if (killer && killer.isPlayer && victim.team === 1) {
      this.credits += 15;
      this.scores[0]++;
    }
  }

  buyPerk(kind) {
    const costs = { health: 250, damage: 350, speed: 200, ammo: 150 };
    const cost = (costs[kind] ?? 999) * (1 + (this.perks[kind] ?? 0) * 0.6);
    if (this.credits < cost) return false;
    this.credits -= Math.round(cost);
    this.perks[kind] = (this.perks[kind] ?? 0) + 1;
    const p = this.game.player;
    if (kind === 'health') { p.maxHealth += 25; p.health = p.maxHealth; }
    if (kind === 'ammo') for (const id of p.loadout) if (p.reserve[id] !== undefined) p.reserve[id] += WEAPONS[id]?.mag * 2 || 0;
    audio.ui('levelUp');
    return true;
  }

  assignObjectives() {
    const p = this.game.player;
    const bb = this.game.blackboards[1];
    bb.objectiveFocus = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    for (const a of this.game.agents) {
      if (a.isPlayer || !a.alive) continue;
      a.objective = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      a.objectivePriority = 0.7;
    }
  }

  hudState() {
    return {
      ...super.hudState(),
      wave: this.wave,
      state: this.state,
      stateTime: this.stateTime,
      remaining: this.remaining,
      credits: this.credits,
      perks: this.perks,
      teamBased: false,
    };
  }
}

export const MODES = {
  deathmatch: { id: 'deathmatch', name: 'TEAM DEATHMATCH', ctor: TeamDeathmatch, blurb: 'Two squads, one score limit. Respawns on.', players: 10 },
  detonate: { id: 'detonate', name: 'DETONATE', ctor: Detonate, blurb: 'Round-based attack and defend. One life per round.', players: 10 },
  domination: { id: 'domination', name: 'DOMINATION', ctor: Domination, blurb: 'Hold capture zones to bleed the enemy score.', players: 10 },
  gungame: { id: 'gungame', name: 'GUN GAME', ctor: GunGame, blurb: 'Free-for-all. Every kill advances your weapon.', players: 8 },
  firefight: { id: 'firefight', name: 'FIREFIGHT', ctor: Firefight, blurb: 'Survive escalating waves. Spend credits between them.', players: 12 },
};

export function createMode(id, game, opts = {}) {
  const entry = MODES[id] || MODES.deathmatch;
  return new entry.ctor(game, opts);
}
