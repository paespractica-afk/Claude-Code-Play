// DUNES — desert compound. Open plaza in the centre, long flanking lanes, and a
// two-storey headquarters that owns the middle. Built for longer sightlines than
// Foundry, so rifles and the Shrike get room to work.

export const dunes = {
  id: 'dunes',
  name: 'DUNES',
  subtitle: 'Forward operating base, Al-Wadi',
  size: 'Large',
  recommended: ['deathmatch', 'domination', 'detonate', 'firefight'],
  env: {
    turbidity: 4.5, rayleigh: 1.4, mieCoefficient: 0.004, mieDirectionalG: 0.8,
    elevation: 46, azimuth: 120,
    sunColor: 0xfff0d2, sunIntensity: 3.1,
    hemiSky: 0xa8c4ea, hemiGround: 0x7a5c38, hemiIntensity: 0.45,
    fogColor: 0xdcc9a4, fogDensity: 0.0042,
    exposure: 0.95, envIntensity: 1.7,
    probe: { top: 0xa9c4e6, horizon: 0xcdb68e, bottom: 0x745c40, boost: 1.15 },
    grade: { contrast: 1.06, saturation: 1.06, vignette: 0.38 },
  },
  probes: [
    { name: 'HQ roof', x: 0, y: 5.0, z: 0 },
    { name: 'NW tower', x: -17, y: 4.6, z: 17 },
    { name: 'SE tower', x: 17, y: 4.6, z: -17 },
  ],
  bounds: { min: { x: -50, y: -1, z: -46 }, max: { x: 50, y: 20, z: 46 } },

  build(b) {
    const SAND = { tex: 'sand' };
    const BRICK = { tex: 'brick' };
    const OUTWALL = { tex: 'brick', noNav: true };
    const W = { tex: 'concrete' };
    const P = { tex: 'paintedMetal' };
    const T = 0.6;

    b.seal(-48, -44, 48, 44, 0, 20, BRICK);

    /* ============================================== OPEN GROUND (plaza) ==== */
    b.floor(-48, -44, 48, 44, 0, 1, { tex: 'sand', uvScale: 7 });

    /* =================================================== SOUTH SPAWN ======= */
    b.floor(-14, 30, 14, 42, 0.05, 0.6, { tex: 'concreteFloor' });
    b.wallZ(-14, 30, 42, 0.05, 6, T, BRICK);
    b.wallZ(14, 30, 42, 0.05, 6, T, BRICK);
    b.wallXGaps(30, -14, 14, 0.05, 6, [[-8, 8]], T, 3.2, BRICK);
    b.ceiling(-14, 30, 14, 42, 6, 0.6, BRICK);
    b.light(0, 5, 36, { intensity: 20, distance: 24, color: 0xffe0b0 });
    b.strip(-13, 5.4, 34, 13, 5.55, 34.2, 0x63c8ff, 3);
    b.sign(0, 3.4, 29.5, Math.PI, 'ATTACK', 0x63c8ff);
    for (let i = 0; i < 6; i++) b.spawn(0, -10 + i * 4, 0.05, 36 + (i % 2) * 3, Math.PI);

    /* =================================================== NORTH SPAWN ======= */
    b.floor(-14, -42, 14, -30, 0.05, 0.6, { tex: 'concreteFloor' });
    b.wallZ(-14, -42, -30, 0.05, 6, T, BRICK);
    b.wallZ(14, -42, -30, 0.05, 6, T, BRICK);
    b.wallXGaps(-30, -14, 14, 0.05, 6, [[-8, 8]], T, 3.2, BRICK);
    b.ceiling(-14, -42, 14, -30, 6, 0.6, BRICK);
    b.light(0, 5, -36, { intensity: 20, distance: 24, color: 0xffc0a0 });
    b.strip(-13, 5.4, -34.2, 13, 5.55, -34, 0xff7043, 3);
    b.sign(0, 3.4, -29.5, 0, 'DEFEND', 0xff7043);
    for (let i = 0; i < 6; i++) b.spawn(1, -10 + i * 4, 0.05, -36 - (i % 2) * 3, 0);

    /* ============================================ HEADQUARTERS (centre) ==== */
    // Ground floor: four walls with a doorway on each side.
    const hx0 = -11, hx1 = 11, hz0 = -9, hz1 = 9;
    b.floor(hx0, hz0, hx1, hz1, 0.2, 0.8, { tex: 'tile' });
    b.wallXGaps(hz0, hx0, hx1, 0.2, 4.4, [[-3, 3]], 0.8, 3.0, BRICK);
    b.wallXGaps(hz1, hx0, hx1, 0.2, 4.4, [[-3, 3]], 0.8, 3.0, BRICK);
    b.wallZGaps(hx0, hz0, hz1, 0.2, 4.4, [[-3, 3]], 0.8, 3.0, BRICK);
    b.wallZGaps(hx1, hz0, hz1, 0.2, 4.4, [[-3, 3]], 0.8, 3.0, BRICK);
    // Interior pillars and cover.
    b.pillar(-6, -4.5, 0.2, 4.4, 0.5, W);
    b.pillar(6, -4.5, 0.2, 4.4, 0.5, W);
    b.pillar(-6, 4.5, 0.2, 4.4, 0.5, W);
    b.pillar(6, 4.5, 0.2, 4.4, 0.5, W);
    b.crate(-8, 0.2, 0, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.crate(8, 0.2, 0, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.light(0, 4, 0, { intensity: 26, distance: 22, color: 0xfff0d0 });
    b.light(0, 4, -6, { intensity: 12, distance: 14 });
    b.light(0, 4, 6, { intensity: 12, distance: 14 });

    // Upper floor (roof deck) — reached by external staircases on the flanks.
    b.box(hx0, 4.4, hz0, hx1, 5.0, hz1, { tex: 'concreteFloor' });
    // Parapet: shoot-over cover around the deck edge, with openings on the east
    // and west faces where the external staircases arrive.
    const para = { tex: 'brick', penetration: 1, noNav: true };
    b.box(hx0, 5.0, hz0, hx1, 6.1, hz0 + 0.5, para);
    b.box(hx0, 5.0, hz1 - 0.5, hx1, 6.1, hz1, para);
    b.box(hx0, 5.0, hz0, hx0 + 0.5, 6.1, -3.4, para);
    b.box(hx0, 5.0, 3.4, hx0 + 0.5, 6.1, hz1, para);
    b.box(hx1 - 0.5, 5.0, hz0, hx1, 6.1, -3.4, para);
    b.box(hx1 - 0.5, 5.0, 3.4, hx1, 6.1, hz1, para);
    b.crate(0, 5.0, -3, 1.4, 1.1, 1.4, { tex: 'metalPanel' });
    b.crate(0, 5.0, 3, 1.4, 1.1, 1.4, { tex: 'metalPanel' });
    b.strip(-10.5, 5.9, -8.6, 10.5, 6.05, -8.4, 0xffb347, 2.2);
    b.sign(0, 3.0, -9.5, 0, 'HQ', 0xffb347);
    b.zone('HQ', 0, 0.2, 0, 8, { label: 'HEADQUARTERS' });

    // West staircase up the outside of HQ: risers face the plaza.
    b.stairs(-16.5, -3, -11.2, 3, 0, 4.8, 10, 'x', { tex: 'concrete' });
    // East staircase.
    b.stairs(16.5, -3, 11.2, 3, 0, 4.8, 10, 'x', { tex: 'concrete' });

    /* ==================================================== WEST LANE ======== */
    // A walled convoy road with staggered cover — the long-range lane.
    b.wallZ(-34, -26, 26, 0, 7, 0.8, OUTWALL);
    b.wallZ(-22, -26, 8, 0, 7, 0.8, OUTWALL);
    b.wallZ(-22, 14, 26, 0, 7, 0.8, OUTWALL);
    b.wallX(-26, -34, -22, 0, 7, 0.8, OUTWALL);
    b.wallX(26, -34, -22, 0, 7, 0.8, OUTWALL);
    b.floor(-34, -26, -22, 26, 0.02, 0.4, { tex: 'concreteFloor' });
    b.crate(-31, 0.02, 16, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(-25, 0.02, 6, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(-25, 1.32, 6, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(-30, 0.02, -6, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(-26, 0.02, -18, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.box(-32, 0.02, -2, -28, 1.4, 2, { tex: 'metalPanel', penetration: 1 });
    b.light(-28, 6, 18, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.light(-28, 6, 0, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.light(-28, 6, -18, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.sign(-21.6, 3, 20, Math.PI / 2, 'WEST ROAD', 0xffb347);
    b.zone('WEST', -28, 0, 0, 7, { label: 'CONVOY ROAD' });

    /* ==================================================== EAST LANE ======== */
    b.wallZ(34, -26, 26, 0, 7, 0.8, OUTWALL);
    b.wallZ(22, -26, 8, 0, 7, 0.8, OUTWALL);
    b.wallZ(22, 14, 26, 0, 7, 0.8, OUTWALL);
    b.wallX(-26, 22, 34, 0, 7, 0.8, OUTWALL);
    b.wallX(26, 22, 34, 0, 7, 0.8, OUTWALL);
    b.floor(22, -26, 34, 26, 0.02, 0.4, { tex: 'concreteFloor' });
    b.crate(31, 0.02, 16, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(25, 0.02, 6, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(30, 0.02, -6, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(30, 1.32, -6, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(26, 0.02, -18, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.box(28, 0.02, -2, 32, 1.4, 2, { tex: 'metalPanel', penetration: 1 });
    b.light(28, 6, 18, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.light(28, 6, 0, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.light(28, 6, -18, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.sign(21.6, 3, 20, -Math.PI / 2, 'EAST ROAD', 0xffb347);
    b.zone('EAST', 28, 0, 0, 7, { label: 'EAST ROAD' });

    /* ============================================ PLAZA COVER / DETAIL ===== */
    // Shipping containers and barriers scattered between HQ and the lanes.
    const container = (x, z, rot = 0, tint) => {
      if (rot === 0) b.box(x - 3, 0, z - 1.2, x + 3, 2.6, z + 1.2, { tex: 'metalPanel', tint, noNav: true });
      else b.box(x - 1.2, 0, z - 3, x + 1.2, 2.6, z + 3, { tex: 'metalPanel', tint, noNav: true });
    };
    container(-16, 24, 0, 0xd08a4a);
    container(16, 24, 0, 0x4a8ad0);
    container(-16, -24, 90, 0x4ad08a);
    container(16, -24, 90, 0xd04a4a);
    container(-19, 6, 90, 0xd0b04a);
    container(19, -6, 90, 0x8a4ad0);
    // Low sandbag walls you can shoot over.
    const sandbags = (x, z, w, d) => b.box(x - w / 2, 0, z - d / 2, x + w / 2, 1.15, z + d / 2, { tex: 'sand', penetration: 1 });
    sandbags(-15, 6, 5, 1.2);
    sandbags(15, 6, 5, 1.2);
    sandbags(-15, -6, 5, 1.2);
    sandbags(15, -6, 5, 1.2);
    sandbags(-6, 22, 1.2, 5);
    sandbags(6, -22, 1.2, 5);
    b.crate(-19, 0, 24, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(19, 0, -24, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(-19, 0, -24, 1.6, 1.3, 1.6, { tex: 'wood' });
    b.crate(19, 0, 24, 1.6, 1.3, 1.6, { tex: 'wood' });

    // Guard towers on the diagonals — elevated angles onto the plaza. Each has a
    // stair whose risers face open ground and a matching gap in its waist wall.
    const tower = (x, z, stairFrom) => {
      const leg = (lx, lz) => b.box(lx - 0.3, 0, lz - 0.3, lx + 0.3, 4.2, lz + 0.3, W);
      leg(x - 2.1, z - 2.1); leg(x + 2.1, z - 2.1); leg(x - 2.1, z + 2.1); leg(x + 2.1, z + 2.1);
      b.box(x - 2.6, 4.2, z - 2.6, x + 2.6, 4.6, z + 2.6, { tex: 'concreteFloor' });
      const waist = { tex: 'concrete', penetration: 1, noNav: true };
      const gap = 1.7;
      // Waist-high cover on all four sides, open where the stair arrives.
      if (stairFrom === 'south') {
        b.box(x - 2.6, 4.6, z - 2.6, x - gap, 5.7, z - 2.2, waist);
        b.box(x + gap, 4.6, z - 2.6, x + 2.6, 5.7, z - 2.2, waist);
      } else b.box(x - 2.6, 4.6, z - 2.6, x + 2.6, 5.7, z - 2.2, waist);
      if (stairFrom === 'north') {
        b.box(x - 2.6, 4.6, z + 2.2, x - gap, 5.7, z + 2.6, waist);
        b.box(x + gap, 4.6, z + 2.2, x + 2.6, 5.7, z + 2.6, waist);
      } else b.box(x - 2.6, 4.6, z + 2.2, x + 2.6, 5.7, z + 2.6, waist);
      b.box(x - 2.6, 4.6, z - 2.6, x - 2.2, 5.7, z + 2.6, waist);
      b.box(x + 2.2, 4.6, z - 2.6, x + 2.6, 5.7, z + 2.6, waist);
      b.light(x, 5.4, z, { intensity: 10, distance: 12, color: 0xffd9a0 });
    };
    tower(-17, 17, 'south');
    tower(17, -17, 'north');
    b.stairs(-18.6, 10.2, -15.4, 14.8, 0, 4.6, 10, 'z', { tex: 'concrete' });
    b.stairs(15.4, -10.2, 18.6, -14.8, 0, 4.6, 10, 'z', { tex: 'concrete' });

    b.site('A', -28, 0, 0, 5.5);
    b.site('B', 28, 0, 0, 5.5);
    b.marker('hq', { x: 0, y: 0.2, z: 0 });
  },
};
