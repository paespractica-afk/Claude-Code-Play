// Node-side geometry tests for the character rig and weapon merging.
// These need no GPU, so they catch bind-pose and attribute bugs instantly.
import * as THREE from 'three';
import { Character } from '../src/ai/character.js';
import { buildWeaponModel } from '../src/weapons/model.js';
import { mergeRigid } from '../src/render/rig.js';
import { WEAPONS } from '../src/weapons/defs.js';

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/* ------------------------------------------------------------- character -- */
const c = new Character(0);
c.root.updateMatrixWorld(true);
const mesh = c.skinnedMesh;
check('character bakes into a single skinned mesh', !!mesh, mesh ? `${mesh.geometry.attributes.position.count} verts, ${c.boneList.length} bones` : 'missing');

if (mesh) {
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();

  let maxErr = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    s.copy(v);
    mesh.applyBoneTransform(i, s);
    maxErr = Math.max(maxErr, s.distanceTo(v));
  }
  check('bind pose is the identity transform', maxErr < 1e-4, `max deviation ${maxErr.toExponential(2)}`);

  // A bone must either drive geometry or exist purely to carry child joints;
  // an empty leaf bone means a limb was silently dropped.
  const idx = mesh.geometry.attributes.skinIndex.array;
  const owned = new Set();
  for (let i = 0; i < idx.length; i += 4) owned.add(idx[i]);
  const emptyLeaves = c.boneList.filter((b, i) => !owned.has(i) && !b.children.some((ch) => ch.isBone));
  check('no bone is an empty leaf', emptyLeaves.length === 0,
    `${owned.size}/${c.boneList.length} bones carry geometry, ${c.boneList.length - owned.size} are pure joints`);

  // Weights must be normalised or limbs shrink toward the origin.
  const wt = mesh.geometry.attributes.skinWeight.array;
  let badWeight = 0;
  for (let i = 0; i < wt.length; i += 4) {
    const sum = wt[i] + wt[i + 1] + wt[i + 2] + wt[i + 3];
    if (Math.abs(sum - 1) > 1e-5) badWeight++;
  }
  check('skin weights are normalised', badWeight === 0, `${badWeight} bad vertices`);

  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox;
  const h = b.max.y - b.min.y, w = b.max.x - b.min.x, d = b.max.z - b.min.z;
  check('silhouette is human-shaped', h > 1.6 && h < 2.0 && w > 0.4 && w < 0.9 && d > 0.2 && d < 0.7,
    `${w.toFixed(2)}w x ${h.toFixed(2)}h x ${d.toFixed(2)}d`);

  // Posing a bone must move geometry, and only its own subtree.
  c.hips.rotation.set(0, 0, 0);
  c.legL.thigh.rotation.x = 1.0;
  c.root.updateMatrixWorld(true);
  mesh.skeleton.update();
  let moved = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    s.copy(v);
    mesh.applyBoneTransform(i, s);
    if (s.distanceTo(v) > 0.02) moved++;
  }
  const frac = moved / pos.count;
  check('posing one leg moves only that leg', frac > 0.05 && frac < 0.35, `${(frac * 100).toFixed(0)}% of vertices moved`);

  // Animating for a while must not produce NaN.
  c.legL.thigh.rotation.x = 0;
  let nan = false;
  for (let i = 0; i < 600; i++) {
    c.update(1 / 60, { speed: 5, aimPitch: 0.3, crouch: i > 300 ? 1 : 0, grounded: true });
    if (!Number.isFinite(c.hips.position.y) || !Number.isFinite(c.chest.rotation.x)) { nan = true; break; }
  }
  check('ten seconds of animation stays finite', !nan);

  c.die(1, 0);
  for (let i = 0; i < 180; i++) c.update(1 / 60, {});
  check('death animation settles', Number.isFinite(c.hips.position.y) && c.hips.position.y < 0.5,
    `hips end at y=${c.hips.position.y.toFixed(2)}`);
}

/* --------------------------------------------------- weapon in the hand -- */
{
  const a = new Character(1);
  a.setWeapon(WEAPONS.kestrel);
  a.aimTarget = 1; a.aimBlend = 1;
  for (let i = 0; i < 40; i++) a.update(1 / 60, { speed: 0, aimPitch: 0, crouch: 0, grounded: true });
  a.root.updateMatrixWorld(true);
  a.weaponMount.updateWorldMatrix(true, false);
  const grip = new THREE.Vector3().setFromMatrixPosition(a.weaponMount.matrixWorld);
  const muzzle = a.muzzleWorld(new THREE.Vector3()).clone();
  // The rig faces -Z, so a shouldered weapon must point that way at chest height.
  check('aiming: hands meet at the weapon', grip.y > 1.15 && grip.y < 1.55 && Math.abs(grip.x) < 0.35,
    `grip at (${grip.x.toFixed(2)}, ${grip.y.toFixed(2)}, ${grip.z.toFixed(2)})`);
  check('aiming: barrel points forward and level',
    muzzle.z < grip.z - 0.5 && Math.abs(muzzle.y - grip.y) < 0.25,
    `muzzle at (${muzzle.x.toFixed(2)}, ${muzzle.y.toFixed(2)}, ${muzzle.z.toFixed(2)})`);

  a.aimTarget = 0; a.aimBlend = 0;
  for (let i = 0; i < 40; i++) a.update(1 / 60, { speed: 4, aimPitch: 0, crouch: 0, grounded: true });
  a.root.updateMatrixWorld(true);
  const carryMuzzle = a.muzzleWorld(new THREE.Vector3()).clone();
  check('carrying: weapon stays in front of the body', carryMuzzle.z < -0.3,
    `muzzle z ${carryMuzzle.z.toFixed(2)}`);
}

/* --------------------------------------------------------------- weapons -- */
for (const id of Object.keys(WEAPONS)) {
  const def = WEAPONS[id];
  const built = buildWeaponModel(def);
  const expected = [];
  built.root.traverse((o) => {
    if (!o.isMesh) return;
    expected.push({
      count: o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count,
      rough: o.material.roughness, metal: o.material.metalness,
    });
  });
  const merged = mergeRigid(built.root);
  if (!merged) { check(`${def.name}: merges`, false, 'no geometry'); continue; }
  const g = merged.geometry;
  const total = expected.reduce((s, e) => s + e.count, 0);
  const sur = g.attributes.aSurface.array;
  let off = 0, misaligned = 0;
  for (const e of expected) {
    if (Math.abs(sur[off * 3] - e.rough) > 1e-3 || Math.abs(sur[off * 3 + 1] - e.metal) > 1e-3) misaligned++;
    off += e.count;
  }
  const hasMarkers = !!built.parts.muzzle && !!built.parts.aimPoint;
  check(`${def.name}: merges to one mesh with aligned attributes`,
    g.attributes.position.count === total && misaligned === 0 && hasMarkers,
    `${expected.length} parts -> 1 mesh, ${total} verts`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll rig checks passed.');
process.exit(failures ? 1 : 0);
