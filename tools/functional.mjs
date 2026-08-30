// Functional tests: drive real game systems and assert on outcomes, so a
// regression in shooting, reloading, grenades, objectives or respawns fails
// loudly rather than merely running without errors.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:8931/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.menu.screen === 'main', { timeout: 90000 });
await page.evaluate(() => { window.__game.settings.quality = 'low'; window.__game.applySettings(); });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const run = async (name, fn, arg) => {
  const r = await page.evaluate(fn, arg);
  check(name, r.pass, r.detail);
  return r;
};

// Shared match bootstrap.
const startMatch = (cfg) => page.evaluate(async (c) => {
  const g = window.__game;
  if (g.running) g.quitToMenu();
  await g.startMatch(c);
  g.input.onLockChange = null;
  g.menu.hide();
  g.paused = false;
  return true;
}, cfg);

/* ------------------------------------------------------------- shooting -- */
await startMatch({ mode: 'deathmatch', map: 'foundry', difficulty: 'regular', botCount: 5, loadout: ['kestrel', 'sidewinder', 'knife'] });

await run('firing consumes ammo and produces recoil', () => {
  const g = window.__game;
  const p = g.player;
  const before = p.ammo.kestrel;
  const pitchBefore = p.recoilPitch;
  g.input.mouse.left = true;
  for (let i = 0; i < 60; i++) { p.tryFire(g.time); g.fixedUpdate(1 / 120); }
  g.input.mouse.left = false;
  const spent = before - p.ammo.kestrel;
  return { pass: spent >= 3 && p.recoilPitch > pitchBefore, detail: `${spent} rounds fired, recoil pitch ${p.recoilPitch.toFixed(4)}` };
});

await run('spray pattern is deterministic per shot index', () => {
  const g = window.__game;
  const p = g.player;
  const walk = () => {
    p.sprayIndex = 0; p.recoilYaw = 0; p.recoilPitch = 0;
    const out = [];
    for (let i = 0; i < 8; i++) {
      const [x, y] = window.__game.patternAt(p.def, p.sprayIndex);
      out.push(`${x},${y}`);
      p.sprayIndex++;
    }
    return out.join('|');
  };
  const a = walk(), b = walk();
  return { pass: a === b, detail: a === b ? '8 steps reproduce exactly' : 'pattern drifted' };
});

await run('bullets damage a target and eventually kill it', () => {
  const g = window.__game;
  const p = g.player;
  const victim = g.agents.find((a) => !a.isPlayer && a.alive);
  if (!victim) return { pass: false, detail: 'no living bot' };
  // Put the target directly in front of the player, in the open.
  victim.pos.set(p.pos.x, p.pos.y, p.pos.z - 8);
  victim.health = victim.maxHealth;
  p.yaw = 0; p.pitch = 0; p.recoilYaw = 0; p.recoilPitch = 0;
  p.ammo.kestrel = 30;
  const hp0 = victim.health;
  let shots = 0;
  for (let i = 0; i < 400 && victim.alive; i++) {
    p.fireTimer = 0; p.firedThisPress = false; p.sprayIndex = 0;
    p.recoilYaw = 0; p.recoilPitch = 0;
    p.ammo.kestrel = 30;
    p.tryFire(g.time);
    shots++;
    g.fixedUpdate(1 / 120);
  }
  return { pass: !victim.alive && hp0 > 0, detail: `killed after ~${shots} shots` };
});

await run('reload refills the magazine from reserve', () => {
  const g = window.__game;
  const p = g.player;
  p.spawn(p.pos.x, p.pos.y, p.pos.z, 0);
  p.ammo.kestrel = 4;
  const reserveBefore = p.reserve.kestrel;
  p.startReload();
  for (let t = 0; t < 4; t += 1 / 120) g.fixedUpdate(1 / 120);
  return {
    pass: p.ammo.kestrel === 30 && p.reserve.kestrel === reserveBefore - 26,
    detail: `mag ${p.ammo.kestrel}, reserve ${p.reserve.kestrel} (was ${reserveBefore})`,
  };
});

await run('weapon switching swaps the view model', () => {
  const g = window.__game;
  const p = g.player;
  const first = p.def.id;
  p.switchTo(1);
  for (let t = 0; t < 2; t += 1 / 120) g.fixedUpdate(1 / 120);
  const second = p.def.id;
  return { pass: first !== second && second === 'sidewinder', detail: `${first} -> ${second}` };
});

await run('grenades detonate and deal falloff damage', () => {
  const g = window.__game;
  const p = g.player;
  const victim = g.agents.find((a) => !a.isPlayer);
  victim.spawn(p.pos.x + 2, p.pos.y, p.pos.z);
  victim.health = victim.maxHealth;
  const before = victim.health;
  g.spawnGrenade({
    type: 'frag', owner: p, fuse: 0.2,
    pos: { x: p.pos.x + 2, y: p.pos.y + 0.5, z: p.pos.z },
    vel: { x: 0, y: 0, z: 0 },
  });
  for (let t = 0; t < 1.5; t += 1 / 120) g.fixedUpdate(1 / 120);
  return { pass: victim.health < before, detail: `${before} -> ${Math.round(victim.health)} hp` };
});

await run('falling out of the world respawns instead of dropping forever', () => {
  const g = window.__game;
  const p = g.player;
  p.pos.y = g.killY - 5;
  g.fixedUpdate(1 / 120);
  return { pass: p.pos.y > g.killY, detail: `y=${p.pos.y.toFixed(1)} (kill plane ${g.killY})` };
});

await run('dead players are queued for respawn', () => {
  const g = window.__game;
  const p = g.player;
  g.applyDamage(p, 9999, null, 'body', { x: 0, y: 1, z: 0 });
  const died = !p.alive;
  for (let t = 0; t < g.mode.respawnDelay + 0.5; t += 1 / 120) g.fixedUpdate(1 / 120);
  return { pass: died && p.alive, detail: died ? 'died and respawned' : 'never died' };
});

/* ------------------------------------------------------------- objectives */
await startMatch({ mode: 'detonate', map: 'foundry', difficulty: 'regular', botCount: 5, loadout: ['kestrel', 'sidewinder', 'knife'] });

await run('detonate: buy phase locks movement then releases', () => {
  const g = window.__game;
  const locked = (g.mode.phase === 'buy');
  for (let t = 0; t < g.mode.buyTime + 0.5; t += 1 / 120) g.fixedUpdate(1 / 120);
  return { pass: locked && g.mode.phase === 'live' && !g.movementLocked, detail: `phase ${g.mode.phase}` };
});

await run('detonate: player can plant the spike on site', () => {
  const g = window.__game;
  const m = g.mode;
  const p = g.player;
  // Make the player the carrier and stand them on the target site.
  m.spike.carrier = p;
  p.hasSpike = true;
  const site = m.targetSite;
  p.pos.set(site.x, site.y + 0.1, site.z);
  p.vel.set(0, 0, 0);
  g.input.keys.add('KeyF');
  for (let t = 0; t < m.plantTime + 1.5 && !m.spike.planted; t += 1 / 120) {
    p.moveSpeed = 0;
    m.update(1 / 120);
  }
  g.input.keys.delete('KeyF');
  return { pass: m.spike.planted && m.phase === 'planted', detail: `phase ${m.phase}` };
});

await run('detonate: defender can defuse a planted spike', () => {
  const g = window.__game;
  const m = g.mode;
  const defender = g.damageables.find((e) => e.alive && e.team !== m.attackTeam && !e.isPlayer);
  if (!defender) return { pass: false, detail: 'no living defender' };
  defender.pos.set(m.spike.x, m.spike.y, m.spike.z);
  defender.moveSpeed = 0;
  defender.perception.visible.clear();
  defender.perception.primaryTarget = () => null;
  const scoreBefore = m.scores[1 - m.attackTeam];
  for (let t = 0; t < m.defuseTime + 2 && m.phase === 'planted'; t += 1 / 120) {
    defender.moveSpeed = 0;
    m.update(1 / 120);
  }
  return {
    pass: m.scores[1 - m.attackTeam] > scoreBefore,
    detail: `defence score ${scoreBefore} -> ${m.scores[1 - m.attackTeam]}`,
  };
});

await startMatch({ mode: 'domination', map: 'dunes', difficulty: 'regular', botCount: 5, loadout: ['kestrel', 'sidewinder', 'knife'] });

await run('domination: standing on a zone captures it and scores', () => {
  const g = window.__game;
  const m = g.mode;
  const zone = m.zones[0];
  const p = g.player;
  // Clear everyone else off the point so the capture is uncontested.
  for (const e of g.damageables) if (e !== p) e.pos.set(zone.x + 200, e.pos.y, zone.z + 200);
  p.pos.set(zone.x, zone.y + 0.1, zone.z);
  const before = m.scores[p.team];
  for (let t = 0; t < 12; t += 1 / 120) { p.pos.set(zone.x, zone.y + 0.1, zone.z); m.update(1 / 120); }
  return {
    pass: zone.owner === p.team && m.scores[p.team] > before,
    detail: `owner ${zone.owner}, score ${before} -> ${m.scores[p.team]}`,
  };
});

await startMatch({ mode: 'gungame', map: 'vault', difficulty: 'regular', botCount: 5, loadout: ['kestrel', 'sidewinder', 'knife'] });

await run('gun game: a kill promotes the killer to the next weapon', () => {
  const g = window.__game;
  const m = g.mode;
  const p = g.player;
  const lvl0 = m.levelOf(p);
  const w0 = p.def.id;
  const victim = g.agents.find((a) => !a.isPlayer && a.alive);
  g.applyDamage(victim, 9999, p, 'body', { x: 0, y: 0, z: 1 });
  const lvl1 = m.levelOf(p);
  return { pass: lvl1 === lvl0 + 1 && p.def.id !== w0, detail: `level ${lvl0} -> ${lvl1}, ${w0} -> ${p.def.id}` };
});

await startMatch({ mode: 'firefight', map: 'vault', difficulty: 'regular', botCount: 8, loadout: ['vector', 'sidewinder', 'knife'] });

await run('firefight: hostiles spawn and the wave counter advances', () => {
  const g = window.__game;
  const m = g.mode;
  for (let t = 0; t < 20; t += 1 / 120) g.fixedUpdate(1 / 120);
  const hostiles = g.agents.filter((a) => !a.isPlayer && a.alive).length;
  return { pass: m.wave >= 1 && hostiles > 0, detail: `wave ${m.wave}, ${hostiles} hostiles active` };
});

await run('firefight: credits buy a permanent perk', () => {
  const g = window.__game;
  const m = g.mode;
  m.credits = 1000;
  const hp0 = g.player.maxHealth;
  const bought = m.buyPerk('health');
  return { pass: bought && g.player.maxHealth > hp0, detail: `max health ${hp0} -> ${g.player.maxHealth}` };
});

/* ------------------------------------------------------------------- AI -- */
await startMatch({ mode: 'deathmatch', map: 'foundry', difficulty: 'veteran', botCount: 9, loadout: ['kestrel', 'sidewinder', 'knife'] });

await run('AI: bots see, report and engage the player', () => {
  const g = window.__game;
  for (let t = 0; t < 25; t += 1 / 120) g.fixedUpdate(1 / 120);
  const bb = g.blackboards[1];
  const contacts = bb ? bb.contacts.size : 0;
  const engaged = g.agents.filter((a) => !a.isPlayer && a.target).length;
  const kills = g.damageables.reduce((s, e) => s + e.kills, 0);
  return { pass: contacts > 0 || engaged > 0 || kills > 0, detail: `${contacts} shared contacts, ${engaged} engaging, ${kills} kills` };
});

await run('AI: bots take cover and reposition, not just charge', () => {
  const g = window.__game;
  const seen = new Set();
  for (let t = 0; t < 40; t += 1 / 120) {
    g.fixedUpdate(1 / 120);
    for (const a of g.agents) if (!a.isPlayer && a.alive) seen.add(a.action);
  }
  const tactical = [...seen].filter((s) => ['cover', 'flank', 'peek', 'retreat', 'advance', 'search', 'investigate', 'grenade'].includes(s));
  return { pass: tactical.length >= 3, detail: `actions used: ${[...seen].join(', ')}` };
});

await run('AI: squad roles are distributed, not uniform', () => {
  const g = window.__game;
  for (let t = 0; t < 10; t += 1 / 120) g.fixedUpdate(1 / 120);
  const roles = new Set();
  for (const a of g.agents) if (!a.isPlayer) roles.add(g.blackboardFor(a.team).roleOf(a.id));
  return { pass: roles.size >= 2, detail: `roles in play: ${[...roles].join(', ')}` };
});

await run('AI: bots never leave the navigable world', () => {
  const g = window.__game;
  let worst = 0;
  for (let t = 0; t < 30; t += 1 / 120) {
    g.fixedUpdate(1 / 120);
    for (const a of g.agents) {
      if (a.isPlayer || !a.alive) continue;
      const n = g.nav.nearest(a.pos.x, a.pos.y, a.pos.z, 6);
      if (!n) { worst = 99; continue; }
      worst = Math.max(worst, Math.hypot(a.pos.x - n.x, a.pos.z - n.z));
    }
  }
  return { pass: worst < 4, detail: `furthest bot from the nav graph: ${worst.toFixed(2)}m` };
});

/* --------------------------------------------------------- robustness --- */

await run('rapid match restarts leave no leaked state', async () => {
  const g = window.__game;
  const modes = ['deathmatch', 'gungame', 'detonate', 'firefight', 'domination'];
  const maps = ['foundry', 'vault', 'dunes'];
  for (let i = 0; i < 6; i++) {
    await g.startMatch({
      mode: modes[i % modes.length], map: maps[i % maps.length],
      difficulty: 'regular', botCount: 6, loadout: ['kestrel', 'sidewinder', 'knife'],
    });
    g.input.onLockChange = null; g.menu.hide(); g.paused = false;
    for (let t = 0; t < 1.5; t += 1 / 120) g.fixedUpdate(1 / 120);
    g.quitToMenu();
  }
  await g.startMatch({ mode: 'deathmatch', map: 'foundry', difficulty: 'regular', botCount: 6, loadout: ['kestrel', 'sidewinder', 'knife'] });
  g.input.onLockChange = null; g.menu.hide(); g.paused = false;
  const bots = g.agents.filter((a) => !a.isPlayer).length;
  const dupes = g.damageables.length !== new Set(g.damageables).size;
  // Bots from earlier matches must not still be in the scene.
  let orphans = 0;
  g.render.scene.traverse((o) => { if (o.isSkinnedMesh) orphans++; });
  return {
    pass: bots === 6 && !dupes && orphans <= 7,
    detail: `${bots} bots, ${orphans} character meshes in scene, duplicates: ${dupes}`,
  };
});

await run('resizing mid-match does not break rendering', () => {
  const g = window.__game;
  for (const [w, h] of [[640, 360], [1600, 900], [900, 900], [320, 240]]) {
    g.canvas.style.width = `${w}px`;
    g.canvas.style.height = `${h}px`;
    Object.defineProperty(g.canvas, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(g.canvas, 'clientHeight', { value: h, configurable: true });
    g.render.resize(true);
    g.hud.resize();
    g.frame(1 / 60);
  }
  return { pass: g.render.post.width > 0 && g.render.post.height > 0, detail: `post buffer ${g.render.post.width}x${g.render.post.height}` };
});

await run('changing quality mid-match rebuilds cleanly', () => {
  const g = window.__game;
  for (const q of ['low', 'ultra', 'medium', 'high']) {
    g.settings.quality = q;
    g.applySettings();
    for (let t = 0; t < 0.3; t += 1 / 120) g.fixedUpdate(1 / 120);
    g.frame(1 / 60);
  }
  return { pass: true, detail: 'low, ultra, medium, high all applied' };
});

await run('pausing and resuming repeatedly is safe', () => {
  const g = window.__game;
  for (let i = 0; i < 8; i++) {
    g.pause();
    g.frame(1 / 60);
    g.resume();
    g.menu.hide();
    g.paused = false;
    for (let t = 0; t < 0.2; t += 1 / 120) g.fixedUpdate(1 / 120);
  }
  return { pass: g.running && !g.paused, detail: 'eight pause/resume cycles' };
});

await run('a long match stays stable and bounded', () => {
  const g = window.__game;
  const before = {
    timers: g.timers.length,
    grenades: g.grenades.length,
    decals: g.effects.decals.used,
  };
  for (let t = 0; t < 60; t += 1 / 120) g.fixedUpdate(1 / 120);
  const alive = g.damageables.filter((e) => e.alive).length;
  const finite = g.damageables.every((e) => Number.isFinite(e.pos.x) && Number.isFinite(e.pos.y) && Number.isFinite(e.pos.z));
  return {
    pass: finite && g.timers.length < 400 && g.grenades.length < 40 && alive > 0,
    detail: `after 60s: ${g.timers.length} timers, ${g.grenades.length} grenades, ${g.effects.decals.used} decals, ${alive} alive`,
  };
});

await run('performance: a full simulated second costs well under a second', () => {
  const g = window.__game;
  const t0 = performance.now();
  for (let t = 0; t < 1; t += 1 / 120) g.fixedUpdate(1 / 120);
  const ms = performance.now() - t0;
  return { pass: ms < 400, detail: `${ms.toFixed(0)}ms of CPU per simulated second (${g.agents.length} agents)` };
});

await browser.close();

const failed = results.filter((r) => !r.pass);
if (errors.length) {
  console.log(`\n${errors.length} console/page error(s):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ✗ ' + e.slice(0, 400));
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length || errors.length) process.exit(1);
