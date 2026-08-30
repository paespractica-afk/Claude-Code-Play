// Headless smoke test: boots the game in a real browser, starts a match in
// every mode on every map, drives input, and fails on any console error.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:8931';
const MODES = process.env.SMOKE_MODES?.split(',') || ['deathmatch'];
const MAPS = process.env.SMOKE_MAPS?.split(',') || ['foundry'];
const SECONDS = Number(process.env.SMOKE_SECONDS || 6);
const SHOT = process.env.SMOKE_SHOT;

const errors = [];
const warnings = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.SMOKE_W || 960), height: Number(process.env.SMOKE_H || 540) } });

page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t);
  else if (m.type() === 'warning' && !/deprecat|GPU stall|Automatic fallback/i.test(t)) warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });

// Wait for the loader to finish and the main menu to appear.
await page.waitForFunction(() => window.__game && window.__game.menu.screen === 'main', { timeout: 90000 });
console.log('✓ booted to main menu');
if (!process.env.SMOKE_KEEP_QUALITY) {
  await page.evaluate(() => {
    window.__game.settings.quality = 'low';
    window.__game.applySettings();
  });
}

const fatal = await page.$('.fatal');
if (fatal) { errors.push('fatal panel shown: ' + await page.textContent('.fatal-panel')); }

for (const map of MAPS) {
  for (const mode of MODES) {
    const label = `${mode} @ ${map}`;
    const before = errors.length;
    const t0 = Date.now();

    await page.evaluate(async ({ mode, map }) => {
      const g = window.__game;
      await g.startMatch({
        mode, map, difficulty: 'veteran', botCount: 9,
        loadout: ['kestrel', 'sidewinder', 'knife'],
      });
      // Pointer lock can't be granted headlessly, so drive the sim directly.
      g.paused = false;
    }, { mode, map });

    await page.waitForFunction(() => window.__game.running === true, { timeout: 60000 });
    const loadMs = Date.now() - t0;

    // Drive the player: move, look, shoot, reload, throw, crouch, swap.
    await page.evaluate((seconds) => new Promise((resolve) => {
      const g = window.__game;
      const inp = g.input;
      const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ControlLeft', 'Space', 'KeyR', 'KeyG', 'KeyQ', 'KeyT', 'KeyF', 'KeyV'];
      let t = 0;
      const iv = setInterval(() => {
        t += 0.05;
        inp.keys.clear();
        // Rotating input pattern so every code path gets exercised.
        const k = keys[Math.floor(t * 2) % keys.length];
        inp.keys.add(k);
        if (Math.floor(t) % 3 === 0) inp.keys.add('KeyW');
        inp.mouse.left = Math.floor(t * 2) % 3 !== 0;
        inp.mouse.right = Math.floor(t * 3) % 5 === 0;
        inp.mouse.dx += Math.sin(t * 1.7) * 30;
        inp.mouse.dy += Math.cos(t * 2.3) * 12;
        if (Math.abs(t % 4) < 0.06) inp.pressedThisFrame.add('Digit2');
        if (Math.abs((t + 2) % 4) < 0.06) inp.pressedThisFrame.add('Digit1');
        if (t >= seconds) { clearInterval(iv); inp.keys.clear(); inp.mouse.left = false; resolve(); }
      }, 50);
    }), SECONDS);

    // Software GL caps the render loop, which starves the fixed-step sim.
    // Step the simulation directly so the AI actually gets time to play.
    const simSeconds = Number(process.env.SMOKE_SIM || 25);
    const simStats = await page.evaluate((seconds) => {
      const g = window.__game;
      // Pointer lock is impossible headlessly and auto-pauses the match.
      g.paused = false;
      const step = 1 / 120;
      const t0 = performance.now();
      let ticks = 0;
      const inp = g.input;
      for (let t = 0; t < seconds; t += step) {
        inp.keys.clear();
        if (Math.floor(t * 2) % 4 !== 0) inp.keys.add('KeyW');
        if (Math.floor(t) % 5 === 0) inp.keys.add('KeyD');
        if (Math.floor(t) % 7 === 0) inp.keys.add('ShiftLeft');
        inp.mouse.left = Math.floor(t * 3) % 4 !== 0;
        inp.mouse.dx += Math.sin(t * 2.1) * 3;
        g.fixedUpdate(step);
        inp.endFrame();
        ticks++;
      }
      return { ticks, ms: Math.round(performance.now() - t0) };
    }, simSeconds);
    console.log(`    simulated ${simSeconds}s in ${simStats.ms}ms (${(simStats.ticks / (simStats.ms / 1000)).toFixed(0)} ticks/s)`);

    const stats = await page.evaluate(() => {
      const g = window.__game;
      const alive = g.damageables.filter((e) => e.alive).length;
      const kills = g.damageables.reduce((s, e) => s + (e.kills || 0), 0);
      const moved = g.agents.filter((a) => !a.isPlayer && a.moveSpeed > 0.3).length;
      const paths = g.agents.filter((a) => !a.isPlayer && a.path).length;
      const engaging = g.agents.filter((a) => !a.isPlayer && a.target).length;
      const actions = {};
      for (const a of g.agents) if (!a.isPlayer) actions[a.action] = (actions[a.action] || 0) + 1;
      return {
        fps: Math.round(g.loop.fps), alive, kills, moved, paths, engaging,
        draws: g.render.sceneDrawCalls || 0,
        tris: g.render.sceneTriangles || 0,
        actions,
        playerAlive: g.player.alive,
        playerPos: [g.player.pos.x.toFixed(1), g.player.pos.y.toFixed(1), g.player.pos.z.toFixed(1)].join(','),
        decals: g.effects.decals.used,
      };
    });

    const newErrors = errors.length - before;
    const ok = newErrors === 0;
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(26)} load ${String(loadMs).padStart(5)}ms  ${stats.fps} fps  ${stats.draws} draws  ${(stats.tris / 1000).toFixed(0)}k tris  kills ${stats.kills}  alive ${stats.alive}  moving ${stats.moved}  paths ${stats.paths}  engaging ${stats.engaging}`);
    console.log(`    AI actions: ${Object.entries(stats.actions).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);

    if (SHOT) {
      await page.screenshot({ path: `${SHOT}/${mode}-${map}.png` });
    }

    await page.evaluate(() => window.__game.quitToMenu());
    await page.waitForTimeout(200);
  }
}

await browser.close();

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of [...new Set(warnings)].slice(0, 8)) console.log('  ! ' + w.slice(0, 220));
}
if (errors.length) {
  console.log(`\n${errors.length} ERROR(S):`);
  for (const e of [...new Set(errors)].slice(0, 14)) console.log('  ✗ ' + e.slice(0, 700));
  process.exit(1);
}
console.log('\nAll checks passed.');
