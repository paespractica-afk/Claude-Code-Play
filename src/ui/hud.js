// Heads-up display.
//
// Static furniture is DOM (cheap, crisp text); anything that animates every
// frame — crosshair, radar, damage arrows, hitmarkers — is drawn on a single
// 2D canvas so the HUD never triggers layout during a firefight.

import { clamp, clamp01, lerp, damp, TAU } from '../core/math.js';
import { WEAPONS } from '../weapons/defs.js';

const TEAM_HEX = ['#4fc3f7', '#ff7043'];

export class HUD {
  constructor(root, settings) {
    this.root = root;
    this.settings = settings;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-canvas';
    this.ctx = this.canvas.getContext('2d');
    root.appendChild(this.canvas);

    this.dom = {};
    this._buildDom();

    this.killfeed = [];
    this.damageMarks = [];
    this.hitmarkerTime = -9;
    this.hitmarkerKill = false;
    this.hitmarkerHead = false;
    this.banners = [];
    this.damageNumbers = [];
    this.spreadDisplay = 0;
    this.time = 0;
    this.radarRange = 42;
    this.lowAmmoPulse = 0;
    this.visible = true;
    this.resize();
  }

  _el(cls, parent = this.root, tag = 'div') {
    const e = document.createElement(tag);
    e.className = cls;
    parent.appendChild(e);
    return e;
  }

  _buildDom() {
    const d = this.dom;

    // --- top centre: mode, score, timer ---
    d.topBar = this._el('hud-top');
    d.scoreA = this._el('score score-a', d.topBar);
    d.timerBox = this._el('timer-box', d.topBar);
    d.timer = this._el('timer', d.timerBox);
    d.modeName = this._el('mode-name', d.timerBox);
    d.scoreB = this._el('score score-b', d.topBar);

    // --- objective strip under the score ---
    d.objective = this._el('hud-objective');

    // --- bottom left: health / armour ---
    d.vitals = this._el('hud-vitals');
    d.healthRow = this._el('vital-row', d.vitals);
    d.healthBar = this._el('bar health', d.healthRow);
    d.healthFill = this._el('bar-fill', d.healthBar);
    d.healthLag = this._el('bar-lag', d.healthBar);
    d.healthNum = this._el('vital-num', d.healthRow);
    d.armorRow = this._el('vital-row armor-row', d.vitals);
    d.armorBar = this._el('bar armor', d.armorRow);
    d.armorFill = this._el('bar-fill', d.armorBar);
    d.armorNum = this._el('vital-num', d.armorRow);

    // --- bottom right: weapon / ammo ---
    d.weapon = this._el('hud-weapon');
    d.weaponName = this._el('weapon-name', d.weapon);
    d.ammoRow = this._el('ammo-row', d.weapon);
    d.ammoMag = this._el('ammo-mag', d.ammoRow);
    d.ammoSep = this._el('ammo-sep', d.ammoRow);
    d.ammoSep.textContent = '/';
    d.ammoReserve = this._el('ammo-reserve', d.ammoRow);
    d.fireMode = this._el('fire-mode', d.weapon);
    d.gearRow = this._el('gear-row', d.weapon);

    // --- killfeed ---
    d.killfeed = this._el('hud-killfeed');

    // --- centre banner ---
    d.banner = this._el('hud-banner');

    // --- interaction prompt ---
    d.prompt = this._el('hud-prompt');

    // --- scoreboard ---
    d.scoreboard = this._el('hud-scoreboard');
    d.scoreboard.style.display = 'none';

    // --- fps / debug ---
    d.stats = this._el('hud-stats');
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.w = w; this.h = h; this.dpr = dpr;
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.opacity = v ? '1' : '0';
    this.root.style.pointerEvents = 'none';
  }

  /* ------------------------------------------------------------- events -- */

  hitmarker(headshot, kill) {
    if (!this.settings.hitmarkers) return;
    this.hitmarkerTime = this.time;
    this.hitmarkerHead = headshot;
    this.hitmarkerKill = kill;
  }

  damageNumber(x, y, amount, headshot) {
    if (!this.settings.damageNumbers) return;
    this.damageNumbers.push({ x, y, amount: Math.round(amount), headshot, t: this.time, life: 0.85 });
    if (this.damageNumbers.length > 24) this.damageNumbers.shift();
  }

  damageIndicator(source, dir) {
    this.damageMarks.push({
      source: source ? { x: source.pos.x, z: source.pos.z } : null,
      dir: dir ? { x: dir.x, z: dir.z } : null,
      t: this.time,
      life: 1.6,
    });
    if (this.damageMarks.length > 8) this.damageMarks.shift();
  }

  addKill(killerName, victimName, weaponId, headshot, killerTeam, victimTeam, playerInvolved) {
    const w = WEAPONS[weaponId];
    this.killfeed.push({
      killer: killerName, victim: victimName,
      weapon: w ? w.name : '', headshot,
      killerTeam, victimTeam, playerInvolved,
      t: this.time,
    });
    if (this.killfeed.length > 6) this.killfeed.shift();
    this._renderKillfeed();
  }

  banner(text, seconds = 3, kind = 'info') {
    this.banners.push({ text, until: this.time + seconds, kind });
    if (this.banners.length > 3) this.banners.shift();
  }

  prompt(text) { this._promptText = text; }

  /* -------------------------------------------------------------- render -- */

  update(dt, state) {
    this.time += dt;
    if (!this.visible) return;
    this._updateDom(state);
    this._draw(dt, state);
  }

  _updateDom(s) {
    const d = this.dom;
    const p = s.player;

    // Health / armour.
    const hp = clamp01(p.health / p.maxHealth);
    d.healthFill.style.width = `${hp * 100}%`;
    d.healthFill.style.background = hp > 0.5 ? 'linear-gradient(90deg,#4ff2c8,#63ffb0)'
      : hp > 0.25 ? 'linear-gradient(90deg,#ffc65c,#ffdd8a)' : 'linear-gradient(90deg,#ff5c5c,#ff8a8a)';
    this._healthLag = this._healthLag === undefined ? hp : Math.max(hp, this._healthLag - 0.35 * (1 / 60));
    d.healthLag.style.width = `${this._healthLag * 100}%`;
    d.healthNum.textContent = Math.ceil(p.health);
    const ar = clamp01(p.armor / (p.maxArmor || 1));
    d.armorRow.style.opacity = p.armor > 0 ? '1' : '0.25';
    d.armorFill.style.width = `${ar * 100}%`;
    d.armorNum.textContent = Math.ceil(p.armor);

    // Weapon.
    const def = p.def;
    if (def) {
      d.weaponName.textContent = def.name;
      if (def.melee) {
        d.ammoMag.textContent = '—';
        d.ammoReserve.textContent = '';
        d.ammoSep.style.opacity = '0';
      } else {
        d.ammoSep.style.opacity = '1';
        const mag = p.ammo[def.id] ?? 0;
        d.ammoMag.textContent = mag;
        d.ammoReserve.textContent = p.reserve[def.id] ?? 0;
        const low = mag / def.mag <= 0.25;
        d.ammoMag.classList.toggle('low', low);
      }
      d.fireMode.textContent = def.melee ? 'MELEE' : def.auto ? 'AUTO' : def.boltAction ? 'BOLT' : 'SEMI';
    }
    // Grenades.
    const gear = [];
    for (const [k, v] of Object.entries(p.grenades)) if (v > 0) gear.push(`${k.toUpperCase()} ×${v}`);
    d.gearRow.textContent = gear.join('   ');

    // Score / timer.
    const m = s.mode;
    d.modeName.textContent = m.mode;
    if (Number.isFinite(m.timeLeft)) {
      const t = Math.max(0, m.timeLeft);
      d.timer.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    } else if (m.phaseTime !== undefined) {
      const t = Math.max(0, m.phaseTime);
      d.timer.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    } else d.timer.textContent = '--:--';

    if (m.teamBased) {
      d.scoreA.style.display = d.scoreB.style.display = '';
      d.scoreA.textContent = m.scores[0];
      d.scoreB.textContent = m.scores[1];
      d.scoreA.style.color = TEAM_HEX[0];
      d.scoreB.style.color = TEAM_HEX[1];
      d.scoreA.classList.toggle('own', s.player.team === 0);
      d.scoreB.classList.toggle('own', s.player.team === 1);
    } else {
      d.scoreA.style.display = d.scoreB.style.display = 'none';
    }

    d.objective.innerHTML = this._objectiveHtml(m, s);
    d.prompt.textContent = this._promptText || '';
    d.prompt.style.opacity = this._promptText ? '1' : '0';
    this._promptText = '';

    d.stats.style.display = this.settings.showFps ? '' : 'none';
    if (this.settings.showFps) {
      d.stats.textContent = `${Math.round(s.fps)} FPS · ${s.drawCalls ?? 0} draws · ${s.agentCount ?? 0} AI`;
    }
  }

  _objectiveHtml(m, s) {
    if (m.wave !== undefined) {
      const st = m.state === 'active' ? `${m.remaining} HOSTILE${m.remaining === 1 ? '' : 'S'} REMAINING`
        : m.state === 'cleared' ? `REARM — ${Math.ceil(m.stateTime)}s`
          : m.state === 'prep' ? `WAVE ${m.wave + 1} IN ${Math.ceil(m.stateTime)}s` : 'OVERRUN';
      return `<span class="obj-main">WAVE ${m.wave}</span><span class="obj-sub">${st}</span><span class="obj-credits">${m.credits} CR</span>`;
    }
    if (m.phase !== undefined) {
      const atk = m.attackTeam === s.player.team;
      const phase = m.phase === 'buy' ? 'PREPARE'
        : m.phase === 'planted' ? 'SPIKE ACTIVE'
          : m.phase === 'ended' ? 'ROUND OVER' : (atk ? 'ATTACK' : 'DEFEND');
      const alive = m.alive ? `<span class="obj-alive">${m.alive[s.player.team]} v ${m.alive[1 - s.player.team]}</span>` : '';
      return `<span class="obj-main ${m.phase === 'planted' ? 'urgent' : ''}">${phase}</span><span class="obj-sub">ROUND ${m.round}</span>${alive}`;
    }
    if (m.zones) {
      const cells = m.zones.map((z) => {
        const owner = z.owner === -1 ? 'neutral' : (z.owner === s.player.team ? 'ours' : 'theirs');
        const pct = Math.round(Math.abs(z.progress) * 100);
        return `<span class="zone ${owner} ${z.contested ? 'contested' : ''}">${z.id}<i style="width:${pct}%"></i></span>`;
      }).join('');
      return `<div class="zones">${cells}</div>`;
    }
    if (m.ladder) {
      return `<span class="obj-main">LEVEL ${m.playerLevel + 1}/${m.ladder.length}</span><span class="obj-sub">${WEAPONS[m.ladder[Math.min(m.playerLevel, m.ladder.length - 1)]].name}</span>`;
    }
    return '';
  }

  _renderKillfeed() {
    const html = this.killfeed.map((k) => {
      const kc = TEAM_HEX[k.killerTeam] || '#ddd';
      const vc = TEAM_HEX[k.victimTeam] || '#ddd';
      return `<div class="kf-row ${k.playerInvolved ? 'mine' : ''}">
        <span style="color:${kc}">${k.killer}</span>
        <span class="kf-weapon">${k.headshot ? '◎' : '›'} ${k.weapon}</span>
        <span style="color:${vc}">${k.victim}</span>
      </div>`;
    }).join('');
    this.dom.killfeed.innerHTML = html;
  }

  _draw(dt, s) {
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    this._drawCrosshair(ctx, cx, cy, dt, s);
    this._drawHitmarker(ctx, cx, cy);
    this._drawDamageArrows(ctx, cx, cy, s);
    this._drawRadar(ctx, s);
    this._drawBanners(ctx, cx, cy);
    this._drawObjectiveMarkers(ctx, s);
    this._drawProgressRing(ctx, cx, cy, s);
    this._drawDamageNumbers(ctx);
    this._drawLowHealth(ctx, s);
  }

  _drawCrosshair(ctx, cx, cy, dt, s) {
    const p = s.player;
    if (!p.alive) return;
    const ads = p.viewModel ? p.viewModel.adsAmount : 0;
    const def = p.def;
    if (def && def.scoped && ads > 0.85) { this._drawScope(ctx, cx, cy, ads); return; }

    const spread = s.spread ?? 0;
    const target = this.settings.crosshairStyle === 'static' ? 6 : 6 + spread * 8;
    this.spreadDisplay = damp(this.spreadDisplay, target, 18, dt);
    const gap = this.spreadDisplay * (1 - ads * 0.55);
    const len = 5 + this.spreadDisplay * 0.25;
    const col = this.settings.crosshairColor || '#4ff2c8';

    ctx.save();
    ctx.globalAlpha = 1 - ads * 0.35;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) { ctx.strokeStyle = col; ctx.lineWidth = 1.6; }
      ctx.beginPath();
      ctx.moveTo(cx - gap - len, cy); ctx.lineTo(cx - gap, cy);
      ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
      ctx.moveTo(cx, cy - gap - len); ctx.lineTo(cx, cy - gap);
      ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
      ctx.stroke();
    }
    // Centre dot.
    ctx.fillStyle = col;
    ctx.globalAlpha = (1 - ads * 0.35) * 0.9;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    ctx.restore();
  }

  _drawScope(ctx, cx, cy, ads) {
    const r = Math.min(this.w, this.h) * 0.42;
    ctx.save();
    ctx.globalAlpha = clamp01((ads - 0.85) / 0.15);
    // Black surround.
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    ctx.arc(cx, cy, r, 0, TAU, true);
    ctx.fill();
    // Lens ring and vignette.
    const g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(20,24,28,0.95)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    // Reticle.
    ctx.strokeStyle = 'rgba(20,24,26,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx - 14, cy);
    ctx.moveTo(cx + 14, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - 14);
    ctx.moveTo(cx, cy + 14); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    // Mil-dot ladder.
    ctx.fillStyle = 'rgba(20,24,26,0.9)';
    for (let i = 1; i <= 5; i++) {
      const y = cy + i * r * 0.12;
      const wdt = i % 2 === 0 ? 10 : 6;
      ctx.fillRect(cx - wdt / 2, y, wdt, 1.4);
    }
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    ctx.restore();
  }

  _drawHitmarker(ctx, cx, cy) {
    const age = this.time - this.hitmarkerTime;
    if (age > 0.35) return;
    const t = clamp01(age / 0.35);
    const spread = 6 + t * 5;
    const len = 7;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = this.hitmarkerKill ? '#ff4d4d' : this.hitmarkerHead ? '#ffd24d' : '#ffffff';
    ctx.lineWidth = this.hitmarkerKill ? 2.6 : 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(cx + sx * spread, cy + sy * spread);
      ctx.lineTo(cx + sx * (spread + len), cy + sy * (spread + len));
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawDamageArrows(ctx, cx, cy, s) {
    const p = s.player;
    const yaw = p.yaw;
    for (let i = this.damageMarks.length - 1; i >= 0; i--) {
      const m = this.damageMarks[i];
      const age = this.time - m.t;
      if (age > m.life) { this.damageMarks.splice(i, 1); continue; }
      let dx, dz;
      if (m.source) { dx = m.source.x - p.pos.x; dz = m.source.z - p.pos.z; }
      else if (m.dir) { dx = -m.dir.x; dz = -m.dir.z; }
      else continue;
      // Angle relative to where the player is facing.
      const world = Math.atan2(-dx, -dz);
      const rel = world - yaw;
      const alpha = (1 - age / m.life) * 0.9;
      const r = Math.min(this.w, this.h) * 0.17;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-rel);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.moveTo(0, -r - 22);
      ctx.lineTo(-16, -r + 2);
      ctx.lineTo(0, -r - 6);
      ctx.lineTo(16, -r + 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  _drawRadar(ctx, s) {
    const size = Math.min(190, this.w * 0.17);
    const pad = 22;
    const cx = pad + size / 2;
    const cy = pad + size / 2 + 8;
    const r = size / 2;
    const p = s.player;

    ctx.save();
    // Dish.
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.closePath();
    ctx.fillStyle = 'rgba(6,10,14,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,180,210,0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.62, 0, TAU); ctx.strokeStyle = 'rgba(140,180,210,0.16)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.3, 0, TAU); ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, TAU); ctx.clip();

    const scale = r / this.radarRange;
    const toRadar = (x, z) => {
      const dx = x - p.pos.x, dz = z - p.pos.z;
      const c = Math.cos(-p.yaw), sn = Math.sin(-p.yaw);
      // Rotate into view space so "up" is always where the player looks.
      const rx = dx * c - dz * sn;
      const rz = dx * sn + dz * c;
      return [cx + rx * scale, cy + rz * scale];
    };

    // Objective markers.
    for (const o of s.radarObjectives || []) {
      const [x, y] = toRadar(o.x, o.z);
      ctx.fillStyle = o.color || 'rgba(255,190,90,0.85)';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0a0d12';
      ctx.font = 'bold 8px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(o.label || '', x, y + 0.5);
    }

    // Contacts.
    for (const c of s.radarContacts || []) {
      const [x, y] = toRadar(c.x, c.z);
      const dy = c.y - p.pos.y;
      ctx.globalAlpha = c.fade ?? 1;
      if (c.kind === 'ally') {
        ctx.fillStyle = TEAM_HEX[p.team];
        ctx.beginPath();
        ctx.moveTo(x, y - 4); ctx.lineTo(x + 3.4, y + 3.4); ctx.lineTo(x - 3.4, y + 3.4);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = '#ff5252';
        ctx.beginPath(); ctx.arc(x, y, 3.6, 0, TAU); ctx.fill();
        if (Math.abs(dy) > 1.6) {
          // Vertical offset chevron: above or below the player.
          ctx.fillStyle = '#ffb0b0';
          ctx.font = 'bold 9px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(dy > 0 ? '▲' : '▼', x, y - 6);
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // Player arrow.
    ctx.fillStyle = '#eaf4ff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6); ctx.lineTo(cx + 4.4, cy + 4.6); ctx.lineTo(cx, cy + 2.4); ctx.lineTo(cx - 4.4, cy + 4.6);
    ctx.closePath(); ctx.fill();
    // Facing cone.
    ctx.fillStyle = 'rgba(234,244,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
    ctx.closePath(); ctx.fill();
    // Compass.
    ctx.fillStyle = 'rgba(190,215,235,0.75)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const dirs = [['N', 0], ['E', Math.PI / 2], ['S', Math.PI], ['W', -Math.PI / 2]];
    for (const [label, ang] of dirs) {
      const a = ang - p.yaw - Math.PI / 2;
      ctx.fillText(label, cx + Math.cos(a) * (r - 9), cy + Math.sin(a) * (r - 9));
    }
    ctx.restore();
  }

  _drawObjectiveMarkers(ctx, s) {
    if (!s.worldMarkers || !s.worldMarkers.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    for (const m of s.worldMarkers) {
      if (!m.onScreen) continue;
      const x = m.x * this.w, y = m.y * this.h;
      const alpha = clamp01(m.alpha ?? 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = m.color || '#ffb347';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      if (m.shape === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(x, y - 9); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 8, y);
        ctx.closePath();
        ctx.stroke(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.stroke(); ctx.fill();
      }
      if (m.label) {
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.strokeText(m.label, x, y - 16);
        ctx.fillText(m.label, x, y - 16);
      }
      if (m.distance !== undefined) {
        ctx.font = '10px system-ui, sans-serif';
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeText(`${Math.round(m.distance)}m`, x, y + 22);
        ctx.fillText(`${Math.round(m.distance)}m`, x, y + 22);
      }
    }
    ctx.restore();
  }

  /** Plant / defuse / capture progress ring under the crosshair. */
  _drawProgressRing(ctx, cx, cy, s) {
    const pr = s.progress;
    if (!pr || pr.value <= 0.001) return;
    const r = 34;
    ctx.save();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(cx, cy + 54, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = pr.color || '#4ff2c8';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy + 54, r, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(pr.value));
    ctx.stroke();
    ctx.fillStyle = '#eaf4ff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(pr.label || '', cx, cy + 54);
    ctx.restore();
  }

  _drawBanners(ctx, cx, cy) {
    for (let i = this.banners.length - 1; i >= 0; i--) {
      if (this.time > this.banners[i].until) this.banners.splice(i, 1);
    }
    if (!this.banners.length) return;
    const b = this.banners[this.banners.length - 1];
    const remaining = b.until - this.time;
    const alpha = clamp01(Math.min(remaining * 2.5, 1));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const color = b.kind === 'good' ? '#4ff2c8' : b.kind === 'bad' ? '#ff6b6b' : '#eaf4ff';
    ctx.font = '600 30px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(b.text, cx + 2, cy - 118);
    ctx.fillStyle = color;
    ctx.fillText(b.text, cx, cy - 120);
    ctx.restore();
  }

  _drawDamageNumbers(ctx) {
    ctx.save();
    ctx.textAlign = 'center';
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const n = this.damageNumbers[i];
      const age = this.time - n.t;
      if (age > n.life) { this.damageNumbers.splice(i, 1); continue; }
      const t = age / n.life;
      ctx.globalAlpha = 1 - t * t;
      ctx.font = n.headshot ? 'bold 20px system-ui, sans-serif' : 'bold 16px system-ui, sans-serif';
      const x = n.x * this.w;
      const y = n.y * this.h - t * 38;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(n.amount, x + 1.5, y + 1.5);
      ctx.fillStyle = n.headshot ? '#ffd24d' : '#ffffff';
      ctx.fillText(n.amount, x, y);
    }
    ctx.restore();
  }

  _drawLowHealth(ctx, s) {
    const p = s.player;
    if (!p.alive) return;
    const frac = p.health / p.maxHealth;
    if (frac > 0.35) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4.5);
    const alpha = (1 - frac / 0.35) * 0.32 * (0.55 + pulse * 0.45);
    const g = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.25, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.65);
    g.addColorStop(0, 'rgba(180,0,0,0)');
    g.addColorStop(1, `rgba(180,0,0,${alpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  /* ---------------------------------------------------------- scoreboard -- */

  showScoreboard(show, s) {
    this.dom.scoreboard.style.display = show ? '' : 'none';
    if (show) this._renderScoreboard(s);
  }

  _renderScoreboard(s) {
    const teams = s.mode.teamBased ? [0, 1] : [null];
    const rows = (team) => s.entities
      .filter((e) => team === null || e.team === team)
      .sort((a, b) => (b.kills - b.deaths) - (a.kills - a.deaths) || b.kills - a.kills)
      .map((e) => `<tr class="${e.isPlayer ? 'me' : ''}">
        <td class="nm">${e.name}</td>
        <td>${e.kills}</td><td>${e.deaths}</td><td>${e.assists ?? 0}</td>
        <td>${e.alive ? '<span class="alive">●</span>' : '<span class="dead">✕</span>'}</td>
      </tr>`).join('');

    const head = '<tr><th>OPERATOR</th><th>K</th><th>D</th><th>A</th><th></th></tr>';
    const blocks = teams.map((t) => `
      <div class="sb-team">
        <div class="sb-head" style="color:${t === null ? '#eaf4ff' : TEAM_HEX[t]}">
          ${t === null ? 'FREE FOR ALL' : (t === 0 ? 'ALPHA' : 'BRAVO')}
          ${s.mode.teamBased ? `<span class="sb-score">${s.mode.scores[t]}</span>` : ''}
        </div>
        <table>${head}${rows(t)}</table>
      </div>`).join('');

    this.dom.scoreboard.innerHTML = `
      <div class="sb-title">${s.mode.mode}<span>${s.mapName}</span></div>
      <div class="sb-teams">${blocks}</div>
      <div class="sb-hint">HOLD TAB · ESC FOR MENU</div>`;
  }

  clear() {
    this.killfeed.length = 0;
    this.damageMarks.length = 0;
    this.banners.length = 0;
    this.damageNumbers.length = 0;
    this.dom.killfeed.innerHTML = '';
  }
}
