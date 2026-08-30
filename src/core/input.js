// Input layer: pointer lock, rebindable actions, gamepad-free but controller-friendly shape.
// Every consumer reads intents (`isDown('fire')`) rather than raw key codes.

import { clamp } from './math.js';

export const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  walk: ['AltLeft'],
  reload: ['KeyR'],
  use: ['KeyF', 'KeyE'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  swap: ['KeyQ'],
  inspect: ['KeyT'],
  scoreboard: ['Tab'],
  ping: ['KeyZ'],
};

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.binds = structuredClone(DEFAULT_BINDS);
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.mouse = { left: false, right: false, middle: false, dx: 0, dy: 0, wheel: 0 };
    this.mousePressed = { left: false, right: false, middle: false };
    this.locked = false;
    this.sensitivity = 0.0022;
    this.adsSensScale = 0.72;
    this.invertY = false;
    this.enabled = true;
    this._listeners = [];
    this._blockedKeys = new Set(['Tab', 'Space', 'ControlLeft', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    this._install();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _install() {
    this._on(window, 'keydown', (e) => {
      if (this._blockedKeys.has(e.code) && this.locked) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedThisFrame.add(e.code);
    });
    this._on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      this.releasedThisFrame.add(e.code);
    });
    this._on(this.dom, 'mousedown', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      const b = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
      this.mouse[b] = true;
      this.mousePressed[b] = true;
    });
    this._on(window, 'mouseup', (e) => {
      const b = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
      this.mouse[b] = false;
    });
    this._on(this.dom, 'contextmenu', (e) => e.preventDefault());
    this._on(window, 'wheel', (e) => { if (this.locked) this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    this._on(document, 'mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      // Chrome can deliver freak spikes right after lock; clamp them out.
      const mx = clamp(e.movementX || 0, -300, 300);
      const my = clamp(e.movementY || 0, -300, 300);
      this.mouse.dx += mx;
      this.mouse.dy += my;
    });
    this._on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this.mouse.left = this.mouse.right = this.mouse.middle = false;
      }
      this.onLockChange?.(this.locked);
    });
    this._on(document, 'pointerlockerror', () => { this.onLockChange?.(false); });
    // Losing focus mid-strafe used to leave the player sliding forever.
    this._on(window, 'blur', () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = this.mouse.middle = false;
    });
  }

  requestLock() {
    if (this.locked) return;
    const p = this.dom.requestPointerLock?.({ unadjustedMovement: true });
    // unadjustedMovement is unsupported on some platforms; fall back quietly.
    if (p && typeof p.catch === 'function') p.catch(() => { try { this.dom.requestPointerLock(); } catch { /* ignore */ } });
  }

  exitLock() { if (this.locked) document.exitPointerLock?.(); }

  isDown(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i])) return true;
    return false;
  }

  wasPressed(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) if (this.pressedThisFrame.has(codes[i])) return true;
    return false;
  }

  /** Consume accumulated look delta (radians). */
  takeLook(adsFactor = 0) {
    const scale = this.sensitivity * (1 - adsFactor * (1 - this.adsSensScale));
    const yaw = -this.mouse.dx * scale;
    const pitch = (this.invertY ? this.mouse.dy : -this.mouse.dy) * scale;
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return { yaw, pitch };
  }

  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed.left = this.mousePressed.right = this.mousePressed.middle = false;
    this.mouse.wheel = 0;
  }

  dispose() {
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
  }
}
