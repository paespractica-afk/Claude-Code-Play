// Procedural weapon models.
//
// Each gun is assembled from primitives into a Group with named, animatable
// parts (slide, bolt, magazine, charging handle, trigger) plus empty markers
// for the muzzle and ejection port. Local space: barrel points down -Z,
// up is +Y, the grip sits near the origin.

import * as THREE from 'three';

function mat(color, rough, metal, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal,
    emissive: opts.emissive ? new THREE.Color(opts.emissive) : 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    flatShading: !!opts.flat,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
}

function box(w, h, d, m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  g.position.set(x, y, z);
  g.rotation.set(rx, ry, rz);
  g.castShadow = false;
  return g;
}

function cyl(rTop, rBot, h, seg, m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), m);
  g.position.set(x, y, z);
  g.rotation.set(rx, ry, rz);
  return g;
}

/** Cylinder lying along Z (the barrel axis). */
function tube(rTop, rBot, len, seg, m, x = 0, y = 0, z = 0) {
  return cyl(rTop, rBot, len, seg, m, x, y, z, Math.PI / 2, 0, 0);
}

function torus(r, tubeR, m, x, y, z, rx = 0) {
  const g = new THREE.Mesh(new THREE.TorusGeometry(r, tubeR, 8, 20), m);
  g.position.set(x, y, z);
  g.rotation.x = rx;
  return g;
}

/** A short run of picatinny-style rail teeth. */
function rail(length, m, x, y, z) {
  const g = new THREE.Group();
  const base = box(0.018, 0.005, length, m, 0, 0, 0);
  g.add(base);
  const teeth = Math.max(2, Math.floor(length / 0.011));
  for (let i = 0; i < teeth; i++) {
    g.add(box(0.021, 0.004, 0.005, m, 0, 0.004, -length / 2 + 0.006 + i * 0.011));
  }
  g.position.set(x, y, z);
  return g;
}

/** Cooling / lightening holes down the side of a handguard. */
function ventHoles(count, spacing, m, x, y, z, radius = 0.0055) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const h = cyl(radius, radius, 0.05, 10, m, 0, 0, -((count - 1) * spacing) / 2 + i * spacing, 0, 0, Math.PI / 2);
    g.add(h);
  }
  g.position.set(x, y, z);
  return g;
}

function ironSights(mPart, mAccent, zFront, zRear, y) {
  const g = new THREE.Group();
  // Front post inside a hooded guard.
  g.add(box(0.0035, 0.016, 0.004, mAccent, 0, y + 0.012, zFront));
  g.add(box(0.017, 0.003, 0.005, mPart, 0, y + 0.02, zFront));
  g.add(box(0.003, 0.016, 0.005, mPart, -0.008, y + 0.012, zFront));
  g.add(box(0.003, 0.016, 0.005, mPart, 0.008, y + 0.012, zFront));
  // Rear aperture.
  g.add(box(0.02, 0.014, 0.005, mPart, 0, y + 0.011, zRear));
  const ring = torus(0.0045, 0.0016, mAccent, 0, y + 0.013, zRear);
  g.add(ring);
  return g;
}

/** Red-dot style optic with an emissive reticle that reads at any light level. */
function optic(mBody, dotColor, z, y, size = 1) {
  const g = new THREE.Group();
  const bodyM = mBody;
  g.add(box(0.03 * size, 0.008 * size, 0.055 * size, bodyM, 0, y, z));
  g.add(box(0.026 * size, 0.03 * size, 0.006 * size, bodyM, 0, y + 0.018 * size, z - 0.024 * size));
  g.add(box(0.026 * size, 0.03 * size, 0.006 * size, bodyM, 0, y + 0.018 * size, z + 0.024 * size));
  g.add(box(0.006 * size, 0.03 * size, 0.05 * size, bodyM, -0.013 * size, y + 0.018 * size, z));
  g.add(box(0.006 * size, 0.03 * size, 0.05 * size, bodyM, 0.013 * size, y + 0.018 * size, z));
  g.add(box(0.026 * size, 0.006 * size, 0.05 * size, bodyM, 0, y + 0.032 * size, z));
  // Lens.
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.011 * size, 20),
    mat(0x0a1a24, 0.1, 0.2, { transparent: true, opacity: 0.55, emissive: 0x0a2230, emissiveIntensity: 0.6 }),
  );
  lens.position.set(0, y + 0.017 * size, z + 0.026 * size);
  g.add(lens);
  // Reticle dot — never tone-mapped away, so it stays visible in bright scenes.
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.0016 * size, 12),
    mat(0x000000, 1, 0, { emissive: dotColor, emissiveIntensity: 14 }),
  );
  dot.position.set(0, y + 0.017 * size, z + 0.0275 * size);
  g.add(dot);
  g.userData.reticle = dot;
  return g;
}

/** Scope with an objective bell, turrets and a glass element. */
function scope(mBody, mGlass, z, y) {
  const g = new THREE.Group();
  g.add(tube(0.017, 0.017, 0.16, 18, mBody, 0, y, z));
  g.add(tube(0.023, 0.019, 0.05, 18, mBody, 0, y, z - 0.09));
  g.add(tube(0.021, 0.019, 0.035, 18, mBody, 0, y, z + 0.085));
  g.add(cyl(0.009, 0.009, 0.014, 12, mBody, 0, y + 0.019, z - 0.01));
  g.add(cyl(0.008, 0.008, 0.012, 12, mBody, 0.018, y, z - 0.01, 0, 0, Math.PI / 2));
  g.add(box(0.026, 0.02, 0.02, mBody, 0, y - 0.016, z - 0.05));
  g.add(box(0.026, 0.02, 0.02, mBody, 0, y - 0.016, z + 0.055));
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.019, 22), mGlass);
  glass.position.set(0, y, z + 0.103);
  g.add(glass);
  const objective = new THREE.Mesh(new THREE.CircleGeometry(0.021, 22), mGlass);
  objective.position.set(0, y, z - 0.115);
  objective.rotation.y = Math.PI;
  g.add(objective);
  return g;
}

/* --------------------------------------------------------------- builders -- */

function buildRifle(def, compact = false) {
  const root = new THREE.Group();
  const mBody = mat(def.color, 0.55, 0.35);
  const mMetal = mat(0x1c1f22, 0.34, 0.95);
  const mDark = mat(0x141618, 0.72, 0.25);
  const mAccent = mat(def.accent, 0.4, 0.7, { emissive: def.accent, emissiveIntensity: 0.12 });
  const mPoly = mat(0x1a1c1f, 0.82, 0.05);

  const L = compact ? 0.86 : 1.0;

  // Upper receiver.
  const receiver = new THREE.Group();
  receiver.add(box(0.042, 0.058, 0.30 * L, mBody, 0, 0.02, -0.06 * L));
  receiver.add(box(0.046, 0.03, 0.20 * L, mBody, 0, 0.043, -0.03 * L));
  receiver.add(box(0.038, 0.012, 0.10, mDark, 0, 0.052, 0.06));  // charging shroud
  root.add(receiver);

  // Handguard with vents.
  const hg = new THREE.Group();
  hg.add(box(0.038, 0.042, 0.26 * L, mPoly, 0, 0.017, -0.34 * L));
  hg.add(ventHoles(5, 0.028, mDark, 0, 0.017, -0.34 * L));
  hg.add(rail(0.24 * L, mDark, 0, 0.04, -0.34 * L));
  root.add(hg);

  // Barrel + muzzle device.
  root.add(tube(0.0085, 0.0085, 0.30 * L, 14, mMetal, 0, 0.016, -0.54 * L));
  const brake = new THREE.Group();
  brake.add(tube(0.014, 0.013, 0.05, 14, mMetal, 0, 0, 0));
  for (let i = 0; i < 3; i++) brake.add(box(0.03, 0.004, 0.006, mMetal, 0, 0.006, -0.012 + i * 0.012));
  brake.position.set(0, 0.016, -0.70 * L);
  root.add(brake);

  // Gas block.
  root.add(box(0.022, 0.026, 0.03, mMetal, 0, 0.026, -0.48 * L));

  // Magazine (animatable).
  const magazine = new THREE.Group();
  magazine.add(box(0.026, 0.13, 0.055, mPoly, 0, -0.062, 0));
  magazine.add(box(0.028, 0.012, 0.058, mAccent, 0, -0.126, 0));
  for (let i = 0; i < 4; i++) magazine.add(box(0.027, 0.003, 0.056, mDark, 0, -0.03 - i * 0.025, 0));
  magazine.position.set(0, -0.012, -0.05 * L);
  magazine.rotation.x = -0.16;
  root.add(magazine);

  // Pistol grip + trigger guard.
  const grip = new THREE.Group();
  grip.add(box(0.03, 0.11, 0.042, mPoly, 0, -0.055, 0.055, 0.22));
  grip.add(box(0.032, 0.016, 0.05, mPoly, 0, -0.108, 0.068));
  root.add(grip);
  root.add(box(0.026, 0.005, 0.05, mDark, 0, -0.028, 0.018));
  root.add(box(0.006, 0.03, 0.005, mDark, 0, -0.014, -0.004));
  const trigger = box(0.005, 0.018, 0.006, mMetal, 0, -0.018, 0.024);
  root.add(trigger);

  // Stock.
  const stock = new THREE.Group();
  stock.add(box(0.03, 0.03, 0.10, mPoly, 0, 0.012, 0.14));
  stock.add(box(0.036, 0.07, 0.028, mPoly, 0, 0.0, 0.20));
  stock.add(box(0.038, 0.086, 0.014, mDark, 0, -0.004, 0.216));
  root.add(stock);

  // Charging handle / bolt (animatable).
  const bolt = new THREE.Group();
  bolt.add(box(0.014, 0.014, 0.05, mMetal, 0.026, 0.038, -0.02));
  bolt.add(box(0.03, 0.01, 0.014, mMetal, 0.034, 0.038, -0.005));
  root.add(bolt);

  // Ejection port.
  root.add(box(0.004, 0.022, 0.04, mDark, 0.022, 0.03, -0.01));

  // Optic.
  const sight = optic(mDark, def.accent, -0.02, 0.062, 1);
  root.add(sight);
  root.add(ironSights(mDark, mAccent, -0.42 * L, 0.02, 0.058));

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.016, -0.73 * L);
  root.add(muzzle);
  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(0.03, 0.03, -0.01);
  root.add(ejectPort);
  // The point the sights line up on — used to solve the ADS camera offset.
  const aimPoint = new THREE.Object3D();
  aimPoint.position.set(0, 0.079, -0.02);
  root.add(aimPoint);

  return { root, parts: { receiver, magazine, bolt, trigger, stock, grip, sight, muzzle, ejectPort, aimPoint, handguard: hg } };
}

function buildSMG(def) {
  const root = new THREE.Group();
  const mBody = mat(def.color, 0.6, 0.3);
  const mMetal = mat(0x1b1e21, 0.32, 0.95);
  const mDark = mat(0x131517, 0.75, 0.2);
  const mAccent = mat(def.accent, 0.4, 0.6, { emissive: def.accent, emissiveIntensity: 0.15 });
  const mPoly = mat(0x191b1e, 0.85, 0.05);

  const receiver = new THREE.Group();
  receiver.add(box(0.04, 0.052, 0.24, mBody, 0, 0.02, -0.04));
  receiver.add(box(0.044, 0.026, 0.16, mBody, 0, 0.04, -0.02));
  root.add(receiver);

  root.add(box(0.034, 0.036, 0.14, mPoly, 0, 0.014, -0.22));
  root.add(ventHoles(4, 0.026, mDark, 0, 0.014, -0.22, 0.005));
  root.add(rail(0.13, mDark, 0, 0.034, -0.22));
  root.add(tube(0.007, 0.007, 0.13, 12, mMetal, 0, 0.014, -0.33));
  root.add(tube(0.012, 0.011, 0.03, 12, mMetal, 0, 0.014, -0.40));

  const magazine = new THREE.Group();
  magazine.add(box(0.024, 0.15, 0.04, mPoly, 0, -0.07, 0));
  magazine.add(box(0.026, 0.01, 0.042, mAccent, 0, -0.148, 0));
  magazine.position.set(0, -0.008, 0.006);
  root.add(magazine);

  const grip = new THREE.Group();
  grip.add(box(0.028, 0.095, 0.038, mPoly, 0, -0.05, 0.062, 0.2));
  root.add(grip);
  root.add(box(0.024, 0.005, 0.045, mDark, 0, -0.026, 0.03));
  const trigger = box(0.005, 0.016, 0.005, mMetal, 0, -0.016, 0.036);
  root.add(trigger);

  // Folding stock.
  const stock = new THREE.Group();
  stock.add(box(0.006, 0.006, 0.11, mMetal, -0.016, 0.024, 0.14));
  stock.add(box(0.006, 0.006, 0.11, mMetal, 0.016, 0.024, 0.14));
  stock.add(box(0.05, 0.03, 0.012, mPoly, 0, 0.024, 0.198));
  root.add(stock);

  const bolt = new THREE.Group();
  bolt.add(box(0.012, 0.012, 0.04, mMetal, -0.026, 0.036, -0.01));
  root.add(bolt);

  const sight = optic(mDark, def.accent, -0.01, 0.056, 0.9);
  root.add(sight);

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.014, -0.42); root.add(muzzle);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(0.028, 0.028, -0.01); root.add(ejectPort);
  const aimPoint = new THREE.Object3D(); aimPoint.position.set(0, 0.071, -0.01); root.add(aimPoint);

  return { root, parts: { receiver, magazine, bolt, trigger, stock, grip, sight, muzzle, ejectPort, aimPoint } };
}

function buildShotgun(def) {
  const root = new THREE.Group();
  const mWood = mat(0x4a3220, 0.68, 0.05);
  const mMetal = mat(0x22262a, 0.3, 0.95);
  const mDark = mat(0x141618, 0.75, 0.2);
  const mAccent = mat(def.accent, 0.45, 0.5);

  const receiver = new THREE.Group();
  receiver.add(box(0.046, 0.06, 0.22, mMetal, 0, 0.018, -0.02));
  receiver.add(box(0.05, 0.02, 0.14, mMetal, 0, 0.048, -0.01));
  root.add(receiver);

  // Barrel over magazine tube.
  root.add(tube(0.0145, 0.0145, 0.46, 16, mMetal, 0, 0.03, -0.34));
  root.add(tube(0.011, 0.011, 0.40, 14, mDark, 0, 0.006, -0.31));

  // Pump (animatable — this is the part that racks).
  const bolt = new THREE.Group();
  bolt.add(box(0.036, 0.03, 0.11, mWood, 0, 0.004, 0));
  for (let i = 0; i < 5; i++) bolt.add(box(0.038, 0.004, 0.006, mDark, 0, 0.015, -0.04 + i * 0.02));
  bolt.position.set(0, 0, -0.26);
  root.add(bolt);

  const grip = new THREE.Group();
  grip.add(box(0.032, 0.1, 0.042, mWood, 0, -0.05, 0.07, 0.26));
  root.add(grip);
  root.add(box(0.026, 0.005, 0.05, mDark, 0, -0.024, 0.03));
  const trigger = box(0.005, 0.017, 0.006, mMetal, 0, -0.014, 0.036);
  root.add(trigger);

  const stock = new THREE.Group();
  stock.add(box(0.036, 0.05, 0.15, mWood, 0, 0.0, 0.17, -0.07));
  stock.add(box(0.04, 0.078, 0.016, mDark, 0, -0.012, 0.246));
  root.add(stock);

  // Bead sight.
  root.add(cyl(0.003, 0.003, 0.006, 8, mAccent, 0, 0.048, -0.55));
  root.add(box(0.02, 0.006, 0.03, mDark, 0, 0.05, -0.02));

  const magazine = new THREE.Group(); // shells feed individually; group kept for the API
  root.add(magazine);

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.03, -0.575); root.add(muzzle);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(0.03, 0.02, -0.01); root.add(ejectPort);
  const aimPoint = new THREE.Object3D(); aimPoint.position.set(0, 0.056, -0.02); root.add(aimPoint);

  return { root, parts: { receiver, magazine, bolt, trigger, stock, grip, sight: null, muzzle, ejectPort, aimPoint } };
}

function buildSniper(def) {
  const root = new THREE.Group();
  const mBody = mat(def.color, 0.62, 0.25);
  const mMetal = mat(0x1a1d20, 0.28, 0.96);
  const mDark = mat(0x121416, 0.78, 0.2);
  const mPoly = mat(0x20241d, 0.8, 0.06);
  const mGlass = mat(0x0d1a22, 0.05, 0.3, { transparent: true, opacity: 0.6, emissive: 0x123040, emissiveIntensity: 0.8 });

  const receiver = new THREE.Group();
  receiver.add(box(0.044, 0.056, 0.30, mBody, 0, 0.02, -0.04));
  receiver.add(box(0.048, 0.024, 0.2, mBody, 0, 0.046, -0.02));
  root.add(receiver);

  root.add(box(0.05, 0.05, 0.26, mPoly, 0, 0.006, -0.32));
  root.add(tube(0.012, 0.011, 0.44, 16, mMetal, 0, 0.018, -0.60));
  // Fluting on the barrel.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    root.add(tube(0.0022, 0.0022, 0.24, 6, mDark, Math.cos(a) * 0.0125, 0.018 + Math.sin(a) * 0.0125, -0.55));
  }
  root.add(tube(0.019, 0.017, 0.09, 16, mMetal, 0, 0.018, -0.85));
  for (let i = 0; i < 4; i++) root.add(box(0.042, 0.004, 0.008, mMetal, 0, 0.024, -0.83 + i * 0.016));

  const magazine = new THREE.Group();
  magazine.add(box(0.028, 0.075, 0.06, mPoly, 0, -0.038, 0));
  magazine.position.set(0, -0.012, -0.04);
  root.add(magazine);

  const grip = new THREE.Group();
  grip.add(box(0.032, 0.105, 0.044, mPoly, 0, -0.052, 0.07, 0.2));
  root.add(grip);
  root.add(box(0.026, 0.005, 0.05, mDark, 0, -0.026, 0.03));
  const trigger = box(0.005, 0.018, 0.006, mMetal, 0, -0.016, 0.038);
  root.add(trigger);

  // Bolt handle — the piece that cycles between shots.
  const bolt = new THREE.Group();
  bolt.add(cyl(0.006, 0.006, 0.05, 10, mMetal, 0.032, 0.03, 0.02, 0, 0, Math.PI / 2 + 0.35));
  bolt.add(cyl(0.011, 0.011, 0.014, 12, mMetal, 0.05, 0.022, 0.02, 0, 0, Math.PI / 2));
  root.add(bolt);

  const stock = new THREE.Group();
  stock.add(box(0.038, 0.05, 0.2, mPoly, 0, 0.006, 0.2));
  stock.add(box(0.042, 0.03, 0.07, mPoly, 0, 0.04, 0.18));   // cheek riser
  stock.add(box(0.044, 0.09, 0.016, mDark, 0, -0.004, 0.30));
  root.add(stock);

  // Bipod, folded forward.
  const bipod = new THREE.Group();
  bipod.add(box(0.005, 0.005, 0.13, mDark, -0.012, -0.004, -0.42, 0.5));
  bipod.add(box(0.005, 0.005, 0.13, mDark, 0.012, -0.004, -0.42, 0.5));
  root.add(bipod);

  const sight = scope(mDark, mGlass, -0.01, 0.085);
  root.add(sight);

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.018, -0.90); root.add(muzzle);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(0.028, 0.03, 0.0); root.add(ejectPort);
  const aimPoint = new THREE.Object3D(); aimPoint.position.set(0, 0.085, -0.01); root.add(aimPoint);

  return { root, parts: { receiver, magazine, bolt, trigger, stock, grip, sight, muzzle, ejectPort, aimPoint } };
}

function buildLMG(def) {
  const r = buildRifle(def, false);
  const { root, parts } = r;
  const mDark = mat(0x141618, 0.75, 0.2);
  const mMetal = mat(0x1c1f22, 0.32, 0.95);
  const mPoly = mat(0x191b1e, 0.85, 0.05);

  // Swap the box magazine for a drum.
  parts.magazine.clear();
  const drum = cyl(0.062, 0.062, 0.05, 22, mPoly, 0, -0.07, 0.01, 0, 0, Math.PI / 2);
  parts.magazine.add(drum);
  parts.magazine.add(box(0.03, 0.05, 0.05, mPoly, 0, -0.03, 0.0));
  parts.magazine.add(torus(0.045, 0.005, mDark, 0, -0.07, 0.036, 0));
  parts.magazine.rotation.x = 0;

  // Heavier barrel with a heat shield.
  root.add(box(0.03, 0.03, 0.2, mMetal, 0, 0.016, -0.56));
  for (let i = 0; i < 6; i++) root.add(box(0.034, 0.004, 0.01, mDark, 0, 0.032, -0.63 + i * 0.026));
  // Carry handle.
  root.add(box(0.012, 0.03, 0.08, mDark, 0, 0.075, -0.30));
  root.add(box(0.012, 0.012, 0.10, mDark, 0, 0.09, -0.30));
  // Bipod.
  root.add(box(0.006, 0.006, 0.16, mDark, -0.016, -0.02, -0.46, 0.6));
  root.add(box(0.006, 0.006, 0.16, mDark, 0.016, -0.02, -0.46, 0.6));
  return r;
}

function buildPistol(def) {
  const root = new THREE.Group();
  const mBody = mat(def.color, 0.6, 0.35);
  const mMetal = mat(def.accent, 0.3, 0.92);
  const mDark = mat(0x131517, 0.78, 0.2);
  const mPoly = mat(0x1a1c1f, 0.86, 0.04);

  const frame = new THREE.Group();
  frame.add(box(0.03, 0.03, 0.15, mPoly, 0, 0.0, -0.03));
  frame.add(box(0.03, 0.1, 0.042, mPoly, 0, -0.058, 0.036, 0.18));
  // Grip texture.
  for (let i = 0; i < 5; i++) frame.add(box(0.032, 0.004, 0.04, mDark, 0, -0.028 - i * 0.016, 0.031 + i * 0.003, 0.18));
  root.add(frame);

  // Slide (animatable — cycles on every shot).
  const slide = new THREE.Group();
  slide.add(box(0.032, 0.038, 0.17, mMetal, 0, 0.033, -0.04));
  for (let i = 0; i < 6; i++) slide.add(box(0.034, 0.026, 0.004, mDark, 0, 0.033, 0.015 + i * 0.009));
  slide.add(box(0.006, 0.008, 0.006, mDark, 0, 0.055, -0.115)); // front sight
  slide.add(box(0.022, 0.008, 0.008, mDark, 0, 0.055, 0.03));   // rear sight
  slide.add(box(0.006, 0.009, 0.008, mBody, 0, 0.056, 0.03));
  root.add(slide);

  root.add(tube(0.007, 0.007, 0.03, 12, mDark, 0, 0.033, -0.125));

  const magazine = new THREE.Group();
  magazine.add(box(0.022, 0.09, 0.034, mPoly, 0, -0.05, 0.036, 0.18));
  magazine.add(box(0.026, 0.008, 0.038, mDark, 0, -0.096, 0.044, 0.18));
  root.add(magazine);

  root.add(box(0.022, 0.005, 0.04, mDark, 0, -0.022, 0.01));
  const trigger = box(0.005, 0.016, 0.005, mMetal, 0, -0.014, 0.014);
  root.add(trigger);

  if (def.suppressor) {
    root.add(tube(0.017, 0.017, 0.13, 16, mDark, 0, 0.033, -0.185));
    for (let i = 0; i < 5; i++) root.add(torus(0.0175, 0.0018, mPoly, 0, 0.033, -0.14 - i * 0.022, Math.PI / 2));
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.033, def.suppressor ? -0.255 : -0.142);
  root.add(muzzle);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(0.02, 0.04, 0.0); root.add(ejectPort);
  const aimPoint = new THREE.Object3D(); aimPoint.position.set(0, 0.06, 0.03); root.add(aimPoint);

  return { root, parts: { receiver: frame, magazine, bolt: slide, slide, trigger, stock: null, grip: frame, sight: null, muzzle, ejectPort, aimPoint } };
}

function buildKnife(def) {
  const root = new THREE.Group();
  const mBlade = mat(def.accent, 0.18, 0.98);
  const mGrip = mat(0x1a1c1f, 0.9, 0.05);
  const mDark = mat(0x121416, 0.7, 0.4);

  // Tapered blade built from a lathe-free custom shape.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0.014, 0.01);
  shape.lineTo(0.012, 0.16);
  shape.lineTo(0.0, 0.20);
  shape.lineTo(-0.012, 0.15);
  shape.lineTo(-0.013, 0.01);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelSize: 0.0015, bevelThickness: 0.0012, bevelSegments: 2 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -0.02);
  const blade = new THREE.Mesh(geo, mBlade);
  root.add(blade);
  // Blood groove.
  root.add(box(0.004, 0.001, 0.1, mDark, 0, 0.0025, -0.09));

  root.add(box(0.03, 0.01, 0.008, mDark, 0, 0, 0.005));      // guard
  const grip = box(0.017, 0.019, 0.085, mGrip, 0, 0, 0.05);
  root.add(grip);
  for (let i = 0; i < 4; i++) root.add(box(0.019, 0.004, 0.006, mDark, 0, 0, 0.022 + i * 0.018));
  root.add(box(0.02, 0.022, 0.008, mDark, 0, 0, 0.096));

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -0.2); root.add(muzzle);
  const ejectPort = new THREE.Object3D(); root.add(ejectPort);
  const aimPoint = new THREE.Object3D(); aimPoint.position.set(0, 0.02, 0); root.add(aimPoint);

  return { root, parts: { receiver: root, magazine: null, bolt: null, trigger: null, stock: null, grip, sight: null, muzzle, ejectPort, aimPoint, blade } };
}

const BUILDERS = {
  rifle: buildRifle,
  smg: buildSMG,
  shotgun: buildShotgun,
  sniper: buildSniper,
  lmg: buildLMG,
  pistol: buildPistol,
  knife: buildKnife,
};

const cache = new Map();

/** Build (or clone from cache) a weapon model. */
export function buildWeaponModel(def) {
  const builder = BUILDERS[def.model] || buildRifle;
  const built = builder(def);
  built.root.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; }
  });
  built.root.userData.def = def;
  return built;
}

/** A simplified, shadow-casting copy for AI characters (drawn in the world). */
export function buildWorldWeaponModel(def) {
  const key = `world:${def.id}`;
  let proto = cache.get(key);
  if (!proto) {
    proto = buildWeaponModel(def);
    cache.set(key, proto);
  }
  const clone = proto.root.clone(true);
  clone.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } });
  // Re-resolve markers on the clone so callers get the right transforms.
  const findByPos = (marker) => {
    let found = null;
    const target = marker.position;
    clone.traverse((o) => {
      if (found || o.isMesh || o.type !== 'Object3D') return;
      if (o.position.distanceToSquared(target) < 1e-8) found = o;
    });
    return found;
  };
  return { root: clone, muzzle: findByPos(proto.parts.muzzle) || clone };
}

export function disposeWeaponModel(built) {
  built.root.traverse((o) => {
    if (o.isMesh) { o.geometry?.dispose(); }
  });
}
