// Capture every front-end screen so the UI can be reviewed without clicking through.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const OUT = process.env.SHOT_DIR || './shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
await page.goto('http://127.0.0.1:8931/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.menu.screen === 'main', { timeout: 90000 });
await page.waitForTimeout(500);

const shot = async (name) => { await page.screenshot({ path: `${OUT}/ui-${name}.png` }); console.log('✓ ui-' + name); };

await shot('main');
await page.evaluate(() => window.__game.menu.show('loadout')); await page.waitForTimeout(150); await shot('loadout');
await page.evaluate(() => window.__game.menu.show('settings')); await page.waitForTimeout(150); await shot('settings');
await page.evaluate(() => window.__game.menu.show('controls')); await page.waitForTimeout(150); await shot('controls');

await page.evaluate(async () => {
  const g = window.__game;
  g.menu.show('main');
  await g.startMatch({ mode: 'detonate', map: 'foundry', difficulty: 'veteran', botCount: 9, loadout: ['warden', 'ghost', 'knife'] });
  g.input.onLockChange = null;
  g.menu.hide();
  g.paused = false;
  for (let t = 0; t < 30; t += 1 / 120) g.fixedUpdate(1 / 120);
});
await page.waitForTimeout(600);
await shot('ingame-detonate');

await page.evaluate(() => {
  const g = window.__game;
  g.hud.showScoreboard(true, g.hudState());
});
await page.waitForTimeout(200);
await shot('scoreboard');

await page.evaluate(() => {
  const g = window.__game;
  g.hud.showScoreboard(false, null);
  g.menu.show('pause');
});
await page.waitForTimeout(200);
await shot('pause');

await page.evaluate(() => {
  const g = window.__game;
  g.menu.show('summary', {
    winner: 0, playerTeam: 0, scores: [7, 4],
    modeName: 'DETONATE', mapName: 'FOUNDRY',
    entities: g.damageables.map((e) => ({ name: e.name, kills: e.kills, deaths: e.deaths, team: e.team, isPlayer: !!e.isPlayer })),
  });
});
await page.waitForTimeout(200);
await shot('summary');

await page.evaluate(async () => {
  const g = window.__game;
  g.quitToMenu();
  await g.startMatch({ mode: 'firefight', map: 'vault', difficulty: 'regular', botCount: 12, loadout: ['vector', 'sidewinder', 'knife'] });
  g.input.onLockChange = null;
  g.mode.credits = 620;
  g.mode.wave = 3;
  g.menu.show('shop', { mode: g.mode });
});
await page.waitForTimeout(300);
await shot('shop');

await browser.close();
