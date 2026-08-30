// VAULT — a subterranean bank. Tight sightlines, marble and tile, and a central
// atrium ringed by a mezzanine that turns every fight vertical. The close-quarters
// counterweight to Dunes.
//
//   ┌──────── outer ring corridor (r 16→21) ────────┐
//   │   ┌──── spur ──── atrium 24×24 ──── spur ───┐ │
//   │   │      mezzanine deck at y 4.6            │ │
//   └───┴─────────────────────────────────────────┴─┘

export const vault = {
  id: 'vault',
  name: 'VAULT',
  subtitle: 'Reserve depository, sub-level 3',
  size: 'Small',
  recommended: ['deathmatch', 'gungame', 'firefight', 'detonate'],
  env: {
    turbidity: 12, rayleigh: 0.4, mieCoefficient: 0.02, mieDirectionalG: 0.7,
    elevation: 3, azimuth: 20,
    sunColor: 0x2a3550, sunIntensity: 0.3,
    hemiSky: 0x3d5170, hemiGround: 0x14100c, hemiIntensity: 0.4,
    fogColor: 0x0d1118, fogDensity: 0.018,
    exposure: 1.3, envIntensity: 0.35,
    showSky: false, backgroundColor: 0x05070b,
    grade: { contrast: 1.12, saturation: 0.95, vignette: 0.55 },
  },
  probes: [
    { name: 'mezzanine west', x: -10, y: 4.6, z: 0 },
    { name: 'mezzanine north', x: 0, y: 4.6, z: -10 },
    { name: 'mezzanine east', x: 10, y: 4.6, z: 0 },
  ],
  bounds: { min: { x: -34, y: -1, z: -34 }, max: { x: 34, y: 13, z: 34 } },

  build(b) {
    const MARB = { tex: 'marble' };
    const W = { tex: 'concrete' };
    const P = { tex: 'paintedMetal' };
    const T = 0.6;
    const H = 5.4;       // ring / spur ceiling
    const UP = 10.0;     // atrium ceiling
    const R0 = 16, R1 = 21;
    const MZ = 4.6;      // mezzanine deck height
    const A = 12;        // atrium half-extent

    b.seal(-32, -32, 32, 32, 0, 13, W);

    /* ================================================= CENTRAL ATRIUM ====== */
    b.floor(-A, -A, A, A, 0, 1, { tex: 'marble', uvScale: 5 });
    b.ceiling(-A, -A, A, A, UP, 0.8, MARB);
    b.wallXGaps(-A, -A, A, 0, UP, [[-4, 4]], T, 3.4, MARB);
    b.wallXGaps(A, -A, A, 0, UP, [[-4, 4]], T, 3.4, MARB);
    b.wallZGaps(-A, -A, A, 0, UP, [[-4, 4]], T, 3.4, MARB);
    b.wallZGaps(A, -A, A, 0, UP, [[-4, 4]], T, 3.4, MARB);

    // Mezzanine ring: a 3.6m deck around the atrium, open over the centre.
    b.box(-A, MZ - 0.4, -A, A, MZ, -8.4, { tex: 'marble' });
    b.box(-A, MZ - 0.4, 8.4, A, MZ, A, { tex: 'marble' });
    b.box(-A, MZ - 0.4, -8.4, -8.4, MZ, 8.4, { tex: 'marble' });
    b.box(8.4, MZ - 0.4, -8.4, A, MZ, 8.4, { tex: 'marble' });

    // Balustrade — shoot over, not through. Gaps where the staircases arrive.
    const bal = { tex: 'metalPanel', penetration: 1, noNav: true };
    b.box(-8.4, MZ, -8.5, 8.4, MZ + 1.0, -8.4, bal);
    b.box(-8.4, MZ, 8.4, 8.4, MZ + 1.0, 8.5, bal);
    b.box(-8.5, MZ, -8.5, -8.4, MZ + 1.0, -6.4, bal);
    b.box(-8.5, MZ, -3.0, -8.4, MZ + 1.0, 8.5, bal);
    b.box(8.4, MZ, -8.5, 8.5, MZ + 1.0, 3.0, bal);
    b.box(8.4, MZ, 6.4, 8.5, MZ + 1.0, 8.5, bal);

    // Staircases up to the mezzanine, inside the open floor so nothing is
    // hidden underneath the deck.
    b.stairs(-3.2, -6.2, -8.6, -3.2, 0, MZ, 11, 'x', { tex: 'concrete' });
    b.stairs(3.2, 6.2, 8.6, 3.2, 0, MZ, 11, 'x', { tex: 'concrete' });

    // Vault door centrepiece: hard cover in the middle of the floor.
    b.box(-2.4, 0, -2.4, 2.4, 2.4, 2.4, { tex: 'metalPanel', noNav: true });
    b.box(-2.8, 2.4, -2.8, 2.8, 2.7, 2.8, { tex: 'metalPanel', noNav: true });
    b.strip(-2.5, 2.75, -2.55, 2.5, 2.9, -2.35, 0x4fd8ff, 4.5);
    b.strip(-2.5, 2.75, 2.35, 2.5, 2.9, 2.55, 0x4fd8ff, 4.5);
    b.crate(-6.5, 0, 6.5, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.crate(6.5, 0, -6.5, 1.5, 1.2, 1.5, { tex: 'wood' });
    b.crate(-6.5, 0, -6.5, 1.5, 1.2, 1.5, { tex: 'metalPanel' });
    b.crate(6.5, 0, 6.5, 1.5, 1.2, 1.5, { tex: 'metalPanel' });

    b.light(0, UP - 1.4, 0, { intensity: 46, distance: 28, color: 0xffeccd, castShadow: true });
    b.light(-9.5, MZ + 2.6, -9.5, { intensity: 14, distance: 14, color: 0x8fd0ff });
    b.light(9.5, MZ + 2.6, 9.5, { intensity: 14, distance: 14, color: 0x8fd0ff });
    b.light(-9.5, 3.6, 9.5, { intensity: 12, distance: 13, color: 0xffd9a0 });
    b.light(9.5, 3.6, -9.5, { intensity: 12, distance: 13, color: 0xffd9a0 });
    b.strip(-11.5, MZ + 1.05, -11.5, 11.5, MZ + 1.15, -11.3, 0x4fd8ff, 2.0);
    b.strip(-11.5, MZ + 1.05, 11.3, 11.5, MZ + 1.15, 11.5, 0x4fd8ff, 2.0);
    b.sign(0, 3.4, -11.6, 0, 'VAULT', 0x4fd8ff);
    b.zone('ATRIUM', 0, 0, 0, 9, { label: 'ATRIUM' });

    /* ======================================================== SPURS ======== */
    // Four short corridors linking the atrium to the ring.
    const spurCeil = (x0, z0, x1, z1) => b.ceiling(x0, z0, x1, z1, H, 0.6, W);
    // West / east.
    b.floor(-R0, -4, -A, 4, 0, 1, { tex: 'tile' });
    b.wallX(-4, -R0, -A, 0, H, T, W);
    b.wallX(4, -R0, -A, 0, H, T, W);
    spurCeil(-R0, -4, -A, 4);
    b.floor(A, -4, R0, 4, 0, 1, { tex: 'tile' });
    b.wallX(-4, A, R0, 0, H, T, W);
    b.wallX(4, A, R0, 0, H, T, W);
    spurCeil(A, -4, R0, 4);
    // North / south.
    b.floor(-4, -R0, 4, -A, 0, 1, { tex: 'tile' });
    b.wallZ(-4, -R0, -A, 0, H, T, W);
    b.wallZ(4, -R0, -A, 0, H, T, W);
    spurCeil(-4, -R0, 4, -A);
    b.floor(-4, A, 4, R0, 0, 1, { tex: 'tile' });
    b.wallZ(-4, A, R0, 0, H, T, W);
    b.wallZ(4, A, R0, 0, H, T, W);
    spurCeil(-4, A, 4, R0);
    for (const [lx, lz] of [[-14, 0], [14, 0], [0, -14], [0, 14]]) {
      b.light(lx, H - 0.9, lz, { intensity: 12, distance: 12, color: 0xffe3bc });
    }

    /* ================================================ RING CORRIDOR ======== */
    // Built as four arms, so no sealed pockets can form in the corners.
    b.floor(-R1, -R1, R1, -R0, 0, 1, { tex: 'tile' });   // north arm
    b.floor(-R1, R0, R1, R1, 0, 1, { tex: 'tile' });     // south arm
    b.floor(-R1, -R0, -R0, R0, 0, 1, { tex: 'tile' });   // west arm
    b.floor(R0, -R0, R1, R0, 0, 1, { tex: 'tile' });     // east arm
    b.ceiling(-R1, -R1, R1, -R0, H, 0.6, W);
    b.ceiling(-R1, R0, R1, R1, H, 0.6, W);
    b.ceiling(-R1, -R0, -R0, R0, H, 0.6, W);
    b.ceiling(R0, -R0, R1, R0, H, 0.6, W);

    // Outer shell.
    b.wallX(-R1, -R1, R1, 0, H, T, W);
    b.wallX(R1, -R1, R1, 0, H, T, W);
    b.wallZGaps(-R1, -R1, R1, 0, H, [[16, 20]], T, 3.2, W);
    b.wallZGaps(R1, -R1, R1, 0, H, [[-20, -16]], T, 3.2, W);
    // Inner shell, opened where the spurs meet it.
    b.wallXGaps(-R0, -R0, R0, 0, H, [[-4, 4]], T, 3.2, W);
    b.wallXGaps(R0, -R0, R0, 0, H, [[-4, 4]], T, 3.2, W);
    b.wallZGaps(-R0, -R0, R0, 0, H, [[-4, 4]], T, 3.2, W);
    b.wallZGaps(R0, -R0, R0, 0, H, [[-4, 4]], T, 3.2, W);

    // Ring cover: teller desks and pillars.
    const desk = (x, z, w, d) => b.box(x - w / 2, 0, z - d / 2, x + w / 2, 1.15, z + d / 2, { tex: 'wood', penetration: 1 });
    // Set against the outer wall so ~1.7m of corridor always stays walkable.
    desk(-19.3, 10, 2.6, 1.2);
    desk(-19.3, -8, 2.6, 1.2);
    desk(19.3, -10, 2.6, 1.2);
    desk(19.3, 8, 2.6, 1.2);
    desk(10, -19.3, 1.2, 2.6);
    desk(-10, -19.3, 1.2, 2.6);
    desk(9, 19.3, 1.2, 2.6);
    desk(-9, 19.3, 1.2, 2.6);
    for (const [px, pz] of [[-18.5, 0], [18.5, 0], [0, -18.5], [0, 18.5]]) b.pillar(px, pz, 0, H, 0.5, MARB);
    for (const [lx, lz] of [
      [-18.5, 14], [-18.5, -14], [18.5, 14], [18.5, -14],
      [14, 18.5], [-14, 18.5], [14, -18.5], [-14, -18.5],
      [-18.5, 0], [18.5, 0], [0, 18.5], [0, -18.5],
    ]) b.light(lx, H - 0.9, lz, { intensity: 10, distance: 12, color: 0xffe3bc });
    b.strip(-R1 + 1, H - 0.5, -R0 - 0.25, R1 - 1, H - 0.35, -R0 - 0.05, 0x4fd8ff, 1.6);
    b.strip(-R1 + 1, H - 0.5, R0 + 0.05, R1 - 1, H - 0.35, R0 + 0.25, 0x4fd8ff, 1.6);

    /* ==================================================== SPAWN ROOMS ====== */
    // Opposite corners of the ring, opening straight through its outer wall.
    b.floor(-30, 13, -20.7, 23, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(-30, 13, 23, 0, H, T, P);
    b.wallX(13, -30, -20.7, 0, H, T, P);
    b.wallX(23, -30, -20.7, 0, H, T, P);
    b.ceiling(-30, 13, -20.7, 23, H, 0.6, P);
    b.strip(-29, H - 0.6, 21.6, -23, H - 0.45, 21.8, 0x63c8ff, 3);
    b.light(-26, H - 1, 18, { intensity: 18, distance: 20, color: 0x9fd8ff });
    b.sign(-25, 3, 13.5, 0, 'ATTACK', 0x63c8ff);
    for (let i = 0; i < 6; i++) b.spawn(0, -28 + (i % 3) * 2.6, 0, 16 + Math.floor(i / 3) * 3.5, -Math.PI / 2);

    b.floor(20.7, -23, 30, -13, 0, 1, { tex: 'concreteFloor' });
    b.wallZ(30, -23, -13, 0, H, T, P);
    b.wallX(-23, 20.7, 30, 0, H, T, P);
    b.wallX(-13, 20.7, 30, 0, H, T, P);
    b.ceiling(20.7, -23, 30, -13, H, 0.6, P);
    b.strip(23, H - 0.6, -21.8, 29, H - 0.45, -21.6, 0xff7043, 3);
    b.light(26, H - 1, -18, { intensity: 18, distance: 20, color: 0xffb9a0 });
    b.sign(25, 3, -13.5, Math.PI, 'DEFEND', 0xff7043);
    for (let i = 0; i < 6; i++) b.spawn(1, 28 - (i % 3) * 2.6, 0, -16 - Math.floor(i / 3) * 3.5, Math.PI / 2);

    b.site('A', -18.5, 0, -6, 4.4);
    b.site('B', 18.5, 0, 6, 4.4);
    b.marker('atrium', { x: 0, y: 0, z: 0 });
  },
};
