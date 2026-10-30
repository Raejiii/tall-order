import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);

// Turntable view of each Vi3W model next to the sketch and image it came from.
export function createGallery({ renderer, envMap, getPieces, onClose }) {
  const scene = new THREE.Scene();
  scene.environment = envMap;
  scene.environmentIntensity = 0.5;
  scene.background = new THREE.Color('#2b1d14');
  scene.add(new THREE.HemisphereLight('#fff3df', '#5a3a26', 1.6));
  const key = new THREE.DirectionalLight('#ffe9cc', 2.4);
  key.position.set(3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const rim = new THREE.DirectionalLight('#e8643c', 1.6);
  rim.position.set(-4, 2, -3);
  scene.add(key, rim);

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.68, 0.08, 64),
    new THREE.MeshStandardMaterial({ color: '#3d2a1e', roughness: 0.7 }),
  );
  plinth.position.y = -0.04;
  plinth.receiveShadow = true;
  scene.add(plinth);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  const turntable = new THREE.Group();
  scene.add(turntable);

  const hullMat = new THREE.MeshBasicMaterial({ color: '#00c2ff', wireframe: true, transparent: true, opacity: 0.7 });
  let index = 0;
  let showHulls = false;
  let hullGroup = null;
  let current = null;

  function show(i) {
    const pieces = getPieces();
    index = (i + pieces.length) % pieces.length;
    const p = pieces[index];
    if (current) turntable.remove(current);
    current = new THREE.Group();
    const model = p.template.clone(true);
    current.add(model);
    hullGroup = new THREE.Group();
    p.hullGeometries.forEach((g) => hullGroup.add(new THREE.Mesh(g, hullMat)));
    hullGroup.visible = showHulls;
    current.add(hullGroup);
    current.position.y = -p.bounds.min.y;
    turntable.add(current);

    const d = p.def;
    $('g-name').textContent = d.name;
    $('g-sketch').src = `${BASE}models/sketches/${d.id}-sketch.png`;
    $('g-image').src = `${BASE}models/sketches/${d.id}-image.png`;
    $('g-model').src = p.thumb;
    $('g-prompt').textContent = `“${d.prompt}”`;
    $('g-tris').textContent = p.tris.toLocaleString();
    $('g-hulls').textContent = p.hulls.length;
    $('g-mass').textContent = d.massLabel ?? '—';
    if (p.isPlaceholder) $('g-tris').textContent += ' (placeholder)';

    const r = p.bounds.getSize(new THREE.Vector3()).length() / 2;
    const narrow = innerWidth < 700;
    // Keep the model clear of the info card: right of it on desktop, below it on phones.
    const h = p.bounds.max.y - p.bounds.min.y;
    camera.position.set(0, h * 0.5 + r * 1.6, r * (narrow ? 7.5 : 5.2));
    camera.lookAt(narrow ? 0 : r * 1.5, h * 0.5 - (narrow ? r * 1.4 : 0), 0);
  }

  $('g-prev').onclick = () => show(index - 1);
  $('g-next').onclick = () => show(index + 1);
  $('g-hull').onclick = () => {
    showHulls = !showHulls;
    if (hullGroup) hullGroup.visible = showHulls;
    $('g-hull').classList.toggle('on', showHulls);
    $('g-hull').textContent = showHulls ? 'Hide colliders' : 'Show colliders';
  };
  $('btn-gallery-back').onclick = onClose;
  addEventListener('keydown', (e) => {
    if ($('gallery').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
    if (e.key === 'Escape') onClose();
  });

  return {
    open() {
      show(index);
    },
    update(dt) {
      turntable.rotation.y += dt * 0.6;
      renderer.render(scene, camera);
    },
    resize() {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      if (current) show(index);
    },
  };
}
