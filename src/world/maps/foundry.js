// FOUNDRY — industrial two-site map.
//
// Floor plan (x west→east, z north→south):
//
//        z=-40  ┌───────── DEFENDER SPAWN ─────────┐
//        z=-34  │  A-ROT   │  MID-DEF   │  B-ROT   │
//        z=-22  ├── SITE A ─┤          ├─ SITE B ──┤
//        z= -8  │           │ MID COURT│          │
//        z=  6  │ A-LONG    │ MID HALL │   B-MAIN │
//        z= 16  ├────────── SOUTH FORK ────────────┤
//        z= 26  └───────── ATTACKER SPAWN ─────────┘
//
// Floors exist only inside playable regions, so the navigation graph can never
// leak into structural voids.

export const foundry = {
  id: 'foundry',
  name: 'FOUNDRY',
  subtitle: 'Decommissioned steel works',
  size: 'Medium',
  recommended: ['detonate', 'deathmatch', 'domination', 'gungame'],
  env: {
    turbidity: 8, rayleigh: 2.6, mieCoefficient: 0.008, mieDirectionalG: 0.85,
    elevation: 15, azimuth: 205,
    sunColor: 0xffd6a0, sunIntensity: 3.0,
    hemiSky: 0x93b3e0, hemiGround: 0x2a231c, hemiIntensity: 0.6,
    fogColor: 0xa9b7c9, fogDensity: 0.0075,
    exposure: 1.0, envIntensity: 0.9,
    grade: { contrast: 1.06, saturation: 1.0, vignette: 0.44 },
  },
  probes: [
    { name: 'mid catwalk', x: -10.2, y: 4.6, z: 0 },
    { name: 'mid catwalk east', x: 10.2, y: 4.6, z: 0 },
    { name: 'A heaven', x: -35, y: 2.6, z: -11 },
    { name: 'B heaven', x: 35, y: 3.2, z: -11 },
  ],
  bounds: { min: { x: -42, y: -1, z: -44 }, max: { x: 42, y: 16, z: 46 } },

  build(b) {
    const W = { tex: 'concrete' };
    const P = { tex: 'metalPanel' };
    const BR = { tex: 'brick' };
    const H = 7;      // interior wall height
    const T = 0.7;    // wall thickness

    b.seal(-40, -42, 40, 44, 0, 16, W);

    /* ============================================ ATTACKER SPAWN (south) === */
    b.floor(-16, 26, 16, 44, 0, 1, { tex: 'hazard', uvScale: 3.2 });
    b.wallZ(-16, 26, 44, 0, H, T, P);
    b.wallZ(16, 26, 44, 0, H, T, P);
    b.wallX(44, -16, 16, 0, H, T, P);
    b.wallXGaps(26, -16, 16, 0, H, [[-9, 9]], T, 3.2, P);
    b.ceiling(-16, 26, 16, 44, H, 0.6, P);
    b.strip(-15, H - 0.7, 31, 15, H - 0.55, 31.3, 0x63c8ff, 3.4);
    b.strip(-15, H - 0.7, 39, 15, H - 0.55, 39.3, 0x63c8ff, 3.4);
    b.light(0, H - 1, 33, { intensity: 26, distance: 28, color: 0x9fd8ff });
    b.light(0, H - 1, 40, { intensity: 20, distance: 22, color: 0x9fd8ff });
    b.sign(0, 3.6, 26.5, Math.PI, 'ATTACK', 0x63c8ff);
    for (let i = 0; i < 6; i++) b.spawn(0, -10 + i * 4, 0, 36 + (i % 2) * 3, Math.PI);

    /* ================================================== SOUTH FORK ========= */
    b.floor(-28, 16, 28, 26, 0, 1, { tex: 'concreteFloor' });
    b.wallXGaps(26, -28, -16, 0, H, [], T, 3.2, W);
    b.wallXGaps(26, 16, 28, 0, H, [], T, 3.2, W);
    b.wallXGaps(16, -28, 28, 0, H, [[-7, 7]], T, 3.2, W);
    b.wallZGaps(-28, 16, 26, 0, H, [[18, 24]], T, 3.2, BR);
    b.wallZGaps(28, 16, 26, 0, H, [[18, 24]], T, 3.2, BR);
    b.ceiling(-28, 16, 28, 26, H, 0.6, W);
    b.crate(-14, 0, 22, 1.7, 1.35, 1.7, { tex: 'wood' });
    b.crate(-12.2, 0, 23.7, 1.7, 1.35, 1.7, { tex: 'wood' });
    b.crate(-12.2, 1.35, 23.7, 1.7, 1.35, 1.7, { tex: 'wood' });
    b.crate(13.4, 0, 22.6, 1.7, 1.35, 1.7, { tex: 'wood' });
    b.box(-2.2, 0, 20.2, 2.2, 1.25, 22.2, { tex: 'metalPanel', penetration: 1 });
    b.crate(-22, 0, 19, 1.5, 1.2, 1.5, { tex: 'metalPanel' });
    b.crate(22, 0, 19, 1.5, 1.2, 1.5, { tex: 'metalPanel' });
    b.light(-18, H - 1.2, 21, { intensity: 16, distance: 22 });
    b.light(18, H - 1.2, 21, { intensity: 16, distance: 22 });
    b.light(0, H - 1.2, 24, { intensity: 14, distance: 20 });
    b.sign(-27.5, 3.2, 21, -Math.PI / 2, 'A LONG', 0xffb347);
    b.sign(27.5, 3.2, 21, Math.PI / 2, 'B MAIN', 0xffb347);

    /* ===================================================== A LONG ========== */
    b.floor(-38, 6, -28, 26, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(-38, 6, 26, 0, 9, T, BR);
    b.wallX(26, -38, -28, 0, 9, T, BR);
    b.wallZGaps(-28, 6, 16, 0, 9, [], T, 3.2, BR);
    b.crate(-34.5, 0, 20, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.box(-31.6, 0, 12.4, -29.4, 1.35, 14.6, { tex: 'metalPanel', penetration: 1 });
    b.ceiling(-38, 6, -28, 26, 9, 0.6, BR);
    b.light(-33, 7.5, 21, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.light(-33, 7.5, 10, { intensity: 12, distance: 18, color: 0xffd9a0 });

    /* ===================================================== B MAIN ========== */
    b.floor(28, 6, 38, 26, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(38, 6, 26, 0, 9, T, BR);
    b.wallX(26, 28, 38, 0, 9, T, BR);
    b.wallZGaps(28, 6, 16, 0, 9, [], T, 3.2, BR);
    b.crate(34.5, 0, 20, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.box(29.4, 0, 12.4, 31.6, 1.35, 14.6, { tex: 'metalPanel', penetration: 1 });
    b.ceiling(28, 6, 38, 26, 9, 0.6, BR);
    b.light(33, 7.5, 21, { intensity: 14, distance: 20, color: 0xffd9a0 });
    b.light(33, 7.5, 10, { intensity: 12, distance: 18, color: 0xffd9a0 });

    /* ===================================================== MID HALL ======== */
    b.floor(-7, 8, 7, 16, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(-7, 8, 16, 0, H, T, P);
    b.wallZ(7, 8, 16, 0, H, T, P);
    b.ceiling(-7, 8, 7, 16, H, 0.6, P);
    b.crate(-4.2, 0, 13.5, 1.4, 1.2, 1.4, { tex: 'wood' });
    b.crate(4.2, 0, 10.5, 1.4, 1.2, 1.4, { tex: 'wood' });
    b.light(0, H - 1, 12, { intensity: 14, distance: 18 });
    b.strip(-6.6, 3.4, 8.2, -6.4, 3.6, 15.8, 0x63ffc8, 2.2);
    b.strip(6.4, 3.4, 8.2, 6.6, 3.6, 15.8, 0x63ffc8, 2.2);

    /* ==================================================== MID COURT ======== */
    b.floor(-13, -8, 13, 8, 0, 1, { tex: 'concreteFloor' });
    b.wallXGaps(8, -13, 13, 0, 11, [[-7, 7]], T, 3.4, W);
    b.wallXGaps(-8, -13, 13, 0, 11, [[-6, 6]], T, 3.4, W);
    b.wallZGaps(-13, -8, 8, 0, 11, [[-4, 4]], T, 3.4, W);
    b.wallZGaps(13, -8, 8, 0, 11, [[-4, 4]], T, 3.4, W);
    // Central machinery: hard cover with a climbable stack beside it.
    b.box(-3.6, 0, -3.2, 3.6, 2.3, 3.2, { tex: 'metalPanel', noNav: true });
    b.box(-2.6, 2.3, -2.2, 2.6, 3.7, 2.2, { tex: 'paintedMetal', noNav: true });
    b.box(-1.1, 3.7, -0.9, 1.1, 5.6, 0.9, { tex: 'metalPanel', noNav: true });
    b.strip(-2.5, 2.35, -2.35, 2.5, 2.5, -2.15, 0x63ffc8, 3.6);
    b.strip(-2.5, 2.35, 2.15, 2.5, 2.5, 2.35, 0x63ffc8, 3.6);
    b.crate(-9.5, 0, -5.5, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.crate(9.5, 0, 5.5, 1.5, 1.2, 1.5, { tex: 'wood' });
    // Catwalks overlooking mid. The staircases run along X so their risers face
    // the courtyard floor — a stair whose open side is a sheer drop is only
    // reachable by jumping, and the bots would never use it.
    b.catwalk(-12.6, -7.2, -9.0, 3.0, 4.6, { rails: false });
    b.catwalk(9.0, -7.2, 12.6, 3.0, 4.6, { rails: false });
    b.stairs(-5.0, 0.6, -9.0, 3.0, 0, 4.6, 9, 'x', { tex: 'metalPanel' });
    b.stairs(5.0, 0.6, 9.0, 3.0, 0, 4.6, 9, 'x', { tex: 'metalPanel' });
    // Railings: outer edge and the far end, leaving the stair landing open.
    const railM = { tex: 'metalPanel', opaque: false, penetration: 1, noNav: true };
    b.box(-12.6, 4.6, -7.2, -12.45, 5.65, 3.0, railM);
    b.box(-12.6, 4.6, -7.2, -9.0, 5.65, -7.05, railM);
    b.box(-9.15, 4.6, -7.2, -9.0, 5.65, 0.4, railM);
    b.box(12.45, 4.6, -7.2, 12.6, 5.65, 3.0, railM);
    b.box(9.0, 4.6, -7.2, 12.6, 5.65, -7.05, railM);
    b.box(9.0, 4.6, -7.2, 9.15, 5.65, 0.4, railM);
    b.light(0, 9.5, 0, { intensity: 42, distance: 38, color: 0xfff0d0, castShadow: true });
    b.light(-10.5, 7, -5, { intensity: 14, distance: 18, color: 0x8fd0ff });
    b.light(10.5, 7, -5, { intensity: 14, distance: 18, color: 0x8fd0ff });
    b.ceiling(-13, -8, 13, 8, 11, 0.6, W);
    b.sign(0, 4.2, -8.4, 0, 'MID', 0x63ffc8);

    /* ==================================== SITE-TO-MID CONNECTORS =========== */
    b.floor(-16, -4, -13, 4, 0, 1, { tex: 'concreteFloor' });
    b.wallX(-4, -16, -13, 0, H, T, W);
    b.wallX(4, -16, -13, 0, H, T, W);
    b.ceiling(-16, -4, -13, 4, H, 0.5, W);
    b.floor(13, -4, 16, 4, 0, 1, { tex: 'concreteFloor' });
    b.wallX(-4, 13, 16, 0, H, T, W);
    b.wallX(4, 13, 16, 0, H, T, W);
    b.ceiling(13, -4, 16, 4, H, 0.5, W);

    /* ====================================================== SITE A ========= */
    b.floor(-38, -22, -16, 6, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(-38, -22, 6, 0, 10, T, W);
    b.wallXGaps(-22, -38, -16, 0, 10, [[-22, -16]], T, 3.2, W);
    b.wallXGaps(6, -28, -16, 0, 10, [], T, 3.2, W);
    b.wallZGaps(-16, -22, 6, 0, 10, [[-22, -16], [-4, 4]], T, 3.2, W);
    b.ceiling(-38, -22, -16, 6, 10, 0.6, W);
    // Plant platform.
    b.box(-31, 0, -17, -22, 0.45, -8, { tex: 'hazard', uvScale: 2.4 });
    b.site('A', -26.5, 0.45, -12.5, 5.4);
    b.sign(-26.5, 3.4, -21.4, 0, 'SITE A', 0xff7043);
    b.crate(-20.6, 0, -9.5, 1.5, 1.25, 1.5, { tex: 'wood' });
    b.crate(-32.6, 0, -14, 1.5, 1.25, 1.5, { tex: 'wood' });
    b.crate(-18.4, 0, -18.4, 1.4, 1.15, 1.4, { tex: 'metalPanel' });
    b.crate(-24, 0, 1.5, 1.6, 1.2, 1.6, { tex: 'wood' });
    // "Heaven": raised metal platform in the back corner, reached by stairs.
    b.box(-37, 0, -21, -33.5, 2.6, -14, { tex: 'metalPanel' });
    b.catwalk(-37, -14, -33.5, -8, 2.6, { rails: false });
    b.stairs(-31, -14, -33.7, -8, 0, 2.6, 7, 'x', { tex: 'metalPanel' });
    b.wallZ(-33.4, -21, -14.2, 2.6, 3.7, 0.15, { tex: 'metalPanel', opaque: false, penetration: 1, noNav: true });
    b.pillar(-20.5, 2.5, 0, 10, 0.7, P);
    b.pillar(-33, 2.5, 0, 10, 0.7, P);
    b.light(-26.5, 8.5, -12.5, { intensity: 34, distance: 30, color: 0xffd0a0 });
    b.light(-30, 8.5, 1, { intensity: 20, distance: 22 });
    b.light(-20, 8.5, -18, { intensity: 16, distance: 18, color: 0xffb090 });
    b.strip(-37.4, 9.2, -21.4, -16.6, 9.4, -21.1, 0xff8a50, 2.6);

    /* ====================================================== SITE B ========= */
    b.floor(16, -22, 38, 6, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(38, -22, 6, 0, 10, T, W);
    b.wallXGaps(-22, 16, 38, 0, 10, [[16, 22]], T, 3.2, W);
    b.wallXGaps(6, 16, 28, 0, 10, [], T, 3.2, W);
    b.wallZGaps(16, -22, 6, 0, 10, [[-22, -16], [-4, 4]], T, 3.2, W);
    b.ceiling(16, -22, 38, 6, 10, 0.6, W);
    b.box(22, 0, -17, 31, 0.45, -8, { tex: 'hazard', uvScale: 2.4 });
    b.site('B', 26.5, 0.45, -12.5, 5.4);
    b.sign(26.5, 3.4, -21.4, 0, 'SITE B', 0xff7043);
    b.crate(20.6, 0, -9.5, 1.5, 1.25, 1.5, { tex: 'wood' });
    b.crate(32.6, 0, -14, 1.5, 1.25, 1.5, { tex: 'wood' });
    b.crate(18.4, 0, -18.4, 1.4, 1.15, 1.4, { tex: 'metalPanel' });
    b.crate(24, 0, 1.5, 1.6, 1.2, 1.6, { tex: 'wood' });
    b.box(33.5, 0, -21, 37, 3.2, -14, { tex: 'metalPanel' });
    b.catwalk(33.5, -14, 37, -8, 3.2, { rails: false });
    b.stairs(31, -14, 33.7, -8, 0, 3.2, 8, 'x', { tex: 'metalPanel' });
    b.wallZ(33.4, -21, -14.2, 3.2, 4.3, 0.15, { tex: 'metalPanel', opaque: false, penetration: 1, noNav: true });
    b.pillar(20.5, 2.5, 0, 10, 0.7, P);
    b.pillar(33, 2.5, 0, 10, 0.7, P);
    b.light(26.5, 8.5, -12.5, { intensity: 34, distance: 30, color: 0xffd0a0 });
    b.light(30, 8.5, 1, { intensity: 20, distance: 22 });
    b.light(20, 8.5, -18, { intensity: 16, distance: 18, color: 0xffb090 });
    b.strip(16.6, 9.2, -21.4, 37.4, 9.4, -21.1, 0xff8a50, 2.6);

    /* ==================================================== A ROTATE ========= */
    b.floor(-24, -34, -14, -22, 0, 1, { tex: 'concreteFloor' });
    b.wallXGaps(-22, -24, -14, 0, H, [[-22, -16]], T, 3.2, P);
    b.wallX(-34, -24, -14, 0, H, T, P);
    b.wallZ(-24, -34, -22, 0, H, T, P);
    b.wallZGaps(-14, -34, -22, 0, H, [[-32, -26]], T, 3.2, P);
    b.ceiling(-24, -34, -14, -22, H, 0.5, P);
    b.crate(-20, 0, -29, 1.3, 1.15, 1.3, { tex: 'wood' });
    b.light(-19, H - 1, -28, { intensity: 14, distance: 18 });
    b.sign(-19, 3, -21.6, Math.PI, 'A', 0xff7043);

    /* ==================================================== B ROTATE ========= */
    b.floor(14, -34, 24, -22, 0, 1, { tex: 'concreteFloor' });
    b.wallXGaps(-22, 14, 24, 0, H, [[16, 22]], T, 3.2, P);
    b.wallX(-34, 14, 24, 0, H, T, P);
    b.wallZ(24, -34, -22, 0, H, T, P);
    b.wallZGaps(14, -34, -22, 0, H, [[-32, -26]], T, 3.2, P);
    b.ceiling(14, -34, 24, -22, H, 0.5, P);
    b.crate(20, 0, -29, 1.3, 1.15, 1.3, { tex: 'wood' });
    b.light(19, H - 1, -28, { intensity: 14, distance: 18 });
    b.sign(19, 3, -21.6, Math.PI, 'B', 0xff7043);

    /* ================================================== MID / DEFENCE ====== */
    b.floor(-6, -26, 6, -8, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(-6, -26, -8, 0, H, T, P);
    b.wallZ(6, -26, -8, 0, H, T, P);
    b.ceiling(-6, -26, 6, -8, H, 0.5, P);
    b.crate(-3, 0, -20, 1.3, 1.15, 1.3, { tex: 'metalPanel' });
    b.crate(3.2, 0, -14, 1.3, 1.15, 1.3, { tex: 'metalPanel' });
    b.light(0, H - 1, -17, { intensity: 14, distance: 20 });
    b.light(0, H - 1, -24, { intensity: 12, distance: 16 });

    /* ================================================ DEFENDER SPAWN ======= */
    b.floor(-14, -40, 14, -26, 0, 1, { tex: 'hazard', uvScale: 3.2 });
    b.wallX(-40, -14, 14, 0, H, T, P);
    b.wallXGaps(-26, -14, 14, 0, H, [[-6, 6]], T, 3.2, P);
    b.wallZGaps(-14, -40, -26, 0, H, [[-32, -26]], T, 3.2, P);
    b.wallZGaps(14, -40, -26, 0, H, [[-32, -26]], T, 3.2, P);
    b.ceiling(-14, -40, 14, -26, H, 0.6, P);
    b.strip(-13, H - 0.7, -37, 13, H - 0.55, -36.7, 0xff7043, 3.4);
    b.light(0, H - 1, -35, { intensity: 26, distance: 28, color: 0xffb9a0 });
    b.sign(0, 3.6, -25.5, 0, 'DEFEND', 0xff7043);
    for (let i = 0; i < 6; i++) b.spawn(1, -10 + i * 4, 0, -35 - (i % 2) * 3, 0);

    b.marker('mid', { x: 0, y: 0, z: 0 });
  },
};
