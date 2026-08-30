// Capture reference screenshots from fixed camera vantage points.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:8931';
const OUT = process.env.SHOT_DIR || './shots';
mkdirSync(OUT, { recursive: true });

const VIEWS = [
  { map: 'foundry', mode: 'deathmatch', name: '01-foundry-mid', from: [11, 2.0, 6.5], to: [0, 1.4, -2] },
  { map: 'foundry', mode: 'deathmatch', name: '02-foundry-catwalk', from: [-10.5, 6.3, 2], to: [6, 1.0, -6] },
  { map: 'foundry', mode: 'detonate', name: '03-foundry-siteA', from: [-17.5, 1.7, -6], to: [-31, 1.2, -14] },
  { map: 'foundry', mode: 'detonate', name: '04-foundry-long', from: [-33, 1.7, 24], to: [-33, 1.2, 2] },
  { map: 'dunes', mode: 'domination', name: '05-dunes-plaza', from: [0, 1.75, 24], to: [0, 3.2, -2] },
  { map: 'dunes', mode: 'domination', name: '06-dunes-roof', from: [0, 6.4, 7], to: [-6, 1.5, -22] },
  { map: 'dunes', mode: 'deathmatch', name: '07-dunes-road', from: [-28, 1.75, 20], to: [-28, 1.3, -22] },
  { map: 'vault', mode: 'deathmatch', name: '08-vault-atrium', from: [0, 6.3, 10.5], to: [0, 1.2, -8] },
  { map: 'vault', mode: 'deathmatch', name: '09-vault-floor', from: [8, 1.75, 9], to: [-4, 1.6, -6] },
  { map: 'vault', mode: 'gungame', name: '10-vault-ring', from: [-19, 1.75, 13], to: [-19, 1.4, -12] },
  { map: 'foundry', mode: 'deathmatch', name: '11-weapon-kestrel', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'kestrel', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '12-weapon-ads', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'kestrel', ads: true, showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '13-weapon-shrike', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'shrike', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '14-weapon-breaker', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'breaker', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '15-weapon-sidewinder', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'sidewinder', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '16-weapon-vector', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'vector', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '17-weapon-havoc', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'havoc', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '18-weapon-knife', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'knife', showcase: true },
  { map: 'foundry', mode: 'deathmatch', name: '19-weapon-ingame', from: [0, 1.75, 20], to: [0, 1.6, 8], weapon: 'warden' },
];

/** Convert a from/to pair into the engine's yaw/pitch convention. */
function look(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const flat = Math.hypot(dx, dz) || 1e-6;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, flat) };
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1152, height: 648 } });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.menu.screen === 'main', { timeout: 90000 });

// Menu shot first.
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/00-menu.png` });
console.log('✓ 00-menu.png');

let last = null;
const only = process.env.SHOT_ONLY ? process.env.SHOT_ONLY.split(',') : null;
for (const v of VIEWS) {
  if (only && !only.some((o) => v.name.includes(o))) continue;
  if (last !== `${v.map}:${v.mode}`) {
    await page.evaluate(async ({ mode, map }) => {
      const g = window.__game;
      if (g.running) g.quitToMenu();
      await g.startMatch({ mode, map, difficulty: 'veteran', botCount: 9, loadout: ['kestrel', 'sidewinder', 'knife'] });
      // Pointer lock can't be granted headlessly; stop it auto-pausing.
      g.input.onLockChange = null;
      g.menu.hide();
      g.paused = false;
    }, v);
    last = `${v.map}:${v.mode}`;
    // Let the AI spread out and the effects settle.
    await page.evaluate(() => {
      const g = window.__game;
      g.paused = false;
      for (let t = 0; t < 6; t += 1 / 120) g.fixedUpdate(1 / 120);
    });
  }

  const angles = look(v.from, v.to);
  await page.evaluate((v) => {
    const g = window.__game;
    g.menu.hide();
    g.paused = false;
    g.hud.setVisible(true);
    // Park the player at the vantage point and hold them there.
    g.player.pos.set(v.from[0], v.from[1], v.from[2]);
    g.player.vel.set(0, 0, 0);
    g.player.yaw = v.yaw;
    g.player.pitch = v.pitch;
    g.player.recoilYaw = 0; g.player.recoilPitch = 0;
    // Showcase: hide the world and paint a neutral studio backdrop so the
    // weapon can be judged on its own.
    g.setShowcase(!!v.showcase);
    if (v.weapon && g.player.loadout[0] !== v.weapon) {
      g.player.setLoadout([v.weapon, 'sidewinder', 'knife']);
    }
    g.player.viewModel.setAds(!!v.ads);
    // Settle every spring so the pose is the resting one, not mid-transition.
    for (let i = 0; i < 240; i++) {
      g.player.viewModel.update(1 / 60, { speed: 0, grounded: true, crouching: false, lookDx: 0, lookDy: 0 });
    }
  }, { ...v, ...angles });

  // A few real frames so post-processing and particles are populated.
  for (let i = 0; i < 6; i++) await page.waitForTimeout(180);
  await page.screenshot({ path: `${OUT}/${v.name}.png` });
  console.log(`✓ ${v.name}.png`);
}

await browser.close();
