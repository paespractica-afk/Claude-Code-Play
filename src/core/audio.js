// Fully synthesised audio — no sample files, so the game boots instantly and works offline.
// Every gunshot is layered: a transient crack, a noise body, a low-end thump and a room tail.

import { clamp, rand, lerp } from './math.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.buffers = {};
    this.volume = { master: 0.8, sfx: 1.0, music: 0.35 };
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this._voices = 0;
    this._maxVoices = 48;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch { return; }
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume.master;

    // A gentle limiter keeps a 6-gun firefight from clipping into distortion.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.volume.sfx;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volume.music;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.9, 2.6, 0.32);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.28;

    this.sfxBus.connect(this.limiter);
    this.sfxBus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.limiter);
    this.musicBus.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    this.buffers.white = this._noise(2.0, 'white');
    this.buffers.pink = this._noise(2.0, 'pink');

    this.ready = true;
  }

  setVolumes(v) {
    Object.assign(this.volume, v);
    if (!this.ready) return;
    this.master.gain.value = clamp(this.volume.master, 0, 1);
    this.sfxBus.gain.value = clamp(this.volume.sfx, 0, 1.4);
    this.musicBus.gain.value = clamp(this.volume.music, 0, 1);
  }

  setReverb(amount, size = 2.0) {
    if (!this.ready) return;
    this.reverbSend.gain.value = clamp(amount, 0, 1);
    this.reverb.buffer = this._impulse(size, 2.6, 0.3);
  }

  _noise(seconds, kind) {
    const ctx = this.ctx;
    const len = (ctx.sampleRate * seconds) | 0;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  _impulse(seconds, decay, diffusion) {
    const ctx = this.ctx;
    const len = Math.max(1, (ctx.sampleRate * seconds) | 0);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Sparse early reflections then a smooth exponential tail.
        const early = i < ctx.sampleRate * 0.09 && Math.random() < diffusion ? 1.6 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  }

  _budget() {
    if (this._voices >= this._maxVoices) return false;
    this._voices++;
    return true;
  }
  _freeIn(seconds) {
    setTimeout(() => { this._voices = Math.max(0, this._voices - 1); }, seconds * 1000 + 60);
  }

  /** Build a 3D-positioned output node, or a plain gain for 2D sounds. */
  _out(pos, refDistance = 6, maxDistance = 140) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = refDistance;
      p.maxDistance = maxDistance;
      p.rolloffFactor = 1.1;
      if (p.positionX) {
        p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      } else p.setPosition(pos.x, pos.y, pos.z);
      g.connect(p);
      p.connect(this.sfxBus);
    } else {
      g.connect(this.sfxBus);
    }
    return g;
  }

  updateListener(pos, forward, up) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(pos.x, t, 0.01);
      l.positionY.setTargetAtTime(pos.y, t, 0.01);
      l.positionZ.setTargetAtTime(pos.z, t, 0.01);
      l.forwardX.setTargetAtTime(forward.x, t, 0.01);
      l.forwardY.setTargetAtTime(forward.y, t, 0.01);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.01);
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
    this.listenerPos = pos;
  }

  _burst(dest, when, dur, filterType, freq, q, gain, curve = 3) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.white;
    src.playbackRate.value = rand(0.92, 1.08);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.0016);
    g.gain.setTargetAtTime(0.0001, when + 0.0016, dur / curve);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(when, rand(0, 1.5));
    src.stop(when + dur + 0.05);
    return g;
  }

  _tone(dest, when, dur, type, f0, f1, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + dur + 0.02);
    return g;
  }

  /**
   * Gunshot. `profile` shapes the character: punchy pistol, sharp rifle,
   * broad shotgun, deep sniper, tight SMG.
   */
  shot(pos, profile = {}) {
    if (!this.ready || !this._budget()) return;
    const {
      body = 1600, bodyQ = 0.8, tail = 0.32, thump = 90,
      level = 0.9, crack = 5200, snap = 0.05, suppressed = false,
    } = profile;
    const t = this.ctx.currentTime;
    const out = this._out(pos, 8, 190);
    out.gain.value = level;

    if (suppressed) {
      this._burst(out, t, 0.09, 'lowpass', 900, 0.7, 0.55);
      this._tone(out, t, 0.08, 'sine', 220, 90, 0.22);
      this._burst(out, t + 0.005, 0.05, 'bandpass', 2400, 2, 0.12);
    } else {
      this._burst(out, t, snap, 'highpass', crack, 0.6, 0.85);          // transient crack
      this._burst(out, t + 0.002, tail * 0.55, 'bandpass', body, bodyQ, 0.7); // body
      this._burst(out, t + 0.01, tail, 'lowpass', 480, 0.5, 0.5, 2.2);  // room tail
      this._tone(out, t, 0.11, 'sine', thump * 2.4, thump * 0.6, 0.5);  // low-end punch
    }
    this._freeIn(tail + 0.2);
  }

  impact(pos, material = 'concrete') {
    if (!this.ready || !this._budget()) return;
    const t = this.ctx.currentTime;
    const out = this._out(pos, 4, 60);
    const cfg = {
      concrete: { f: 2600, q: 1.2, d: 0.09, g: 0.5, tone: 0 },
      metal: { f: 5200, q: 6, d: 0.22, g: 0.42, tone: 3100 },
      wood: { f: 1500, q: 1.4, d: 0.1, g: 0.42, tone: 0 },
      dirt: { f: 800, q: 0.7, d: 0.12, g: 0.34, tone: 0 },
      glass: { f: 7200, q: 5, d: 0.3, g: 0.4, tone: 5400 },
      flesh: { f: 700, q: 0.9, d: 0.08, g: 0.6, tone: 0 },
      water: { f: 1200, q: 1.0, d: 0.16, g: 0.3, tone: 0 },
    }[material] || { f: 2400, q: 1, d: 0.1, g: 0.4, tone: 0 };
    this._burst(out, t, cfg.d, 'bandpass', cfg.f * rand(0.85, 1.15), cfg.q, cfg.g);
    if (cfg.tone) this._tone(out, t, cfg.d * 1.4, 'triangle', cfg.tone * rand(0.8, 1.25), cfg.tone * 0.4, 0.1);
    this._freeIn(cfg.d + 0.1);
  }

  /** Short mechanical click family — reload steps, safety, mag seat, bolt. */
  mech(pos, kind = 'click', level = 0.5) {
    if (!this.ready || !this._budget()) return;
    const t = this.ctx.currentTime;
    const out = this._out(pos, 3, 34);
    out.gain.value = level;
    const spec = {
      click: [[3200, 4, 0.03, 0.5]],
      magOut: [[900, 2, 0.06, 0.45], [2600, 5, 0.03, 0.3]],
      magIn: [[420, 1.4, 0.09, 0.6], [1800, 3, 0.04, 0.35]],
      bolt: [[1400, 2.5, 0.05, 0.55], [3600, 6, 0.05, 0.35]],
      dryFire: [[2400, 8, 0.035, 0.5]],
      pinPull: [[2800, 6, 0.04, 0.4]],
      switch: [[1900, 5, 0.03, 0.4]],
    }[kind] || [[2000, 3, 0.04, 0.4]];
    for (const [f, q, d, g] of spec) this._burst(out, t + rand(0, 0.012), d, 'bandpass', f * rand(0.9, 1.1), q, g);
    this._freeIn(0.2);
  }

  step(pos, surface = 'concrete', level = 0.35) {
    if (!this.ready || !this._budget()) return;
    const t = this.ctx.currentTime;
    const out = this._out(pos, 2.5, 30);
    out.gain.value = level;
    const cfg = {
      concrete: [1500, 1.2, 0.07],
      metal: [3400, 3.5, 0.11],
      dirt: [520, 0.8, 0.09],
      wood: [1100, 1.6, 0.08],
      water: [900, 0.9, 0.14],
    }[surface] || [1400, 1.2, 0.07];
    this._burst(out, t, cfg[2], 'bandpass', cfg[0] * rand(0.85, 1.2), cfg[1], 0.55);
    this._tone(out, t, 0.05, 'sine', 150, 70, 0.14);
    this._freeIn(0.25);
  }

  /** UI / feedback beeps — 2D, never positional. */
  ui(kind = 'click') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._out(null);
    const map = {
      click: () => this._tone(out, t, 0.05, 'square', 900, 600, 0.09),
      hover: () => this._tone(out, t, 0.03, 'sine', 1400, 1400, 0.05),
      hit: () => this._tone(out, t, 0.045, 'square', 1750, 1300, 0.14),
      headshot: () => { this._tone(out, t, 0.07, 'square', 2600, 1900, 0.16); this._tone(out, t + 0.03, 0.09, 'sine', 3400, 2400, 0.1); },
      kill: () => { this._tone(out, t, 0.09, 'triangle', 880, 1320, 0.16); this._tone(out, t + 0.06, 0.14, 'triangle', 1320, 1760, 0.13); },
      hurt: () => { this._tone(out, t, 0.16, 'sawtooth', 180, 70, 0.14); this._burst(out, t, 0.1, 'lowpass', 700, 1, 0.25); },
      lowAmmo: () => this._tone(out, t, 0.05, 'square', 2200, 2200, 0.06),
      objective: () => { this._tone(out, t, 0.16, 'sine', 520, 780, 0.16); this._tone(out, t + 0.13, 0.22, 'sine', 780, 1040, 0.14); },
      alarm: () => { this._tone(out, t, 0.3, 'sawtooth', 440, 300, 0.1); this._tone(out, t + 0.32, 0.3, 'sawtooth', 440, 300, 0.1); },
      win: () => [0, 0.12, 0.24, 0.42].forEach((d, i) => this._tone(out, t + d, 0.3, 'triangle', [523, 659, 784, 1047][i], [523, 659, 784, 1047][i], 0.13)),
      lose: () => [0, 0.16, 0.34].forEach((d, i) => this._tone(out, t + d, 0.4, 'triangle', [392, 330, 262][i], [392, 330, 262][i], 0.13)),
      levelUp: () => [0, 0.08, 0.16].forEach((d, i) => this._tone(out, t + d, 0.2, 'square', [660, 880, 1320][i], [660, 880, 1320][i], 0.1)),
    };
    (map[kind] || map.click)();
  }

  /** Supersonic round passing near the player's head. Sells incoming fire. */
  whizz(pos, speed = 1) {
    if (!this.ready || !this._budget()) return;
    const t = this.ctx.currentTime;
    const out = this._out(pos, 3, 26);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.white;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3.5;
    f.frequency.setValueAtTime(3400 * speed, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.16);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.36, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t, rand(0, 1)); src.stop(t + 0.25);
    this._freeIn(0.3);
  }

  explosion(pos, power = 1) {
    if (!this.ready || !this._budget()) return;
    const t = this.ctx.currentTime;
    const out = this._out(pos, 14, 260);
    out.gain.value = 1.1;
    this._burst(out, t, 0.06, 'highpass', 4000, 0.7, 0.8);
    this._burst(out, t + 0.005, 0.9 * power, 'lowpass', 340, 0.6, 0.95, 2.4);
    this._tone(out, t, 0.5 * power, 'sine', 120, 28, 0.9);
    this._burst(out, t + 0.03, 1.3 * power, 'bandpass', 220, 0.5, 0.35, 2.6);
    this._freeIn(1.6);
  }

  /** Ambient bed — a slow drone plus air movement. Started once per match. */
  startAmbience(tone = 62) {
    if (!this.ready || this._amb) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.05, ctx.currentTime, 2.5);
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = tone;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = tone * 1.5 + 0.4;
    const air = ctx.createBufferSource(); air.buffer = this.buffers.pink; air.loop = true;
    const af = ctx.createBiquadFilter(); af.type = 'lowpass'; af.frequency.value = 420;
    const ag = ctx.createGain(); ag.gain.value = 0.05;
    o1.connect(g); o2.connect(g); air.connect(af); af.connect(ag); ag.connect(g);
    g.connect(this.musicBus);
    o1.start(); o2.start(); air.start();
    this._amb = { g, nodes: [o1, o2, air] };
  }

  stopAmbience() {
    if (!this._amb) return;
    const { g, nodes } = this._amb;
    this._amb = null;
    try {
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
      setTimeout(() => nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } }), 1200);
    } catch { /* context closed */ }
  }

  /** Muffled, ringing ears after a nearby blast. */
  concuss(seconds = 2.2) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.setTargetAtTime(20000, t + seconds * 0.4, seconds * 0.35);
    try {
      this.sfxBus.disconnect();
      this.sfxBus.connect(f);
      f.connect(this.limiter);
      this.sfxBus.connect(this.reverbSend);
    } catch { return; }
    const ring = this._tone(this._out(null), t, seconds, 'sine', 4200, 3600, 0.06);
    setTimeout(() => {
      try {
        this.sfxBus.disconnect();
        this.sfxBus.connect(this.limiter);
        this.sfxBus.connect(this.reverbSend);
        f.disconnect();
      } catch { /* ignore */ }
    }, seconds * 1000 + 200);
    return ring;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}

export const audio = new AudioEngine();
