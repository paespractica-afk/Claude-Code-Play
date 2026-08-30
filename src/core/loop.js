// Fixed-timestep simulation with an interpolated render step.
// Simulation never sees a variable dt, so movement and AI stay deterministic
// and a hitching tab can't launch the player through a wall.

export class GameLoop {
  constructor({ step = 1 / 120, maxFrame = 0.25, update, render }) {
    this.step = step;
    this.maxFrame = maxFrame;
    this.update = update;
    this.render = render;
    this.accumulator = 0;
    this.last = 0;
    this.running = false;
    this.time = 0;
    this.frame = 0;
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.accumulator = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    let frameTime = (now - this.last) / 1000;
    this.last = now;
    if (!Number.isFinite(frameTime) || frameTime < 0) frameTime = 0;
    // Clamp so returning to a backgrounded tab doesn't simulate ten seconds at once.
    if (frameTime > this.maxFrame) frameTime = this.maxFrame;

    this._fpsAccum += frameTime;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.25) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this.accumulator += frameTime;
    let steps = 0;
    while (this.accumulator >= this.step && steps < 8) {
      this.update(this.step, this.time);
      this.time += this.step;
      this.accumulator -= this.step;
      steps++;
    }
    // If we blew the step budget, drop the backlog rather than spiralling.
    if (steps === 8) this.accumulator = 0;

    this.frame++;
    this.render(frameTime, this.accumulator / this.step);
  }
}
