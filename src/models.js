import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const BASE = import.meta.env.BASE_URL;
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const MAX_HULL_POINTS = 2400;
const HULL_POINTS = 80; // per hull — keeps colliders cheap and readable when drawn

// Loads every piece listed in the manifest, normalises it to game scale and
// builds compound convex-hull colliders from the mesh's own vertices.
export async function loadPieces(onProgress) {
  const manifest = await (await fetch(`${BASE}models/manifest.json`)).json();
  let done = 0;
  return Promise.all(
    manifest.pieces.map(async (def) => {
      let object = null;
      if (def.file) {
        try {
          object = (await loader.loadAsync(`${BASE}models/${def.file}`)).scene;
        } catch (err) {
          console.warn(`[tall-order] ${def.file} failed to load, using placeholder`, err);
        }
      }
      const piece = preparePiece(def, object ?? placeholder(def), !object);
      onProgress?.(++done / manifest.pieces.length);
      return piece;
    }),
  );
}

function preparePiece(def, object, isPlaceholder) {
  const root = new THREE.Group();
  root.add(object);
  object.traverse((m) => m.isMesh && (m.geometry = removeDebris(m.geometry)));

  // Scale so the longest side matches def.size (metres), then centre on the bounding box.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  object.scale.multiplyScalar(def.size / Math.max(size.x, size.y, size.z));
  if (def.rotate) object.rotation.set(...def.rotate.map(THREE.MathUtils.degToRad));
  root.updateMatrixWorld(true);
  box.setFromObject(object);
  object.position.sub(box.getCenter(new THREE.Vector3()));
  root.updateMatrixWorld(true);

  let tris = 0;
  const points = [];
  const v = new THREE.Vector3();
  object.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    // Trellis exports ship without normals.
    if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
    for (const mat of [m.material].flat()) {
      if (mat.map) mat.map.anisotropy = 4;
      // Trellis omits metallicFactor, which glTF defaults to 1 (dark chrome).
      if (!isPlaceholder) {
        mat.metalness = def.metalness ?? 0;
        mat.roughness = def.roughness ?? 0.6;
        if (def.brighten) mat.color.multiplyScalar(def.brighten);
      }
    }
    const pos = m.geometry.attributes.position;
    tris += (m.geometry.index ? m.geometry.index.count : pos.count) / 3;
    const stride = Math.max(1, Math.floor(pos.count / MAX_HULL_POINTS));
    for (let i = 0; i < pos.count; i += stride) {
      points.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
    }
  });

  const clusters = kmeans(points, def.hulls ?? 1).map((c) => reduceHullPoints(c, HULL_POINTS));
  const hulls = clusters.map((c) => new Float32Array(c.flatMap((p) => [p.x, p.y, p.z])));
  const hullGeometries = clusters.map((c) => new ConvexGeometry(c));
  const bounds = new THREE.Box3().setFromPoints(points);

  return { def, template: root, hulls, hullGeometries, bounds, tris: Math.round(tris), isPlaceholder };
}

// Splits the surface points into k spatial clusters. Hulling each cluster
// separately keeps concave shapes (a duck's neck, a cactus's arms) from being
// wrapped in one big blob, which is what makes the pieces balance like the models look.
function kmeans(points, k) {
  if (k <= 1 || points.length < k * 8) return [points];

  // Farthest-point seeding keeps results deterministic between loads.
  const centers = [points[0].clone()];
  while (centers.length < k) {
    let best = null;
    let bestD = -1;
    for (const p of points) {
      const d = Math.min(...centers.map((c) => c.distanceToSquared(p)));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    centers.push(best.clone());
  }

  let groups = [];
  for (let iter = 0; iter < 12; iter++) {
    groups = centers.map(() => []);
    for (const p of points) {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, i) => {
        const d = c.distanceToSquared(p);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      groups[bi].push(p);
    }
    groups.forEach((g, i) => {
      if (!g.length) return;
      centers[i].set(0, 0, 0);
      g.forEach((p) => centers[i].add(p));
      centers[i].divideScalar(g.length);
    });
  }
  return groups.filter((g) => g.length >= 8);
}

// Image-to-3D output sometimes includes floating fragments next to the object.
// Keep the main body plus any sizeable part touching it; drop everything else.
function removeDebris(geometry) {
  const index = geometry.index;
  if (!index) return geometry;
  const pos = geometry.attributes.position;
  const parent = new Int32Array(pos.count).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a, b) => (parent[find(a)] = find(b));

  // UV seams split vertices, so weld by position before walking triangles.
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    if (seen.has(key)) union(i, seen.get(key));
    else seen.set(key, i);
  }
  for (let t = 0; t < index.count; t += 3) {
    union(index.getX(t), index.getX(t + 1));
    union(index.getX(t), index.getX(t + 2));
  }

  const comps = new Map();
  const v = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    const r = find(index.getX(t));
    if (!comps.has(r)) comps.set(r, { tris: 0, box: new THREE.Box3() });
    const c = comps.get(r);
    c.tris++;
    for (let k = 0; k < 3; k++) c.box.expandByPoint(v.fromBufferAttribute(pos, index.getX(t + k)));
  }
  const main = [...comps.values()].reduce((a, b) => (b.tris > a.tris ? b : a));
  for (const c of comps.values()) c.keep = c === main || (c.tris >= main.tris * 0.03 && c.box.intersectsBox(main.box));
  if ([...comps.values()].every((c) => c.keep)) return geometry;

  // Rebuild with only the vertices the surviving triangles use.
  const remap = new Map();
  const newIndex = [];
  for (let t = 0; t < index.count; t += 3) {
    if (!comps.get(find(index.getX(t))).keep) continue;
    for (let k = 0; k < 3; k++) {
      const old = index.getX(t + k);
      if (!remap.has(old)) remap.set(old, remap.size);
      newIndex.push(remap.get(old));
    }
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const arr = new Float32Array(remap.size * attr.itemSize);
    for (const [o, n] of remap) {
      for (let c = 0; c < attr.itemSize; c++) arr[n * attr.itemSize + c] = attr.getComponent(o, c);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
  }
  out.setIndex(newIndex);
  console.info(`[tall-order] removed ${index.count / 3 - newIndex.length / 3} debris triangles`);
  return out;
}

// Keeps the extreme points of a cluster (farthest-point sampling), which preserves
// the hull's silhouette with a fraction of the vertices.
function reduceHullPoints(points, max) {
  if (points.length <= max) return points;
  const picked = [points[0]];
  const dist = points.map((p) => p.distanceToSquared(points[0]));
  while (picked.length < max) {
    let bi = 0;
    for (let i = 1; i < points.length; i++) if (dist[i] > dist[bi]) bi = i;
    const np = points[bi];
    picked.push(np);
    for (let i = 0; i < points.length; i++) dist[i] = Math.min(dist[i], points[i].distanceToSquared(np));
  }
  return picked;
}

// Simple stand-ins so the game stays playable before (or without) the Vi3W exports.
function placeholder(def) {
  const mat = new THREE.MeshStandardMaterial({ color: def.color ?? '#c8a27a', roughness: 0.6 });
  const g = new THREE.Group();
  const add = (geo, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
  };
  switch (def.placeholder) {
    case 'cone':
      add(new THREE.ConeGeometry(0.5, 1.2, 24));
      add(new THREE.BoxGeometry(1.1, 0.1, 1.1), 0, -0.6);
      break;
    case 'cylinder':
      add(new THREE.CylinderGeometry(0.5, 0.5, 0.8, 24));
      break;
    case 'sphere':
      add(new THREE.SphereGeometry(0.5, 24, 16));
      break;
    case 'duck':
      add(new THREE.SphereGeometry(0.5, 24, 16).scale(1.3, 0.8, 1));
      add(new THREE.SphereGeometry(0.32, 20, 14), 0.4, 0.55);
      break;
    default:
      add(new THREE.BoxGeometry(1, 0.6, 0.7));
  }
  return g;
}
