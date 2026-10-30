import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadPieces } from './models.js';
import * as sfx from './audio.js';

// ---------- Tuning ----------
const PEDESTAL_TOP = 1.0;
const PEDESTAL_RADIUS = 1.3;
const FALL_Y = PEDESTAL_TOP - 0.35; // below this a piece has fallen off
const HOVER_GAP = 0.55; // how far above the tower the next piece hangs
const AIM_RADIUS = PEDESTAL_RADIUS + 0.35;
const LIVES = 3;
const STEP = 1 / 60;
const GUST_FROM = 2.5; // metres of tower before gusts begin

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

// ---------- Renderer & scene ----------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
const SKY = new THREE.Color('#f3d9b8');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 14, 34);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envMap;
scene.environmentIntensity = 0.45;

scene.add(new THREE.HemisphereLight('#fff3df', '#c98b5a', 1.1));
const sun = new THREE.DirectionalLight('#fff1d6', 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -5;
sun.shadow.camera.right = sun.shadow.camera.top = 5;
sun.shadow.camera.far = 40;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

buildSet();

function buildSet() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: '#e9c49a', roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const stone = new THREE.MeshStandardMaterial({ color: '#d8cbbb', roughness: 0.85 });
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(PEDESTAL_RADIUS * 0.8, PEDESTAL_RADIUS * 0.95, PEDESTAL_TOP - 0.16, 48),
    stone,
  );
  column.position.y = (PEDESTAL_TOP - 0.16) / 2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(PEDESTAL_RADIUS, PEDESTAL_RADIUS, 0.16, 48), stone);
  cap.position.y = PEDESTAL_TOP - 0.08;
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(PEDESTAL_RADIUS, 0.03, 8, 64),
    new THREE.MeshStandardMaterial({ color: '#e8643c', roughness: 0.4 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = PEDESTAL_TOP - 0.08;
  for (const m of [column, cap]) {
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  scene.add(trim);

  // A few scattered crates so the floor isn't empty.
  const crateMat = new THREE.MeshStandardMaterial({ color: '#c58f5e', roughness: 0.9 });
  [
    [-3.2, -2.2, 0.7, 0.4],
    [3.4, -3.0, 0.9, 1.1],
    [-3.6, 1.6, 0.5, 2.2],
    [2.6, 2.4, 0.45, 0.2],
  ].forEach(([x, z, s, r]) => {
    const c = new THREE.Mesh(new RoundedBoxGeometry(s, s, s, 3, 0.05), crateMat);
    c.position.set(x, s / 2, z);
    c.rotation.y = r;
    c.castShadow = c.receiveShadow = true;
    scene.add(c);
  });
}

// Height markers every metre, labelled with sprites.
const markers = [];
function ensureMarkers(upTo) {
  while (markers.length < upTo) {
    const n = markers.length + 1;
    const y = PEDESTAL_TOP + n;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.5, 0.012, 6, 96),
      new THREE.MeshBasicMaterial({ color: '#e8643c', transparent: true, opacity: 0.35 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#e8643c';
    g.font = '700 44px Fredoka, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${n} m`, 64, 34);
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    label.scale.set(0.6, 0.3, 1);
    label.position.y = y + 0.18;
    scene.add(ring, label);
    markers.push({ ring, label, reached: false });
  }
}
ensureMarkers(4);

// ---------- Physics ----------
let world;
let events;
const colliderToPiece = new Map();

function createWorld() {
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.integrationParameters.numSolverIterations = 8;
  events = new RAPIER.EventQueue(true);
  world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -0.5, 0).setFriction(0.9));
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(PEDESTAL_TOP / 2, PEDESTAL_RADIUS)
      .setTranslation(0, PEDESTAL_TOP / 2, 0)
      .setFriction(1),
  );
}

// ---------- Game state ----------
let pieces = [];
let bag = [];
let state = 'loading';
let placed = []; // { piece, mesh, body, lost, lostAt, hullViz }
let hover = null; // { piece, mesh, targetPos, targetQuat }
let next = null;
let lives = LIVES;
let towerHeight = 0;
let maxHeight = 0;
let best = store.get('tall-order-best', 0);
let settleTimer = 0;
let stillTimer = 0;
let dropped = null;
let timeScale = 1;
let slowmoTimer = 0;
let shake = 0;
let orbit = 0.6;
let orbitTarget = 0.6;
let camFocus = PEDESTAL_TOP + 0.5;
let showHulls = false;
let gustTimer = 12;
let gustActive = 0;
let gustDir = new THREE.Vector3();
let titleSpin = 0;

function drawFromBag() {
  if (!bag.length) {
    bag = pieces.flatMap((p) => Array(p.def.weight ?? 2).fill(p));
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  return bag.pop();
}

function instantiate(piece) {
  const mesh = piece.template.clone(true);
  scene.add(mesh);
  return mesh;
}

function spawnHover() {
  const piece = next ?? drawFromBag();
  next = drawFromBag();
  $('next-thumb').src = next.thumb;
  const mesh = instantiate(piece);
  const y = hoverY(piece);
  const startQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
  mesh.position.set(aim.x, y + 1.5, aim.z);
  mesh.quaternion.copy(startQuat);
  mesh.scale.setScalar(0.01);
  hover = { piece, mesh, targetQuat: startQuat.clone(), born: 0 };
  guide.visible = true;
}

function hoverY(piece) {
  const r = piece.bounds.getSize(new THREE.Vector3()).length() / 2;
  return PEDESTAL_TOP + towerHeight + HOVER_GAP + r;
}

function dropHover() {
  if (state !== 'aiming' || !hover || hover.born < 0.25) return;
  const { piece, mesh } = hover;
  const p = mesh.position;
  const q = mesh.quaternion;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(0, -1.5, 0)
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCcdEnabled(true),
  );
  const entry = { piece, mesh, body, lost: false, lostAt: 0, hullViz: null, lastSound: 0 };
  for (const hull of piece.hulls) {
    const desc = RAPIER.ColliderDesc.convexHull(hull);
    if (!desc) continue;
    desc
      .setDensity(piece.def.density ?? 300)
      .setFriction(piece.def.friction ?? 0.9)
      .setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    colliderToPiece.set(world.createCollider(desc, body).handle, entry);
  }
  entry.hullViz = makeHullViz(piece);
  entry.hullViz.visible = showHulls;
  mesh.add(entry.hullViz);
  placed.push(entry);
  dropped = entry;
  hover = null;
  guide.visible = false;
  settleTimer = 0;
  stillTimer = 0;
  state = 'settling';
  sfx.whoosh();
}

const hullMat = new THREE.MeshBasicMaterial({ color: '#00c2ff', wireframe: true, transparent: true, opacity: 0.6 });
function makeHullViz(piece) {
  const g = new THREE.Group();
  piece.hullGeometries.forEach((geo) => g.add(new THREE.Mesh(geo, hullMat)));
  return g;
}

function setHulls(on) {
  showHulls = on;
  placed.forEach((e) => e.hullViz && (e.hullViz.visible = on));
  $('btn-colliders').classList.toggle('on', on);
}

// ---------- Aiming guide ----------
const guide = new THREE.Group();
const guideLine = new THREE.Mesh(
  new THREE.CylinderGeometry(0.008, 0.008, 1, 6).translate(0, -0.5, 0),
  new THREE.MeshBasicMaterial({ color: '#e8643c', transparent: true, opacity: 0.7 }),
);
const guideDot = new THREE.Mesh(
  new THREE.RingGeometry(0.06, 0.1, 24).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#e8643c', side: THREE.DoubleSide }),
);
guide.add(guideLine, guideDot);
guide.visible = false;
scene.add(guide);

function updateGuide() {
  if (!hover) return;
  const p = hover.mesh.position;
  const hit = world.castRay(new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }), 60, true);
  const dist = hit ? hit.timeOfImpact : p.y;
  guideLine.position.copy(p);
  guideLine.scale.y = dist;
  guideDot.position.set(p.x, p.y - dist + 0.01, p.z);
}

// ---------- Input ----------
const aim = new THREE.Vector3(0, 0, 0);
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let pointerDown = null;
const keys = new Set();

function aimFromPointer(e) {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (!hover) return;
  plane.constant = -hover.mesh.position.y;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hit)) {
    hit.y = 0;
    if (hit.length() > AIM_RADIUS) hit.setLength(AIM_RADIUS);
    aim.copy(hit);
  }
}

canvas.addEventListener('pointermove', (e) => {
  if (state !== 'aiming') return;
  // Touch: drag moves the piece. Mouse: hover moves it.
  if (e.pointerType === 'mouse' || pointerDown) aimFromPointer(e);
});
canvas.addEventListener('pointerdown', (e) => {
  sfx.initAudio();
  pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (state === 'aiming') aimFromPointer(e);
});
canvas.addEventListener('pointerup', (e) => {
  const d = pointerDown;
  pointerDown = null;
  if (!d || state !== 'aiming') return;
  if (e.pointerType === 'mouse' && e.button === 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) dropHover();
});
canvas.addEventListener(
  'wheel',
  (e) => {
    if (state === 'aiming') rotateHover('yaw', Math.sign(e.deltaY) * (Math.PI / 12));
    e.preventDefault();
  },
  { passive: false },
);

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  sfx.initAudio();
  const k = e.key.toLowerCase();
  keys.add(k);
  if (state === 'aiming') {
    if (k === ' ' || k === 'enter') dropHover();
    if (k === 'q') rotateHover('yaw', Math.PI / 4);
    if (k === 'e') rotateHover('yaw', -Math.PI / 4);
    if (k === 'r') rotateHover('pitch', Math.PI / 2);
    if (k === 'f') rotateHover('roll', Math.PI / 2);
  }
  if (k === 'h' && (state === 'aiming' || state === 'settling')) setHulls(!showHulls);
  if (k === 'm') toggleMute();
  if (k === ' ') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// Rotations are relative to the camera so "tip" always tips toward/away from you.
function rotateHover(kind, angle) {
  if (!hover) return;
  const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  const camFwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), camRight);
  const axis = kind === 'yaw' ? new THREE.Vector3(0, 1, 0) : kind === 'pitch' ? camRight : camFwd;
  hover.targetQuat.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  sfx.thud(0.15, 0.4);
}

document.querySelectorAll('.touch button').forEach((b) =>
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    sfx.initAudio();
    const act = b.dataset.act;
    if (act === 'drop') dropHover();
    if (act === 'spin') rotateHover('yaw', -Math.PI / 4);
    if (act === 'tip') rotateHover('pitch', Math.PI / 2);
    if (act === 'orbitL') orbitTarget += Math.PI / 4;
    if (act === 'orbitR') orbitTarget -= Math.PI / 4;
  }),
);

function toggleMute() {
  const m = sfx.toggleMute();
  $('btn-mute').textContent = m ? 'Sound off' : 'Sound on';
}
$('btn-mute').onclick = toggleMute;
$('btn-colliders').onclick = () => setHulls(!showHulls);

// ---------- Flow ----------
// Decorative tower shown behind the title screen.
const showcase = new THREE.Group();
scene.add(showcase);
function buildShowcase() {
  const order = ['anvil', 'cactus', 'duck'];
  let y = PEDESTAL_TOP;
  order.forEach((id, i) => {
    const p = pieces.find((x) => x.def.id === id);
    if (!p) return;
    const m = p.template.clone(true);
    m.position.set(i === 2 ? 0.12 : 0, y - p.bounds.min.y, 0);
    m.rotation.y = [0.4, -0.3, 0.9][i];
    showcase.add(m);
    y += p.bounds.max.y - p.bounds.min.y - (id === 'anvil' ? 0.02 : -0.02);
  });
}

function setState(s) {
  state = s;
  showcase.visible = s === 'title' || s === 'loading';
  markers.forEach((m) => (m.ring.visible = m.label.visible = !showcase.visible));
  $('title').classList.toggle('show', s === 'title');
  $('over').classList.toggle('show', s === 'over');
  $('hud').classList.toggle('hidden', !(s === 'aiming' || s === 'settling'));
  if (s === 'title') $('best-title').textContent = `${best.toFixed(2)} m`;
}

function resetGame() {
  for (const e of placed) scene.remove(e.mesh);
  if (hover) scene.remove(hover.mesh);
  placed = [];
  hover = null;
  dropped = null;
  colliderToPiece.clear();
  world?.free();
  createWorld();
  lives = LIVES;
  towerHeight = 0;
  maxHeight = 0;
  timeScale = 1;
  gustTimer = 12;
  gustActive = 0;
  $('gust').classList.add('hidden');
  markers.forEach((m) => {
    m.reached = false;
    m.ring.material.opacity = 0.35;
  });
  next = null;
  bag = [];
  updateHud();
}

function startGame() {
  sfx.initAudio();
  resetGame();
  setState('aiming');
  aim.set(0, 0, 0);
  spawnHover();
}

$('btn-play').onclick = startGame;
$('btn-again').onclick = startGame;
$('btn-menu').onclick = () => {
  resetGame();
  setState('title');
};
$('btn-share').onclick = async () => {
  const text = `I stacked ${maxHeight.toFixed(2)} m of rubber ducks, anvils and cacti in Tall Order 🦆⚒️🌵`;
  try {
    await navigator.clipboard.writeText(text);
    $('btn-share').textContent = 'Copied!';
  } catch {
    $('btn-share').textContent = 'Copy failed';
  }
  setTimeout(() => ($('btn-share').textContent = 'Copy score'), 1500);
};

function updateHud() {
  $('height').textContent = `${towerHeight.toFixed(2)} m`;
  $('lives').textContent = '●'.repeat(lives) + '○'.repeat(LIVES - lives);
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('pop');
  void t.offsetWidth;
  t.classList.add('pop');
}

function measureTower() {
  let top = PEDESTAL_TOP;
  const box = new THREE.Box3();
  for (const e of placed) {
    if (e.lost) continue;
    box.setFromObject(e.mesh, true);
    top = Math.max(top, box.max.y);
  }
  return Math.max(0, top - PEDESTAL_TOP);
}

function onSettled() {
  towerHeight = measureTower();
  if (towerHeight > maxHeight) maxHeight = towerHeight;
  ensureMarkers(Math.ceil(towerHeight) + 3);
  markers.forEach((m, i) => {
    if (!m.reached && towerHeight >= i + 1) {
      m.reached = true;
      m.ring.material.opacity = 0.9;
      sfx.chime(i);
      toast(`${i + 1} metre${i ? 's' : ''}!`);
    }
  });
  updateHud();
  if (lives <= 0) return;
  state = 'aiming';
  spawnHover();
}

function loseLife(entry) {
  entry.lost = true;
  entry.lostAt = 0;
  lives--;
  updateHud();
  sfx.crash();
  shake = 0.35;
  timeScale = 0.3;
  slowmoTimer = 1.1;
  toast(lives > 0 ? 'Wobble!' : 'Timber!');
  if (lives <= 0) {
    setTimeout(gameOver, 1800);
  }
}

function gameOver() {
  if (state === 'title' || state === 'over') return;
  if (hover) {
    scene.remove(hover.mesh);
    hover = null;
  }
  guide.visible = false;
  const isBest = maxHeight > best;
  if (isBest) {
    best = maxHeight;
    store.set('tall-order-best', best);
  }
  $('over-title').textContent = isBest && maxHeight > 0 ? 'New record!' : 'Timber!';
  $('over-height').textContent = maxHeight.toFixed(2);
  $('over-pieces').textContent = placed.filter((e) => !e.lost).length;
  $('over-best').textContent = best.toFixed(2);
  setState('over');
}

// ---------- Main loop ----------
let acc = 0;
let last = performance.now();
let elapsed = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;

  if (world && state !== 'loading') {
    if (slowmoTimer > 0) {
      slowmoTimer -= dt;
      if (slowmoTimer <= 0) timeScale = 1;
    }
    applyGust(dt);
    acc += dt * timeScale;
    let steps = 0;
    while (acc >= STEP && steps < 4) {
      world.step(events);
      acc -= STEP;
      steps++;
    }
    events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const e = colliderToPiece.get(h1) ?? colliderToPiece.get(h2);
      if (!e || elapsed - e.lastSound < 0.12) return;
      const v = e.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      e.lastSound = elapsed;
      sfx.thud(speed / 4, e.piece.def.heaviness ?? 1);
    });
    syncBodies(dt);
  }

  if (state === 'aiming' && hover) updateHover(dt);
  if (state === 'settling') updateSettling(dt);
  updateCamera(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function syncBodies(dt) {
  for (let i = placed.length - 1; i >= 0; i--) {
    const e = placed[i];
    const t = e.body.translation();
    e.mesh.position.set(t.x, t.y, t.z);
    e.mesh.quaternion.copy(e.body.rotation());
    if (!e.lost && t.y < FALL_Y && state !== 'over' && state !== 'title') loseLife(e);
    if (e.lost) {
      e.lostAt += dt;
      if (e.lostAt > 2.5) {
        // Shrink away, then remove for good.
        const s = Math.max(0, 1 - (e.lostAt - 2.5) * 3);
        e.mesh.scale.setScalar(s);
        if (s === 0) {
          scene.remove(e.mesh);
          world.removeRigidBody(e.body);
          placed.splice(i, 1);
        }
      }
    }
  }
}

function updateHover(dt) {
  const h = hover;
  h.born += dt;
  const speed = 2.2 * dt;
  if (keys.has('arrowleft') || keys.has('arrowright') || keys.has('arrowup') || keys.has('arrowdown')) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right);
    if (keys.has('arrowleft')) aim.addScaledVector(right, -speed);
    if (keys.has('arrowright')) aim.addScaledVector(right, speed);
    if (keys.has('arrowup')) aim.addScaledVector(fwd, speed);
    if (keys.has('arrowdown')) aim.addScaledVector(fwd, -speed);
    if (aim.length() > AIM_RADIUS) aim.setLength(AIM_RADIUS);
  }
  const k = 1 - Math.exp(-dt * 14);
  const targetY = hoverY(h.piece) + Math.sin(elapsed * 2.4) * 0.05;
  h.mesh.position.x += (aim.x - h.mesh.position.x) * k;
  h.mesh.position.z += (aim.z - h.mesh.position.z) * k;
  h.mesh.position.y += (targetY - h.mesh.position.y) * (1 - Math.exp(-dt * 6));
  h.mesh.quaternion.slerp(h.targetQuat, 1 - Math.exp(-dt * 16));
  const s = Math.min(1, h.born * 4);
  h.mesh.scale.setScalar(1 - Math.pow(1 - s, 3));
  updateGuide();
}

function updateSettling(dt) {
  settleTimer += dt * timeScale;
  const b = dropped?.body;
  if (!b || dropped.lost) {
    if (settleTimer > 1.2) onSettled();
    return;
  }
  const v = b.linvel();
  const w = b.angvel();
  const calm = Math.hypot(v.x, v.y, v.z) < 0.08 && Math.hypot(w.x, w.y, w.z) < 0.2;
  stillTimer = calm ? stillTimer + dt : 0;
  if ((settleTimer > 0.5 && (stillTimer > 0.35 || b.isSleeping())) || settleTimer > 5) onSettled();
}

function applyGust(dt) {
  if (!(state === 'aiming' || state === 'settling') || towerHeight < GUST_FROM) return;
  if (gustActive > 0) {
    gustActive -= dt;
    const strength = Math.sin((1 - gustActive / 2) * Math.PI) * (0.6 + towerHeight * 0.08);
    for (const e of placed) {
      if (e.lost) continue;
      const m = e.body.mass();
      // Higher pieces catch more wind.
      const lift = Math.max(0, e.body.translation().y - PEDESTAL_TOP) / Math.max(1, towerHeight);
      e.body.addForce({ x: gustDir.x * m * strength * lift, y: 0, z: gustDir.z * m * strength * lift }, true);
    }
    if (gustActive <= 0) {
      $('gust').classList.add('hidden');
      for (const e of placed) e.body.resetForces(true);
    }
    return;
  }
  gustTimer -= dt;
  if (gustTimer <= 0) {
    gustTimer = 14 + Math.random() * 10;
    gustActive = 2;
    const a = Math.random() * Math.PI * 2;
    gustDir.set(Math.cos(a), 0, Math.sin(a));
    // Arrow shows the gust direction as seen from the camera.
    const screen = gustDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -orbit);
    $('gust-arrow').style.transform = `rotate(${Math.atan2(screen.z, screen.x)}rad)`;
    $('gust').classList.remove('hidden');
    sfx.gust();
  }
}

function updateCamera(dt) {
  if (state === 'title' || state === 'loading' || state === 'over') {
    titleSpin += dt * 0.15;
    orbitTarget = orbit = 0.6 + titleSpin;
  } else {
    if (keys.has('a')) orbitTarget += dt * 1.6;
    if (keys.has('d')) orbitTarget -= dt * 1.6;
  }
  orbit += (orbitTarget - orbit) * (1 - Math.exp(-dt * 6));
  const titleView = state === 'title' || state === 'loading';
  const wide = innerWidth / innerHeight >= 1.25;
  const focus = titleView ? PEDESTAL_TOP + 0.9 : PEDESTAL_TOP + towerHeight * 0.8 + 0.4;
  camFocus += (focus - camFocus) * (1 - Math.exp(-dt * 2));
  const narrow = innerWidth / innerHeight < 0.8 ? 1.5 : 1;
  const dist = titleView ? (wide ? 6 : 7.5) : (6.2 + towerHeight * 0.55) * narrow;
  camera.position.set(Math.sin(orbit) * dist, camFocus + 2.2 + towerHeight * 0.15, Math.cos(orbit) * dist);
  // On wide screens the title copy sits on the left, so frame the tower to the right.
  const sideShift = titleView && wide ? 1.7 : 0;
  camera.lookAt(-Math.cos(orbit) * sideShift, camFocus, Math.sin(orbit) * sideShift);
  if (shake > 0) {
    shake -= dt;
    const s = shake * 0.12;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
  sun.position.set(4, camFocus + 8, 3);
  sun.target.position.set(0, camFocus - 1, 0);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------- Boot ----------
async function boot() {
  resize();
  requestAnimationFrame(frame);
  await RAPIER.init();
  createWorld();
  pieces = await loadPieces((p) => ($('load-fill').style.width = `${p * 100}%`));
  makeThumbnails(pieces);
  buildShowcase();
  $('loading').classList.remove('show');
  setState('title');
}

function makeThumbnails(list) {
  const size = 192;
  const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight('#ffffff', '#b07a50', 2.2));
  const l = new THREE.DirectionalLight('#ffffff', 2);
  l.position.set(2, 3, 4);
  s.add(l);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  const px = new Uint8Array(size * size * 4);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  for (const p of list) {
    const m = p.template.clone(true);
    s.add(m);
    const r = p.bounds.getSize(new THREE.Vector3()).length() / 2;
    cam.position.set(r * 2.2, r * 1.4, r * 3.2);
    cam.lookAt(0, 0, 0);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(s, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    g.putImageData(img, 0, 0);
    p.thumb = c.toDataURL();
    s.remove(m);
  }
  renderer.setRenderTarget(null);
  rt.dispose();
}

boot();
