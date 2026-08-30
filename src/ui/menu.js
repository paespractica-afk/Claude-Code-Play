// Front-end: main menu, loadout, settings, pause, match summary and the
// Firefight between-wave shop. Pure DOM — the 3D scene keeps rendering behind
// it as a live backdrop.

import { MODES } from '../modes/modes.js';
import { WEAPONS, PRIMARIES, SECONDARIES } from '../weapons/defs.js';
import { DEFAULTS } from '../core/settings.js';
import { clamp } from '../core/math.js';

const DIFFICULTIES = [
  { id: 'recruit', name: 'RECRUIT', blurb: 'Slow to react, sloppy aim, forgiving.' },
  { id: 'regular', name: 'REGULAR', blurb: 'Competent. Uses cover and trades.' },
  { id: 'veteran', name: 'VETERAN', blurb: 'Fast, disciplined bursts, real flanks.' },
  { id: 'elite', name: 'ELITE', blurb: 'Punishing reactions and squad play.' },
];

export class Menu {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'menu';
    root.appendChild(this.el);
    this.screen = 'main';
    this.onStart = null;
    this.config = {
      mode: 'deathmatch',
      map: 'foundry',
      difficulty: 'regular',
      botCount: 9,
      loadout: ['kestrel', 'sidewinder', 'knife'],
    };
    this._settingsDirty = false;
  }

  get settings() { return this.game.settings; }

  show(screen = 'main', data = null) {
    this.screen = screen;
    this.data = data;
    this.el.style.display = '';
    this.render();
  }

  hide() {
    this.el.style.display = 'none';
    this.screen = null;
  }

  get visible() { return this.el.style.display !== 'none' && this.screen !== null; }

  render() {
    const s = this.screen;
    if (s === 'main') this._renderMain();
    else if (s === 'loadout') this._renderLoadout();
    else if (s === 'settings') this._renderSettings();
    else if (s === 'pause') this._renderPause();
    else if (s === 'summary') this._renderSummary();
    else if (s === 'shop') this._renderShop();
    else if (s === 'loading') this._renderLoading();
    else if (s === 'controls') this._renderControls();
  }

  /* ----------------------------------------------------------------- main -- */

  _renderMain() {
    const c = this.config;
    const maps = this.game.mapList;
    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-panel wide">
        <header class="brand">
          <div class="brand-mark">BLACKSITE</div>
          <div class="brand-sub">TACTICAL ENGAGEMENT SIMULATOR</div>
        </header>

        <section class="pick-row">
          <h3>MODE</h3>
          <div class="cards" id="mode-cards">
            ${Object.values(MODES).map((m) => `
              <button class="card ${c.mode === m.id ? 'on' : ''}" data-mode="${m.id}">
                <span class="card-title">${m.name}</span>
                <span class="card-blurb">${m.blurb}</span>
              </button>`).join('')}
          </div>
        </section>

        <section class="pick-row">
          <h3>MAP</h3>
          <div class="cards" id="map-cards">
            ${maps.map((m) => `
              <button class="card map ${c.map === m.id ? 'on' : ''}" data-map="${m.id}">
                <span class="card-title">${m.name}</span>
                <span class="card-blurb">${m.subtitle}</span>
                <span class="card-tag">${m.size}</span>
              </button>`).join('')}
          </div>
        </section>

        <section class="pick-row split">
          <div>
            <h3>AI SKILL</h3>
            <div class="chips" id="diff-chips">
              ${DIFFICULTIES.map((d) => `<button class="chip ${c.difficulty === d.id ? 'on' : ''}" data-diff="${d.id}" title="${d.blurb}">${d.name}</button>`).join('')}
            </div>
            <p class="hint" id="diff-hint">${DIFFICULTIES.find((d) => d.id === c.difficulty).blurb}</p>
          </div>
          <div>
            <h3>OPPONENTS <span class="val" id="bot-val">${c.botCount}</span></h3>
            <input type="range" id="bot-range" min="1" max="15" value="${c.botCount}">
            <p class="hint">Total combatants filling both squads.</p>
          </div>
        </section>

        <footer class="menu-actions">
          <button class="btn ghost" data-goto="loadout">LOADOUT</button>
          <button class="btn ghost" data-goto="settings">SETTINGS</button>
          <button class="btn ghost" data-goto="controls">CONTROLS</button>
          <button class="btn primary" id="deploy">DEPLOY</button>
        </footer>
      </div>`;

    this.el.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
      c.mode = b.dataset.mode;
      // Firefight is a solo survival mode; force a sensible opponent count.
      if (c.mode === 'firefight') c.botCount = 12;
      this.render();
    });
    this.el.querySelectorAll('[data-map]').forEach((b) => b.onclick = () => { c.map = b.dataset.map; this.render(); });
    this.el.querySelectorAll('[data-diff]').forEach((b) => b.onclick = () => { c.difficulty = b.dataset.diff; this.render(); });
    const range = this.el.querySelector('#bot-range');
    range.oninput = () => {
      c.botCount = parseInt(range.value, 10);
      this.el.querySelector('#bot-val').textContent = c.botCount;
    };
    this.el.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => this.show(b.dataset.goto));
    this.el.querySelector('#deploy').onclick = () => this.onStart?.({ ...c });
  }

  /* -------------------------------------------------------------- loadout -- */

  _renderLoadout() {
    const c = this.config;
    const card = (id, slotIndex) => {
      const w = WEAPONS[id];
      const on = c.loadout[slotIndex] === id;
      const dmg = w.damage[0][1];
      const stat = (label, v, max) => `
        <div class="stat"><span>${label}</span><i><b style="width:${clamp(v / max * 100, 3, 100)}%"></b></i></div>`;
      return `
        <button class="wcard ${on ? 'on' : ''}" data-weapon="${id}" data-slot="${slotIndex}">
          <div class="wcard-head">
            <span class="wname">${w.name}</span>
            <span class="wclass">${w.class}</span>
          </div>
          <div class="wstats">
            ${stat('DMG', dmg, 60)}
            ${stat('RPM', w.rpm, 1000)}
            ${stat('MAG', w.mag === Infinity ? 0 : w.mag, 75)}
            ${stat('ADS', 1 / w.adsTime, 6)}
          </div>
          <div class="wfull">${w.fullName}</div>
        </button>`;
    };

    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-panel wide">
        <header class="brand small"><div class="brand-mark">LOADOUT</div></header>
        <section class="pick-row">
          <h3>PRIMARY</h3>
          <div class="cards wgrid">${PRIMARIES.map((id) => card(id, 0)).join('')}</div>
        </section>
        <section class="pick-row">
          <h3>SIDEARM</h3>
          <div class="cards wgrid">${SECONDARIES.map((id) => card(id, 1)).join('')}</div>
        </section>
        <p class="hint">A combat knife is always carried in the third slot. V for a quick melee.</p>
        <footer class="menu-actions">
          <button class="btn ghost" data-goto="main">BACK</button>
        </footer>
      </div>`;

    this.el.querySelectorAll('[data-weapon]').forEach((b) => b.onclick = () => {
      c.loadout[parseInt(b.dataset.slot, 10)] = b.dataset.weapon;
      this.render();
    });
    this.el.querySelector('[data-goto]').onclick = () => this.show('main');
  }

  /* ------------------------------------------------------------- settings -- */

  _renderSettings() {
    const s = this.settings;
    const slider = (key, label, min, max, step, fmt = (v) => v) => `
      <label class="setting">
        <span>${label}</span>
        <input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}">
        <em data-val="${key}">${fmt(s[key])}</em>
      </label>`;
    const toggle = (key, label) => `
      <label class="setting toggle">
        <span>${label}</span>
        <input type="checkbox" data-toggle="${key}" ${s[key] ? 'checked' : ''}>
        <i></i>
      </label>`;
    const choice = (key, label, options) => `
      <label class="setting">
        <span>${label}</span>
        <div class="chips small">
          ${options.map((o) => `<button class="chip ${s[key] === o ? 'on' : ''}" data-choice="${key}" data-value="${o}">${String(o).toUpperCase()}</button>`).join('')}
        </div>
      </label>`;

    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-panel">
        <header class="brand small"><div class="brand-mark">SETTINGS</div></header>
        <div class="settings-cols">
          <section>
            <h3>AIM</h3>
            ${slider('sensitivity', 'Sensitivity', 0.05, 1.5, 0.01, (v) => (+v).toFixed(2))}
            ${slider('adsSensScale', 'ADS multiplier', 0.3, 1.2, 0.01, (v) => (+v).toFixed(2))}
            ${slider('fov', 'Field of view', 70, 115, 1, (v) => `${v}°`)}
            ${toggle('invertY', 'Invert vertical')}
            ${toggle('toggleAds', 'Toggle aim')}
            ${toggle('toggleCrouch', 'Toggle crouch')}
            ${toggle('autoSprint', 'Auto sprint')}
          </section>
          <section>
            <h3>VIDEO</h3>
            ${choice('quality', 'Quality', ['low', 'medium', 'high', 'ultra'])}
            ${toggle('bloom', 'Bloom')}
            ${toggle('filmGrain', 'Film grain')}
            ${toggle('chromaticAberration', 'Chromatic aberration')}
            ${toggle('vignette', 'Vignette')}
            ${toggle('showFps', 'Performance overlay')}
          </section>
          <section>
            <h3>FEEL</h3>
            ${slider('viewBob', 'View bob', 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`)}
            ${slider('cameraShake', 'Camera shake', 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`)}
            ${slider('weaponSway', 'Weapon sway', 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`)}
            ${choice('crosshairStyle', 'Crosshair', ['dynamic', 'static'])}
            ${toggle('hitmarkers', 'Hit markers')}
            ${toggle('damageNumbers', 'Damage numbers')}
          </section>
          <section>
            <h3>AUDIO</h3>
            ${slider('volumeMaster', 'Master', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
            ${slider('volumeSfx', 'Effects', 0, 1.4, 0.01, (v) => `${Math.round(v * 100)}%`)}
            ${slider('volumeMusic', 'Ambience', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
          </section>
        </div>
        <footer class="menu-actions">
          <button class="btn ghost" id="reset">RESET DEFAULTS</button>
          <button class="btn primary" data-goto="back">DONE</button>
        </footer>
      </div>`;

    this.el.querySelectorAll('[data-set]').forEach((inp) => {
      inp.oninput = () => {
        const key = inp.dataset.set;
        s[key] = parseFloat(inp.value);
        const out = this.el.querySelector(`[data-val="${key}"]`);
        if (out) {
          out.textContent = key === 'fov' ? `${s[key]}°`
            : key.startsWith('volume') || ['viewBob', 'cameraShake', 'weaponSway'].includes(key) ? `${Math.round(s[key] * 100)}%`
              : s[key].toFixed(2);
        }
        this.game.applySettings();
      };
    });
    this.el.querySelectorAll('[data-toggle]').forEach((inp) => {
      inp.onchange = () => { s[inp.dataset.toggle] = inp.checked; this.game.applySettings(); };
    });
    this.el.querySelectorAll('[data-choice]').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.value;
        s[b.dataset.choice] = v;
        this.game.applySettings();
        this.render();
      };
    });
    this.el.querySelector('#reset').onclick = () => {
      Object.assign(s, DEFAULTS);
      this.game.applySettings();
      this.render();
    };
    this.el.querySelector('[data-goto]').onclick = () => {
      this.game.saveSettings();
      this.show(this.game.running ? 'pause' : 'main');
    };
  }

  /* ------------------------------------------------------------- controls -- */

  _renderControls() {
    const rows = [
      ['W A S D', 'Move'], ['SHIFT', 'Sprint'], ['CTRL / C', 'Crouch'], ['SPACE', 'Jump'],
      ['MOUSE 1', 'Fire'], ['MOUSE 2', 'Aim down sights'], ['R', 'Reload'], ['V', 'Quick melee'],
      ['G', 'Cook and throw grenade'], ['1 2 3', 'Weapon slots'], ['Q', 'Swap to last weapon'],
      ['MOUSE WHEEL', 'Cycle weapons'], ['F / E', 'Plant, defuse, interact'], ['T', 'Inspect weapon'],
      ['TAB', 'Scoreboard'], ['ESC', 'Pause'],
    ];
    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-panel">
        <header class="brand small"><div class="brand-mark">CONTROLS</div></header>
        <div class="controls-grid">
          ${rows.map(([k, v]) => `<div class="ctrl"><kbd>${k}</kbd><span>${v}</span></div>`).join('')}
        </div>
        <p class="hint">Spray patterns are fixed per weapon — learn one and pull against it. Firing while moving or airborne widens your cone dramatically.</p>
        <footer class="menu-actions">
          <button class="btn primary" data-goto="back">BACK</button>
        </footer>
      </div>`;
    this.el.querySelector('[data-goto]').onclick = () => this.show(this.game.running ? 'pause' : 'main');
  }

  /* ---------------------------------------------------------------- pause -- */

  _renderPause() {
    this.el.innerHTML = `
      <div class="menu-bg dim"></div>
      <div class="menu-panel narrow">
        <header class="brand small"><div class="brand-mark">PAUSED</div></header>
        <div class="stack">
          <button class="btn primary" id="resume">RESUME</button>
          <button class="btn ghost" data-goto="settings">SETTINGS</button>
          <button class="btn ghost" data-goto="controls">CONTROLS</button>
          <button class="btn danger" id="quit">ABANDON MATCH</button>
        </div>
      </div>`;
    this.el.querySelector('#resume').onclick = () => this.game.resume();
    this.el.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => this.show(b.dataset.goto));
    this.el.querySelector('#quit').onclick = () => this.game.quitToMenu();
  }

  /* -------------------------------------------------------------- summary -- */

  _renderSummary() {
    const d = this.data || {};
    const won = d.winner === d.playerTeam;
    const draw = d.winner === -1;
    const rows = (d.entities || [])
      .slice()
      .sort((a, b) => (b.kills - b.deaths) - (a.kills - a.deaths) || b.kills - a.kills)
      .map((e, i) => `<tr class="${e.isPlayer ? 'me' : ''}">
        <td>${i + 1}</td><td class="nm">${e.name}</td>
        <td>${e.kills}</td><td>${e.deaths}</td>
        <td>${(e.kills / Math.max(1, e.deaths)).toFixed(2)}</td>
      </tr>`).join('');

    this.el.innerHTML = `
      <div class="menu-bg dim"></div>
      <div class="menu-panel">
        <header class="brand">
          <div class="brand-mark ${draw ? '' : won ? 'win' : 'lose'}">${draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}</div>
          <div class="brand-sub">${d.modeName || ''} · ${d.mapName || ''}</div>
        </header>
        <div class="summary-score">${(d.scores || [0, 0]).join('  —  ')}</div>
        <table class="summary-table">
          <tr><th>#</th><th>OPERATOR</th><th>K</th><th>D</th><th>K/D</th></tr>
          ${rows}
        </table>
        <footer class="menu-actions">
          <button class="btn primary" id="again">PLAY AGAIN</button>
          <button class="btn ghost" id="menu">MAIN MENU</button>
        </footer>
      </div>`;
    this.el.querySelector('#again').onclick = () => this.onStart?.({ ...this.config });
    this.el.querySelector('#menu').onclick = () => this.show('main');
  }

  /* ----------------------------------------------------------------- shop -- */

  _renderShop() {
    const m = this.data.mode;
    const items = [
      { id: 'health', name: 'ARMOUR PLATING', desc: '+25 maximum health, fully restored.', cost: 250 },
      { id: 'ammo', name: 'AMMUNITION CACHE', desc: 'Two extra magazines for every weapon.', cost: 150 },
      { id: 'damage', name: 'MATCH GRADE ROUNDS', desc: 'Permanent damage increase.', cost: 350 },
      { id: 'speed', name: 'LIGHTWEIGHT RIG', desc: 'Move faster and swap weapons quicker.', cost: 200 },
    ];
    this.el.innerHTML = `
      <div class="menu-bg dim"></div>
      <div class="menu-panel">
        <header class="brand small">
          <div class="brand-mark">REARM</div>
          <div class="brand-sub">WAVE ${m.wave} CLEARED · ${m.credits} CREDITS</div>
        </header>
        <div class="shop-grid">
          ${items.map((it) => {
            const owned = m.perks[it.id] ?? 0;
            const cost = Math.round(it.cost * (1 + owned * 0.6));
            const afford = m.credits >= cost;
            return `<button class="shop-item ${afford ? '' : 'poor'}" data-buy="${it.id}">
              <span class="shop-name">${it.name}</span>
              <span class="shop-desc">${it.desc}</span>
              <span class="shop-foot"><em>${owned > 0 ? `OWNED ×${owned}` : ''}</em><b>${cost} CR</b></span>
            </button>`;
          }).join('')}
        </div>
        <footer class="menu-actions">
          <button class="btn primary" id="ready">BACK TO THE FIGHT</button>
        </footer>
      </div>`;
    this.el.querySelectorAll('[data-buy]').forEach((b) => b.onclick = () => {
      if (m.buyPerk(b.dataset.buy)) this.render();
    });
    this.el.querySelector('#ready').onclick = () => this.game.resume();
  }

  /* -------------------------------------------------------------- loading -- */

  _renderLoading(progress = 0, label = 'INITIALISING') {
    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-panel narrow loading">
        <div class="brand-mark">BLACKSITE</div>
        <div class="load-bar"><i id="load-fill" style="width:${progress * 100}%"></i></div>
        <div class="load-label" id="load-label">${label}</div>
        <div class="load-tip">${LOADING_TIPS[(Math.random() * LOADING_TIPS.length) | 0]}</div>
      </div>`;
  }

  setLoading(progress, label) {
    const fill = this.el.querySelector('#load-fill');
    const lab = this.el.querySelector('#load-label');
    if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
    if (lab) lab.textContent = label;
  }
}

const LOADING_TIPS = [
  'Every weapon has a fixed spray pattern. Pull against it and the shots land where you look.',
  'Crouching tightens your cone. Standing still tightens it far more.',
  'The enemy squad shares what it sees. Kill the spotter before it reports you.',
  'Bots peek angles they have already seen you hold. Rotate after a trade.',
  'Suppressed weapons carry a fraction as far. Sound is information.',
  'Wallbangs work through thin panels. Watch for the penetration marker on impact.',
  'Cook a frag for two seconds and it lands with no time to run from.',
  'Jumping while firing multiplies your spread by four. Land first.',
];
