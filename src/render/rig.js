// Geometry merging for characters and weapons.
//
// A procedurally-assembled character is naturally dozens of small meshes, which
// is dozens of draw calls each. Here they are baked into a single geometry:
// albedo rides in vertex colours and roughness/metalness/emissive ride in extra
// attributes read by a patched standard material. Characters additionally get
// rigid skin weights so one SkinnedMesh covers the whole body.

import * as THREE from 'three';

/**
 * MeshStandardMaterial whose PBR inputs come from vertex attributes, so a whole
 * character or weapon can share one material — and therefore one draw call.
 */
export function createPartMaterial({ skinning = false, flatShading = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    flatShading,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        attribute vec3 aSurface;   // x roughness, y metalness, z emissive strength
        varying vec3 vSurface;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vSurface = aSurface;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vSurface;
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = clamp(vSurface.x, 0.02, 1.0);
      `)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = clamp(vSurface.y, 0.0, 1.0);
      `)
      // Emissive rides the vertex colour so the glowing parts pick up their own tint.
      .replace('#include <emissivemap_fragment>', `
        totalEmissiveRadiance = vColor.rgb * vSurface.z;
      `);
  };
  // Distinct key so three doesn't share a compiled program with a stock material.
  mat.customProgramCacheKey = () => `part-${skinning ? 's' : 'r'}-${flatShading ? 'f' : 'n'}`;
  return mat;
}

/** Pull the PBR values a mesh's material carries into per-vertex attributes. */
function surfaceOf(material) {
  const rough = material.roughness ?? 0.8;
  const metal = material.metalness ?? 0;
  let emissive = 0;
  if (material.emissive && material.emissiveIntensity > 0) {
    const e = material.emissive;
    emissive = (e.r + e.g + e.b) / 3 * material.emissiveIntensity;
  }
  return [rough, metal, emissive];
}

function colorOf(material) {
  // Emissive parts should read as their emissive colour, not their (dark) base.
  if (material.emissive && material.emissiveIntensity > 0.5) {
    const e = material.emissive;
    if (e.r + e.g + e.b > 0.05) return [e.r, e.g, e.b];
  }
  const c = material.color || new THREE.Color(0xffffff);
  return [c.r, c.g, c.b];
}

/**
 * Bake a mesh's geometry into `root` space with colour/surface attributes.
 * @param {THREE.Mesh} mesh
 * @param {THREE.Matrix4} matrix transform into the target space
 * @param {number|null} boneIndex rigid skin binding, or null for unskinned
 */
function bake(mesh, matrix, boneIndex) {
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  geo.applyMatrix4(matrix);
  const count = geo.attributes.position.count;

  const [r, g, b] = colorOf(mesh.material);
  const [rough, metal, emis] = surfaceOf(mesh.material);
  const colors = new Float32Array(count * 3);
  const surface = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    surface[i * 3] = rough; surface[i * 3 + 1] = metal; surface[i * 3 + 2] = emis;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSurface', new THREE.BufferAttribute(surface, 3));

  if (boneIndex !== null) {
    const idx = new Uint16Array(count * 4);
    const wt = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      idx[i * 4] = boneIndex;
      wt[i * 4] = 1;   // rigid binding: each vertex follows exactly one bone
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(wt, 4));
  }
  // Everything else must be dropped or mergeGeometries rejects the batch.
  for (const name of Object.keys(geo.attributes)) {
    if (!['position', 'normal', 'color', 'aSurface', 'skinIndex', 'skinWeight'].includes(name)) {
      geo.deleteAttribute(name);
    }
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}

function mergeAll(geometries) {
  if (!geometries.length) return null;
  if (geometries.length === 1) return geometries[0];
  // Manual concatenation: predictable, and avoids depending on addon behaviour
  // for the custom attributes above.
  let total = 0;
  for (const g of geometries) total += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  const names = Object.keys(geometries[0].attributes);
  for (const name of names) {
    const proto = geometries[0].attributes[name];
    const size = proto.itemSize;
    const Arr = proto.array.constructor;
    const arr = new Arr(total * size);
    let offset = 0;
    for (const g of geometries) {
      const a = g.attributes[name];
      if (!a) { offset += g.attributes.position.count * size; continue; }
      arr.set(a.array.subarray(0, a.count * size), offset);
      offset += a.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, proto.normalized));
  }
  for (const g of geometries) g.dispose();
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * Collapse an Object3D tree into one unskinned mesh.
 * @param {THREE.Object3D} root
 * @param {Set<THREE.Object3D>} [exclude] subtrees to leave alone (animated parts)
 */
export function mergeRigid(root, exclude = null) {
  root.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const geos = [];
  const consumed = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (exclude) {
      let p = o;
      while (p) { if (exclude.has(p)) return; p = p.parent; }
    }
    const m = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld);
    geos.push(bake(o, m, null));
    consumed.push(o);
  });
  if (!geos.length) return null;
  for (const o of consumed) {
    o.parent?.remove(o);
    o.geometry.dispose();
  }
  const merged = mergeAll(geos);
  const mesh = new THREE.Mesh(merged, createPartMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

/**
 * Convert a rig of nested groups into one SkinnedMesh.
 * @param {THREE.Object3D} root
 * @param {Array<{node: THREE.Object3D, name: string}>} partList
 *        Every animated node, in hierarchy order (parents before children).
 * @returns {{ mesh: THREE.SkinnedMesh, bones: Map<string, THREE.Bone> }}
 */
export function buildSkinned(root, partList) {
  root.updateWorldMatrix(true, true);

  // 1. Mirror the group hierarchy with bones.
  const bones = [];
  const boneByNode = new Map();
  for (const { node } of partList) {
    const bone = new THREE.Bone();
    bone.position.copy(node.position);
    bone.quaternion.copy(node.quaternion);
    bone.scale.copy(node.scale);
    bone.name = node.name || `bone${bones.length}`;
    boneByNode.set(node, bone);
    bones.push(bone);
  }
  for (const { node } of partList) {
    const bone = boneByNode.get(node);
    const parentBone = node.parent && boneByNode.get(node.parent);
    if (parentBone) parentBone.add(bone);
    else root.add(bone);
  }
  root.updateWorldMatrix(true, true);

  // 2. Bake every mesh into the space of its owning bone.
  const geos = [];
  const meshes = [];
  for (let i = 0; i < partList.length; i++) {
    const { node } = partList[i];
    const bone = boneByNode.get(node);
    bone.updateWorldMatrix(true, false);
    const inv = new THREE.Matrix4().copy(bone.matrixWorld).invert();
    node.traverse((o) => {
      if (!o.isMesh) return;
      // A part can itself be a mesh (a foot, say); otherwise only take meshes
      // whose nearest animated ancestor is this node.
      if (o !== node) {
        let p = o.parent;
        while (p && p !== node) {
          if (boneByNode.has(p)) return;
          p = p.parent;
        }
      }
      const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      geos.push(bake(o, m, i));
      meshes.push(o);
    });
  }
  for (const o of meshes) { o.parent?.remove(o); o.geometry.dispose(); }

  const merged = mergeAll(geos);
  if (!merged) return { mesh: null, bones: boneByNode };

  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(merged, createPartMaterial({ skinning: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  // Bones already sit under `root`, so bind with an identity matrix.
  mesh.bind(skeleton, new THREE.Matrix4());
  root.add(mesh);

  return { mesh, bones: boneByNode, boneList: bones };
}
