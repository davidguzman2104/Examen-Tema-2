import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Octree } from 'three/addons/math/Octree.js';
import { OctreeHelper } from 'three/addons/helpers/OctreeHelper.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

// ================== Clock, Scene & Camera ==================
const clock = new THREE.Clock();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
scene.fog        = new THREE.Fog(0x0b1020, 0, 35);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.rotation.order = 'YXZ';

// Cámara (anti-vibración)
const CAM_EYE_OFFSET = 0.06, CAM_SPRING = 55, CAM_DAMP = 14;
let camVel = new THREE.Vector3();
const camTarget = new THREE.Vector3();

// ================== Luces ==================
const fillLight1 = new THREE.HemisphereLight(0x8dc1de, 0x00668d, 1.5);
fillLight1.position.set(2, 1, 1);
scene.add(fillLight1);

const directionalLight = new THREE.DirectionalLight(0xffffff, 2.5);
directionalLight.position.set(-5, 25, -1);
directionalLight.castShadow = true;
Object.assign(directionalLight.shadow.camera, { near:0.01, far:500, right:30, left:-30, top:30, bottom:-30 });
directionalLight.shadow.mapSize.set(1024,1024);
directionalLight.shadow.radius = 4;
directionalLight.shadow.bias = -0.00006;
scene.add(directionalLight);

// ================== Renderer ==================
const container = document.getElementById('container');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setAnimationLoop(animate);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

// ================== Stats ==================
const stats = new Stats();
stats.domElement.style.position = 'absolute';
stats.domElement.style.top = '0px';
container.appendChild(stats.domElement);

// ================== Física / Jugador ==================
const GRAVITY = 30, NUM_SPHERES = 100, SPHERE_RADIUS = 0.1, STEPS_PER_FRAME = 5;
const WALK_SPEED = 12, AIR_SPEED = 6, JUMP_SPEED = 8.5;
const SPRINT_MULT = 1.8;
const PITCH_MIN = -Math.PI/2 + 0.001, PITCH_MAX = Math.PI/2 - 0.001;

// ================== Esferas del jugador (click) — visual tipo bala ==================
const sphereMaterial = new THREE.MeshLambertMaterial({ color: 0xFF6A00 });
const BULLET_BASE_AXIS = new THREE.Vector3(0, 1, 0);

function createBulletMesh() {
  const r = SPHERE_RADIUS;
  const bodyRadius = r * 0.55;
  const bodyLen    = r * 2.4;
  const tipLen     = r * 1.2;
  const segs       = 14;

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyLen, segs, 1, true),
    sphereMaterial
  );

  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(bodyRadius * 0.98, tipLen, segs, 1, true),
    sphereMaterial
  );
  tip.position.y = bodyLen * 0.5 + tipLen * 0.5;

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(bodyRadius, segs, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    sphereMaterial
  );
  cap.position.y = -bodyLen * 0.5;
  cap.rotation.x = Math.PI;

  const group = new THREE.Group();
  group.add(body, tip, cap);

  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  return group;
}

const spheres = [];
let sphereIdx = 0;

for (let i = 0; i < NUM_SPHERES; i++) {
  const mesh = createBulletMesh();
  scene.add(mesh);
  spheres.push({
    mesh,
    collider: new THREE.Sphere(new THREE.Vector3(0, -100, 0), SPHERE_RADIUS),
    velocity: new THREE.Vector3()
  });
}

// ================== Mundo / Player ==================
const worldOctree = new Octree();
const playerCollider = new Capsule(new THREE.Vector3(0,0.20,0), new THREE.Vector3(0,0.70,0), 0.25);
const playerVelocity = new THREE.Vector3(), playerDirection = new THREE.Vector3();
let playerOnFloor = false, mouseTime = 0;
const keyStates = {}, vector1 = new THREE.Vector3(), vector2 = new THREE.Vector3(), vector3 = new THREE.Vector3();

// ================== HUD & Combat ==================
const PLAYER_MAX_HP = 500;
const PLAYER_ATTACK_DAMAGE = 25;
const PLAYER_ATTACK_RANGE = 1.4;
const PLAYER_ATTACK_COOLDOWN = 0.5;
const ENEMY_KILL_SCORE = 10;

let playerHP = PLAYER_MAX_HP;
let lastPlayerAttackTime = -Infinity;
let score = 0;
let finalResult = 0;
let gameFinished = false;

const hud = document.createElement('div');
Object.assign(hud.style, {
  position:'absolute',
  left:'10px',
  bottom:'10px',
  color:'#fff',
  font:'14px/1.2 system-ui, sans-serif',
  textShadow:'0 1px 2px #000'
});
hud.innerHTML = 'HP: 500 | Score: 0 | Enemigos: 0';
container.appendChild(hud);

function updateHUD(){
  hud.innerHTML = `HP: ${Math.ceil(playerHP)} | Score: ${score} | Enemigos: ${aliveCount()}`;
}

function resetRunStats(){
  playerHP = PLAYER_MAX_HP;
  lastPlayerAttackTime = -Infinity;
  score = 0;
  finalResult = 0;
  gameFinished = false;
  updateHUD();
}

// ============= Mensajes centrados (banner oleadas / game over) =============
const banner = document.createElement('div');
Object.assign(banner.style,{
  position:'absolute', top:'26%', left:'50%', transform:'translate(-50%,-50%)',
  padding:'12px 20px', background:'rgba(0,0,0,0.55)', color:'#fff',
  font:'700 28px/1 system-ui, sans-serif', borderRadius:'12px',
  letterSpacing:'0.5px', textShadow:'0 2px 4px rgba(0,0,0,.6)',
  opacity:'0', transition:'opacity .25s', pointerEvents:'none'
});
container.appendChild(banner);

let bannerT = null;
function showBanner(text, sec=2){
  banner.textContent = text;
  banner.style.opacity = '1';
  clearTimeout(bannerT);
  bannerT = setTimeout(()=> banner.style.opacity='0', sec*1000);
}

// ================== Crosshair (punto central) ==================
const crosshair = document.createElement('div');
Object.assign(crosshair.style, {
  position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%) scale(1)',
  width:'8px', height:'8px', margin:'0',
  borderRadius:'50%',
  background:'rgba(255,255,255,0.95)',
  boxShadow:'0 0 6px rgba(0,0,0,.6), inset 0 0 2px rgba(0,0,0,.5)',
  pointerEvents:'none', opacity:'0', transition:'opacity .2s, transform .06s'
});
container.appendChild(crosshair);

function updateCrosshairVisibility(){
  crosshair.style.opacity = gameStarted ? '1' : '0';
}

// ================== Utils ==================
const clamp = (x,min,max) => Math.max(min, Math.min(max,x));

function closestPointOnSegment(a,b,p) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(
    ab.dot(p.clone().sub(a)) / Math.max(ab.lengthSq(), 1e-6),
    0,
    1
  );
  return a.clone().addScaledVector(ab, t);
}

/* -------- Spawn seguro jugador -------- */
function spawnPlayerOnFloor(x=0, z=0) {
  const height = playerCollider.end.y - playerCollider.start.y;
  const ray = new THREE.Ray(new THREE.Vector3(x,1000,z), new THREE.Vector3(0,-1,0));
  const hit = worldOctree.rayIntersect(ray);
  const EPS = 0.05;
  const yTop = hit ? hit.position.y + height + playerCollider.radius + EPS : 5;

  playerCollider.start.set(x, yTop-height, z);
  playerCollider.end.set(x, yTop, z);
  playerVelocity.set(0,0,0);
  camera.rotation.set(0,0,0);

  camTarget.copy(playerCollider.end).y += CAM_EYE_OFFSET;
  camera.position.copy(camTarget);
}

// ================== Inputs ==================
document.addEventListener('keydown', e => keyStates[e.code] = true);
document.addEventListener('keyup',   e => keyStates[e.code] = false);

container.addEventListener('mousedown', ()=>{
  if (!gameStarted) return;
  document.body.requestPointerLock();
  mouseTime = performance.now();
  crosshair.style.transform = 'translate(-50%,-50%) scale(0.9)';
});

document.addEventListener('mouseup', ()=>{
  if (!gameStarted) return;
  crosshair.style.transform = 'translate(-50%,-50%) scale(1)';
  if (document.pointerLockElement !== null) throwBall();
});

document.body.addEventListener('mousemove', (e)=>{
  if (!gameStarted) return;
  if (document.pointerLockElement === document.body) {
    camera.rotation.y -= e.movementX/500;
    camera.rotation.x -= e.movementY/500;
    camera.rotation.x = clamp(camera.rotation.x, PITCH_MIN, PITCH_MAX);
  }
});

window.addEventListener('resize', onWindowResize);

function onWindowResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

document.addEventListener('keydown', (ev)=>{
  if(ev.code === 'KeyF') playerAttack();
}, false);

// ================== Estado de juego ==================
let gameStarted = false, assetsReady = false, pendingStart = false;

window.startGame = function startGame(){
  if (gameStarted) return;

  gameStarted = true;
  resetRunStats();

  const scr = document.getElementById('start-screen');
  if (scr) scr.classList.add('hidden');

  if (assetsReady) {
    waveIndex = 0;
    waveActive = false;
    startWave(0);
  } else {
    pendingStart = true;
  }

  showBanner('¡Comienza!', 1.25);
  updateCrosshairVisibility();
};

// ================== Física común ==================
function throwBall(){
  const s = spheres[sphereIdx];
  camera.getWorldDirection(playerDirection);

  s.collider.center
    .copy(playerCollider.end)
    .addScaledVector(playerDirection, playerCollider.radius*1.5);

  const impulse = 15 + 30 * (1 - Math.exp((mouseTime - performance.now()) * 0.001));
  s.velocity.copy(playerDirection).multiplyScalar(impulse);
  s.velocity.addScaledVector(playerVelocity, 2);

  const v = s.velocity.clone();
  if (v.lengthSq() > 1e-10) {
    v.normalize();
    s.mesh.quaternion.setFromUnitVectors(BULLET_BASE_AXIS, v);
  }

  sphereIdx = (sphereIdx + 1) % spheres.length;
}

function physicsCapsuleStep(collider, velocity, dt){
  let damping = Math.exp(-4*dt) - 1;
  velocity.y -= GRAVITY * dt;
  velocity.addScaledVector(velocity, damping);
  collider.translate(velocity.clone().multiplyScalar(dt));

  const res = worldOctree.capsuleIntersect(collider);
  if (res) {
    velocity.addScaledVector(res.normal, -res.normal.dot(velocity));
    if (res.normal.y > 0.5 && res.depth < 0.2) collider.translate(new THREE.Vector3(0,0.03,0));
    if (res.depth >= 1e-10) collider.translate(res.normal.multiplyScalar(res.depth));
  }
  return res;
}
// ================== Player Physics ==================
function playerCollisions(){
  const result = worldOctree.capsuleIntersect(playerCollider);
  playerOnFloor = false;

  if (result) {
    playerOnFloor = result.normal.y > 0;
    if (!playerOnFloor) {
      playerVelocity.addScaledVector(result.normal, -result.normal.dot(playerVelocity));
    }
    if (result.normal.y > 0.5 && result.depth < 0.2) playerCollider.translate(new THREE.Vector3(0,0.03,0));
    if (result.depth >= 1e-10) playerCollider.translate(result.normal.multiplyScalar(result.depth));
  }
}

function updatePlayer(dt){
  let damping = Math.exp(-4*dt) - 1;

  if (!playerOnFloor) {
    playerVelocity.y -= GRAVITY * dt;
    damping *= 0.1;
  }

  playerVelocity.addScaledVector(playerVelocity, damping);
  playerCollider.translate(playerVelocity.clone().multiplyScalar(dt));
  playerCollisions();

  camTarget.copy(playerCollider.end);
  camTarget.y += CAM_EYE_OFFSET;
}

function getForwardVector(){
  camera.getWorldDirection(playerDirection);
  playerDirection.y = 0;
  playerDirection.normalize();
  return playerDirection;
}

function getSideVector(){
  camera.getWorldDirection(playerDirection);
  playerDirection.y = 0;
  playerDirection.normalize();
  playerDirection.cross(camera.up);
  return playerDirection;
}

function controls(dt){
  const isRunning = keyStates['ShiftLeft'] || keyStates['ShiftRight'];
  const base = (playerOnFloor ? WALK_SPEED : AIR_SPEED) * (isRunning ? SPRINT_MULT : 1);
  const speed = dt * base;

  if (keyStates['KeyW'] || keyStates['ArrowUp']) {
    playerVelocity.add(getForwardVector().multiplyScalar(speed));
  }

  if (keyStates['KeyS'] || keyStates['ArrowDown']) {
    playerVelocity.add(getForwardVector().multiplyScalar(-speed));
  }

  if (keyStates['KeyA'] || keyStates['ArrowLeft']) {
    playerVelocity.add(getSideVector().multiplyScalar(-speed));
  }

  if (keyStates['KeyD'] || keyStates['ArrowRight']) {
    playerVelocity.add(getSideVector().multiplyScalar(speed));
  }

  if (playerOnFloor && keyStates['Space']) {
    playerVelocity.y = JUMP_SPEED;
  }
}

function teleportPlayerIfOob(){
  if (camera.position.y <= -25) {
    const box = lastSceneBox || new THREE.Box3(new THREE.Vector3(-1,-1,-1), new THREE.Vector3(1,1,1));
    const c = box.getCenter(new THREE.Vector3());
    spawnPlayerOnFloor(c.x, c.z);
  }
}

// ================== COMBATE: Jugador (melee) ==================
function playerAttack(){
  const now = clock.elapsedTime;
  if (now - lastPlayerAttackTime < PLAYER_ATTACK_COOLDOWN) return;

  lastPlayerAttackTime = now;
  const dir = getForwardVector();
  const origin = playerCollider.end.clone().addScaledVector(dir, 0.5);

  for (const e of enemies) {
    if (e.dead) continue;
    const d = origin.distanceTo(e.center());
    if (d <= PLAYER_ATTACK_RANGE) e.damage(PLAYER_ATTACK_DAMAGE, dir);
  }

  playerVelocity.addScaledVector(dir, 1.5);
}

// ================== PROYECTILES (enemigos) ==================
const projectiles = [];
const FIREBALL_RADIUS = 0.09, FIREBALL_SPEED = 12, FIREBALL_TTL = 4.0;

const fireballGeom = new THREE.SphereGeometry(FIREBALL_RADIUS, 16, 16);
const fireballMat  = new THREE.MeshStandardMaterial({
  color:0xff7a00,
  emissive:0x552200,
  emissiveIntensity:1.2
});

function spawnFireball(origin, dir){
  const mesh = new THREE.Mesh(fireballGeom, fireballMat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.position.copy(origin);
  scene.add(mesh);

  projectiles.push({
    mesh,
    collider: new THREE.Sphere(origin.clone(), FIREBALL_RADIUS),
    velocity: dir.clone().normalize().multiplyScalar(FIREBALL_SPEED),
    ttl: FIREBALL_TTL
  });
}

function updateProjectiles(dt){
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.ttl -= dt;

    if (p.ttl <= 0) {
      scene.remove(p.mesh);
      projectiles.splice(i,1);
      continue;
    }

    p.collider.center.addScaledVector(p.velocity, dt);

    const hit = worldOctree.sphereIntersect(p.collider);
    if (hit) {
      scene.remove(p.mesh);
      projectiles.splice(i,1);
      continue;
    }

    const closest = closestPointOnSegment(playerCollider.start, playerCollider.end, p.collider.center);
    if (closest.distanceToSquared(p.collider.center) <= (FIREBALL_RADIUS + playerCollider.radius) ** 2) {
      playerHP = Math.max(0, playerHP - 12);
      const knock = p.velocity.clone().setY(0).normalize().multiplyScalar(2.5);
      playerVelocity.add(knock);
      scene.remove(p.mesh);
      projectiles.splice(i,1);
      continue;
    }

    p.mesh.position.copy(p.collider.center);
  }
}

// ================== LASERS (enemigos) ==================
const lasers = [];
const LASER_RADIUS   = 0.035;
const LASER_TTL      = 0.12;
const LASER_COOLDOWN = 1.0;
const LASER_RANGE    = 18;
const LASER_DPS      = 24;

const laserMat = new THREE.MeshBasicMaterial({
  color: 0x7ad0ff,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false
});

const laserGeom = new THREE.CylinderGeometry(LASER_RADIUS, LASER_RADIUS, 1, 12);

function spawnLaserBeam(from, to){
  const len  = from.distanceTo(to);
  const mid  = from.clone().lerp(to, 0.5);
  const dir  = to.clone().sub(from).normalize();

  const mesh = new THREE.Mesh(laserGeom, laserMat);
  mesh.frustumCulled = false;
  mesh.position.copy(mid);
  mesh.scale.set(1, len, 1);

  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
  mesh.quaternion.copy(q);

  scene.add(mesh);
  lasers.push({ mesh, ttl: LASER_TTL });
}

function updateLasers(dt){
  for (let i = lasers.length - 1; i >= 0; i--) {
    lasers[i].ttl -= dt;
    if (lasers[i].ttl <= 0) {
      scene.remove(lasers[i].mesh);
      lasers.splice(i,1);
    }
  }
}

// ================== ENEMIGOS FBX ==================
const enemies = [];
const fbxEnemyLoader = new FBXLoader().setPath('./models/fbx/enemy/');
let ENEMY_BASE = null, ENEMY_CLIPS = {}, ENEMY_READY = false;

// Ajustes IA / anim
const ENEMY_SCALE = 0.014, ENEMY_FOOT_OFFSET = 0.01, FLOOR_SNAP_MAX = 1.2, SPRING_Y = 60, DAMP_Y = 12, ROT_LERP = 0.15;
const ENEMY_WALK_SPEED = 1.8, DETECT_RADIUS = 18, LOSE_RADIUS = 26;
const FOV_DEG = 200;
const COS_FOV_HALF = Math.cos(THREE.MathUtils.degToRad(FOV_DEG * 0.5));
const SHOOT_MIN = 2.5, SHOOT_MAX = 8.0, SHOOT_COOLDOWN = 1.8;

// Spawns / separación
const MIN_SEPARATION = 6.0;
const MIN_GROUND_NORMAL_Y_STRICT = 0.87;
let SPAWN_MIN_Y = null, lastSceneBox = null;

// ====== Oleadas ======
const MAX_ALIVE_ENEMIES = 30;
const WAVE_SIZES = [10, 10, 10];
let waveIndex = 0;
let waveActive = false;

// Distancia al jugador para spawns
const SPAWN_NEAR_MIN = 6;
const SPAWN_NEAR_MAX = 20;

// ====== Clasificación de suelo y límites ======
const TAGS = { GRASS:'grass', CONSTRUCTION:'construction' };
let spawnRayTargets = [];
const raycaster = new THREE.Raycaster();

const LEVEL_MARGIN_XZ = 25;
let innerBox = null;
let constructionBoxes = [];

function markGroundTags(root){
  const reGrass = /(grass|pasto|césped|cesped|lawn|hierba)/i;
  const reCons  = /(wall|floor|piso|pared|concrete|cement|cemento|concreto|tile|brick|ladrillo|road|street|calle|asphalt|asfalto|building|edificio|roof|techo|platform|plataforma|stairs|ramp|wood|madera|metal|pavement|sidewalk|banqueta)/i;

  root.traverse((o)=>{
    if (o.isMesh){
      spawnRayTargets.push(o);
      const names = [o.name || '', o.material?.name || ''];
      const mats = Array.isArray(o.material) ? o.material : [o.material];

      for (const m of mats){
        if (!m) continue;
        const src = (m.map?.name || '') + ' ' + (m.map?.source?.data?.src || '');
        names.push(src);
      }

      const all = names.join(' ').toLowerCase();
      if (reGrass.test(all)) o.userData.groundTag = TAGS.GRASS;
      else if (reCons.test(all)) o.userData.groundTag = TAGS.CONSTRUCTION;
    }
  });
}

function buildConstructionBoxes(root){
  constructionBoxes = [];
  root.updateWorldMatrix(true, true);
  root.traverse(o=>{
    if (o.isMesh && o.userData?.groundTag === TAGS.CONSTRUCTION){
      const box = new THREE.Box3().setFromObject(o);
      constructionBoxes.push(box);
    }
  });
}

function groundHitAt(x,z){
  raycaster.set(new THREE.Vector3(x,1000,z), new THREE.Vector3(0,-1,0));
  const hits = raycaster.intersectObjects(spawnRayTargets, true);
  return hits[0] || null;
}

function groundTagAt(x,z){
  const h = groundHitAt(x,z);
  return h?.object?.userData?.groundTag || null;
}

function isInsideInnerBoxXZ(x,z){
  if (!innerBox) return true;
  return (x >= innerBox.min.x && x <= innerBox.max.x && z >= innerBox.min.z && z <= innerBox.max.z);
}

function isNearConstructionXZ(x,z, pad=10){
  if (!constructionBoxes.length) return true;
  for (const b of constructionBoxes){
    if (x >= (b.min.x - pad) && x <= (b.max.x + pad) && z >= (b.min.z - pad) && z <= (b.max.z + pad)) return true;
  }
  return false;
}

// ===== Carga assets enemigo
const CLIP_FILES = {
  Idle:'Idle.fbx',
  Walk:'Walk.fbx',
  Run:'Run.fbx',
  Attack:'Attack.fbx',
  Hit:'Hit.fbx',
  Die:'Die.fbx'
};

async function loadEnemyAssets(){
  if (ENEMY_READY) return true;

  try {
    ENEMY_BASE = await fbxEnemyLoader.loadAsync('skin.fbx');
    ENEMY_BASE.scale.setScalar(ENEMY_SCALE);
    ENEMY_BASE.traverse(c=>{ if (c.isMesh) { c.castShadow = c.receiveShadow = true; }});
  } catch(e) {
    console.error('[Enemy] skin.fbx no cargó:', e);
    ENEMY_BASE = null;
  }

  for (const [name,file] of Object.entries(CLIP_FILES)) {
    try {
      const f = await fbxEnemyLoader.loadAsync(file);
      if (f.animations && f.animations[0]) ENEMY_CLIPS[name] = f.animations[0];
    } catch {
      console.warn(`[Anim] falta clip ${file}`);
    }
  }

  ENEMY_READY = true;
  return true;
}

// ===== Visión / awareness
function hasLineOfSight(from,to){
  const dir = new THREE.Vector3().subVectors(to,from);
  const len = dir.length();
  if (len < 1e-6) return true;

  dir.divideScalar(len);
  const ray = new THREE.Ray(from, dir);
  const hit = worldOctree.rayIntersect(ray);
  if (!hit) return true;

  const hitDist = hit.position ? hit.position.distanceTo(from) : (hit.distance ?? 0);
  return hitDist > (len - 0.05);
}

function canSeePlayer(enemyCenter, enemyForward){
  const toPlayer = new THREE.Vector3().subVectors(playerCollider.end, enemyCenter);
  const dist = toPlayer.length();
  if (dist > DETECT_RADIUS) return false;

  if (enemyForward) {
    const dir = toPlayer.clone().setY(0).normalize();
    if (dir.lengthSq() > 1e-6) {
      const dot = dir.dot(enemyForward.clone().setY(0).normalize());
      if (dot < COS_FOV_HALF) return false;
    }
  }

  const eye = enemyCenter.clone();
  return hasLineOfSight(eye, playerCollider.end.clone());
}
// ===== Clase Enemy
class Enemy{
  constructor(x,z, tag){
    this.collider = new Capsule(new THREE.Vector3(x,0.18,z), new THREE.Vector3(x,1.18,z), 0.22);
    this.velocity = new THREE.Vector3();
    this.attackRange = 1.2;
    this.attackDamage = 10;
    this.attackCooldown = 1.0;
    this.lastAttackTime = -Infinity;
    this.lastShootTime = -Infinity;
    this.lastLaserTime = -Infinity;
    this.hp = 60;
    this.dead = false;
    this.tag = tag || null;
    this.dieEndTime = null;

    this.state = 'Idle';
    this.forward = new THREE.Vector3(0,0,1);
    this.model = null;
    this.mixer = null;
    this.actions = {};
    this._yVis = 0;
    this._yVel = 0;
    this.headOffsetY = 1.2;

    loadEnemyAssets().then(() => {
      if (ENEMY_BASE) this.model = SkeletonUtils.clone(ENEMY_BASE);
      else {
        const m = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.25,0.8,4,8),
          new THREE.MeshStandardMaterial({ color:0xff3b3b })
        );
        m.castShadow = m.receiveShadow = true;
        this.model = m;
      }

      scene.add(this.model);

      if (Object.keys(ENEMY_CLIPS).length && this.model && ENEMY_BASE) {
        this.mixer = new THREE.AnimationMixer(this.model);
        this.actions.Idle   = ENEMY_CLIPS.Idle   ? this.mixer.clipAction(ENEMY_CLIPS.Idle).play() : null;
        this.actions.Walk   = ENEMY_CLIPS.Walk   ? this.mixer.clipAction(ENEMY_CLIPS.Walk).play() : null;
        this.actions.Attack = ENEMY_CLIPS.Attack ? this.mixer.clipAction(ENEMY_CLIPS.Attack) : null;
        this.actions.Hit    = ENEMY_CLIPS.Hit    ? this.mixer.clipAction(ENEMY_CLIPS.Hit) : null;
        this.actions.Die    = ENEMY_CLIPS.Die    ? this.mixer.clipAction(ENEMY_CLIPS.Die) : null;

        if (this.actions.Idle) this.actions.Idle.setEffectiveWeight(1);
        if (this.actions.Walk) this.actions.Walk.setEffectiveWeight(0);

        ['Attack','Hit','Die'].forEach(n=>{
          const a = this.actions[n];
          if(a){
            a.setLoop(THREE.LoopOnce,1);
            a.clampWhenFinished = true;
          }
        });
      }

      const mid = this.center();
      const yG = this.getGroundY(mid.x, mid.z, this.collider.start.y);
      const y = (yG !== null ? yG + ENEMY_FOOT_OFFSET : this.collider.start.y);
      this._yVis = y;
      this.model.position.set(mid.x, this._yVis, mid.z);
      this.model.quaternion.identity();

      try {
        const box = new THREE.Box3().setFromObject(this.model);
        const alturaDesdeBase = box.max.y - this.model.position.y;
        this.headOffsetY = Math.max(0.9, alturaDesdeBase * 0.92 - 0.02);
      } catch(e) {}
    });
  }

  center(){
    return new THREE.Vector3()
      .addVectors(this.collider.start,this.collider.end)
      .multiplyScalar(0.5);
  }

  getGroundY(x,z,yStart){
    const ray = new THREE.Ray(new THREE.Vector3(x,yStart+0.8,z), new THREE.Vector3(0,-1,0));
    const hit = worldOctree.rayIntersect(ray);
    if (hit) {
      const dy = (yStart + 0.8) - hit.position.y;
      if (dy <= FLOOR_SNAP_MAX) return hit.position.y;
    }
    return null;
  }

  setAnimWeights(idleW, walkW){
    if (this.actions.Idle) this.actions.Idle.setEffectiveWeight(idleW);
    if (this.actions.Walk) {
      this.actions.Walk.setEffectiveWeight(walkW);
      const vH = Math.hypot(this.velocity.x, this.velocity.z);
      const tScale = THREE.MathUtils.clamp(vH / 1.4, 0.6, 1.6);
      this.actions.Walk.setEffectiveTimeScale(tScale);
    }
  }

  damage(dmg, knockbackDir=null){
    if (this.dead) return;

    this.hp -= dmg;

    if (this.hp <= 0) {
      this.dead = true;
      score += ENEMY_KILL_SCORE;
      updateHUD();

      if (this.actions.Idle) this.actions.Idle.fadeOut(0.05).setEffectiveWeight(0);
      if (this.actions.Walk) this.actions.Walk.fadeOut(0.05).setEffectiveWeight(0);
      if (this.actions.Attack) this.actions.Attack.stop();
      if (this.actions.Hit) this.actions.Hit.stop();

      if (this.actions.Die) {
        this.actions.Die.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
        const dur = this.actions.Die.getClip().duration;
        this.dieEndTime = clock.elapsedTime + dur + 0.05;
      } else {
        this.dieEndTime = clock.elapsedTime + 1.0;
      }

      this.velocity.multiplyScalar(0.2);
      return;
    }

    if (this.actions.Hit) this.actions.Hit.reset().setEffectiveWeight(1).fadeIn(0.06).play();
    if (knockbackDir) this.velocity.addScaledVector(knockbackDir, 5);
  }

  shootEyeLasers(now){
    if (now - this.lastLaserTime < LASER_COOLDOWN) return false;

    const mid = this.center();

    const eyeBase = this.model
      ? new THREE.Vector3(mid.x, this.model.position.y + (this.headOffsetY || 1.2), mid.z)
      : new THREE.Vector3(mid.x, this.collider.end.y + 0.35, mid.z);

    let fwd = this.forward.lengthSq() ? this.forward.clone() : new THREE.Vector3(0,0,1);
    if (this.model) fwd = new THREE.Vector3(0,0,1).applyQuaternion(this.model.quaternion);
    fwd.setY(0).normalize();

    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), fwd).normalize();
    const eyeL = eyeBase.clone().addScaledVector(right, -0.12);
    const eyeR = eyeBase.clone().addScaledVector(right,  0.12);

    const target = playerCollider.end.clone();
    const dist   = eyeBase.distanceTo(target);

    const los = hasLineOfSight(eyeBase, target) && dist <= LASER_RANGE;

    let endL, endR;
    if (los){
      endL = target.clone();
      endR = target.clone();

      const dmgPulse = (LASER_DPS * LASER_TTL) * 0.5;
      playerHP = Math.max(0, playerHP - dmgPulse);

      const push = target.clone().sub(eyeBase).setY(0).normalize().multiplyScalar(0.4);
      playerVelocity.add(push);
    } else {
      const dir = target.clone().sub(eyeBase).normalize();
      const ray = new THREE.Ray(eyeBase, dir);
      const hit = worldOctree.rayIntersect(ray);
      const fallback = eyeBase.clone().addScaledVector(dir, LASER_RANGE);

      const stop = hit ? hit.position : fallback;
      endL = stop.clone();
      endR = stop.clone();
    }

    spawnLaserBeam(eyeL, endL);
    spawnLaserBeam(eyeR, endR);
    this.lastLaserTime = now;
    return true;
  }

  tryShoot(toPlayer, now){
    if (now - this.lastShootTime < SHOOT_COOLDOWN) return false;

    const dist = toPlayer.length();
    if (dist < SHOOT_MIN || dist > SHOOT_MAX) return false;

    const mid = this.center();
    const eye = mid.clone().add(new THREE.Vector3(0,0.9,0));
    const dir = playerCollider.end.clone().sub(eye).normalize();

    if (!hasLineOfSight(eye, playerCollider.end)) return false;

    const muzzle = eye.clone().add(dir.clone().multiplyScalar(0.35));
    spawnFireball(muzzle, dir);
    this.lastShootTime = now;
    return true;
  }

  update(delta){
    if (this.dead) {
      if (this.mixer) this.mixer.update(delta);
      if (this.dieEndTime && clock.elapsedTime >= this.dieEndTime && this.model) {
        scene.remove(this.model);
        this.model = null;
      }
      return;
    }

    const mid = this.center();
    const toPlayer = new THREE.Vector3().subVectors(playerCollider.end, mid);
    const dist = toPlayer.length();

    let forwardForFov = null;
    if (this.model) forwardForFov = new THREE.Vector3(0,0,1).applyQuaternion(this.model.quaternion);

    const sees = canSeePlayer(mid, forwardForFov);
    const aware = dist <= DETECT_RADIUS;

    if (this.model && aware) {
      const dirFlat = new THREE.Vector3(toPlayer.x, 0, toPlayer.z).normalize();
      if (dirFlat.lengthSq() > 1e-6) {
        const targetYaw = Math.atan2(dirFlat.x, dirFlat.z);
        const qTarget = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, targetYaw, 0));
        this.model.quaternion.slerp(qTarget, ROT_LERP);
        this.forward.copy(dirFlat);
      }
    }

    if (this.state === 'Idle') {
      this.setAnimWeights(1.0, 0.0);
      if (sees || aware) this.state = 'Walk';
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    } else if (this.state === 'Walk') {
      const dir = toPlayer.setY(0).normalize();

      if (sees) {
        const usedLaser = this.shootEyeLasers(clock.elapsedTime);
        const didShoot = usedLaser ? false : this.tryShoot(toPlayer.clone(), clock.elapsedTime);

        if (dist <= this.attackRange && clock.elapsedTime - this.lastAttackTime > this.attackCooldown) {
          this.lastAttackTime = clock.elapsedTime;
          playerHP = Math.max(0, playerHP - this.attackDamage);
          if (this.actions.Attack) this.actions.Attack.reset().setEffectiveWeight(1).fadeIn(0.05).play();
          this.velocity.x *= 0.3;
          this.velocity.z *= 0.3;
        } else if (!didShoot && !usedLaser && dist > this.attackRange * 1.3) {
          this.velocity.addScaledVector(dir, ENEMY_WALK_SPEED * delta);
        } else if (dist >= SHOOT_MIN && dist <= SHOOT_MAX) {
          this.velocity.addScaledVector(dir, ENEMY_WALK_SPEED * delta * 0.3);
        }

        if (usedLaser) this.velocity.multiplyScalar(0.7);
      } else if (aware) {
        this.velocity.addScaledVector(dir, ENEMY_WALK_SPEED * delta * 0.6);
      }

      const vH = Math.hypot(this.velocity.x, this.velocity.z);
      const walkW = THREE.MathUtils.clamp(vH / 1.5, 0.0, 1.0);
      this.setAnimWeights(1.0 - walkW, walkW);

      if (!aware && dist > LOSE_RADIUS) {
        this.state = 'Idle';
        this.velocity.x *= 0.5;
        this.velocity.z *= 0.5;
      }
    }

    physicsCapsuleStep(this.collider, this.velocity, delta);
    this.velocity.x *= 0.94;
    this.velocity.z *= 0.94;

    if (this.mixer) this.mixer.update(delta);

    if (this.model) {
      const yG = this.getGroundY(mid.x, mid.z, this.collider.start.y);
      const yT = (yG !== null ? yG + ENEMY_FOOT_OFFSET : this.collider.start.y);
      const dy = yT - this._yVis;
      this._yVel += dy * SPRING_Y * delta;
      this._yVel *= Math.exp(-DAMP_Y * delta);
      this._yVis += this._yVel * delta;
      this.model.position.set(mid.x, this._yVis, mid.z);
    }
  }
}

// ===== Utilidades de terreno / spawn =====
function rayGround(x,z){
  return worldOctree.rayIntersect(new THREE.Ray(new THREE.Vector3(x,1000,z), new THREE.Vector3(0,-1,0)));
}

function groundYAt(x,z,fallbackY=5){
  const hit = rayGround(x,z);
  return hit ? hit.position.y : fallbackY;
}

function sampleSpawnHeightThreshold(samples=600){
  if (!lastSceneBox) return null;

  const min = lastSceneBox.min, max = lastSceneBox.max, arr = [];
  for(let i=0;i<samples;i++){
    const x = THREE.MathUtils.lerp(min.x,max.x,Math.random());
    const z = THREE.MathUtils.lerp(min.z,max.z,Math.random());
    const hit = rayGround(x,z);
    if(!hit) continue;

    const tag = groundTagAt(x,z);
    if (tag === TAGS.GRASS) continue;
    if (hit.normal && hit.normal.y >= MIN_GROUND_NORMAL_Y_STRICT) arr.push(hit.position.y);
  }

  if (arr.length < 10) return null;
  arr.sort((a,b)=>a-b);
  return arr[Math.floor((arr.length-1)*0.7)];
}

function farFromExisting(x,y,z, minDist=MIN_SEPARATION){
  const d2min = minDist*minDist;
  for (const e of enemies) {
    const c = e.center();
    if (c.distanceToSquared(new THREE.Vector3(x,y,z)) < d2min) return false;
  }
  return true;
}

function canPlaceHereParam(
  x,z,
  minNormalY,
  minYOrNull,
  minPlayerDist2 = SPAWN_NEAR_MIN*SPAWN_NEAR_MIN,
  maxPlayerDist2 = SPAWN_NEAR_MAX*SPAWN_NEAR_MAX
){
  const hit = rayGround(x,z);
  if (!hit) return false;
  if (!hit.normal || hit.normal.y < minNormalY) return false;
  if (!isInsideInnerBoxXZ(x,z)) return false;

  const tag = groundTagAt(x,z);
  if (tag === TAGS.GRASS) return false;
  if (!isNearConstructionXZ(x,z, 10)) return false;

  const y = hit.position.y;
  if (minYOrNull != null && y < (minYOrNull - 0.2)) return false;

  const pj = playerCollider.end;
  const d2 = pj.distanceToSquared(new THREE.Vector3(x,y,z));
  if (d2 < minPlayerDist2 || d2 > maxPlayerDist2) return false;
  if (!farFromExisting(x,y,z, MIN_SEPARATION)) return false;

  return true;
}

function pickSpawnPointsGridPreferHigh(N, gridN=5){
  const pts = [];
  if(!lastSceneBox) return pts;

  const min = lastSceneBox.min.clone(), max = lastSceneBox.max.clone();
  const sizeX = (max.x - min.x) / gridN, sizeZ = (max.z - min.z) / gridN;

  for (let gz=0; gz<gridN; gz++) {
    for (let gx=0; gx<gridN; gx++) {
      if (pts.length >= N) break;

      let chosen = null;
      for (let t=0; t<18; t++){
        const x = min.x + gx*sizeX + Math.random()*sizeX;
        const z = min.z + gz*sizeZ + Math.random()*sizeZ;
        if (!canPlaceHereParam(x, z, MIN_GROUND_NORMAL_Y_STRICT, SPAWN_MIN_Y)) continue;

        const y = groundYAt(x,z,0);
        let ok = true;
        for (const p of pts) {
          if (p.distanceToSquared(new THREE.Vector3(x,y,z)) < MIN_SEPARATION * MIN_SEPARATION) {
            ok = false;
            break;
          }
        }

        if (ok) {
          chosen = new THREE.Vector3(x,y,z);
          break;
        }
      }

      if (chosen) pts.push(chosen);
    }
  }

  return pts;
}

function pickSpawnLoose(N){
  const pts = [];
  if(!lastSceneBox) return pts;

  const min = innerBox ? innerBox.min : lastSceneBox.min;
  const max = innerBox ? innerBox.max : lastSceneBox.max;
  let tries = 0;

  while (pts.length < N && tries < 3000){
    const x = THREE.MathUtils.lerp(min.x, max.x, Math.random());
    const z = THREE.MathUtils.lerp(min.z, max.z, Math.random());
    const hit = rayGround(x,z);

    if (hit){
      const tag = groundTagAt(x,z);
      if (tag === TAGS.GRASS) { tries++; continue; }
      if (!isNearConstructionXZ(x,z, 10)) { tries++; continue; }
      if (!isInsideInnerBoxXZ(x,z)) { tries++; continue; }

      const y = hit.position.y;
      const d2 = playerCollider.end.distanceToSquared(new THREE.Vector3(x,y,z));
      if (d2 >= SPAWN_NEAR_MIN*SPAWN_NEAR_MIN && d2 <= SPAWN_NEAR_MAX*SPAWN_NEAR_MAX){
        let ok = true;
        for (const p of pts) {
          if (p.distanceToSquared(new THREE.Vector3(x,y,z)) < 16) {
            ok = false;
            break;
          }
        }
        if (ok) pts.push(new THREE.Vector3(x,y,z));
      }
    }

    tries++;
  }

  return pts;
}

function forceSpawnRingAroundPlayer(N){
  const pts = [];
  let tries = 0;
  const base = playerCollider.end.clone();

  while (pts.length < N && tries < 1800){
    const ang = Math.random()*Math.PI*2;
    const r = THREE.MathUtils.randFloat(SPAWN_NEAR_MIN, Math.max(SPAWN_NEAR_MIN+1, SPAWN_NEAR_MAX*0.9));
    const x = base.x + Math.cos(ang)*r;
    const z = base.z + Math.sin(ang)*r;
    const hit = rayGround(x,z);

    if (hit){
      const tag = groundTagAt(x,z);
      if (tag === TAGS.GRASS) { tries++; continue; }
      if (!isNearConstructionXZ(x,z, 10)) { tries++; continue; }
      if (!isInsideInnerBoxXZ(x,z)) { tries++; continue; }

      const y = hit.position.y;
      let ok = true;
      for (const p of pts) {
        if (p.distanceToSquared(new THREE.Vector3(x,y,z)) < 20.25) {
          ok = false;
          break;
        }
      }
      if (ok) pts.push(new THREE.Vector3(x,y,z));
    }

    tries++;
  }

  return pts;
}

function spawnEnemyOnFloor(x,z, tag=null){
  const height = 1.4;
  const yTop = groundYAt(x,z) + height;
  const e = new Enemy(x,z, tag);

  const cx = x, cy = yTop - height*0.5, cz = z;
  e.collider.start.set(cx, cy-0.5, cz);
  e.collider.end.set(cx, cy+0.5, cz);

  enemies.push(e);
  return e;
}

function spawnEnemiesFromPoints(pts, tag){
  for (const p of pts) spawnEnemyOnFloor(p.x,p.z,tag);
}

function spawnEnemiesDistributedSafe(N, tag){
  let pts = pickSpawnPointsGridPreferHigh(N, 5);
  if (pts.length < N) pts = pts.concat(pickSpawnLoose(N - pts.length));
  if (pts.length < N) pts = pts.concat(forceSpawnRingAroundPlayer(N - pts.length));

  let guard = 0;
  while (pts.length < N && guard < 10){
    pts = pts.concat(forceSpawnRingAroundPlayer(N - pts.length));
    guard++;
  }

  if (pts.length === 0) {
    console.warn('[Spawn] Sin puntos. Forzando 1 enemigo frente al jugador en construcción si es posible.');
    const f = getForwardVector();
    const base = playerCollider.end.clone().addScaledVector(f, 6);
    const t = groundTagAt(base.x, base.z);
    if (t !== TAGS.GRASS && isNearConstructionXZ(base.x, base.z, 10) && isInsideInnerBoxXZ(base.x, base.z)) {
      pts.push(new THREE.Vector3(base.x, groundYAt(base.x, base.z), base.z));
    }
  }

  spawnEnemiesFromPoints(pts.slice(0,N), tag);
}

// ====== Gestor de OLEADAS ======
function aliveCount(){
  return enemies.filter(e => !e.dead && e.model !== null).length;
}

function aliveInWave(tag){
  return enemies.some(e => e.tag === tag && !e.dead && e.model !== null);
}

function startWave(index){
  if (index >= WAVE_SIZES.length) return;

  const tag = `wave${index+1}`;
  const cap = Math.max(0, MAX_ALIVE_ENEMIES - aliveCount());
  const toSpawn = Math.min(WAVE_SIZES[index], cap);

  if (toSpawn <= 0) return;

  spawnEnemiesDistributedSafe(toSpawn, tag);
  waveActive = true;
  showBanner(`¡Oleada ${index+1}!`, 2.2);
  console.log(`[WAVES] Lanzada ${tag} con ${toSpawn}`);
  updateHUD();
}

// ================== Carga del escenario ==================
const loader = new GLTFLoader().setPath('./models/gltf/');
loader.load('clock_tower_free_fire_model.glb', async (gltf)=>{
  gltf.scene.scale.set(0.1,0.1,0.1);
  scene.add(gltf.scene);
  worldOctree.fromGraphNode(gltf.scene);

  gltf.scene.traverse(child=>{
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      if (child.material && child.material.map) child.material.map.anisotropy = 4;
    }
  });

  markGroundTags(gltf.scene);
  buildConstructionBoxes(gltf.scene);

  const helper = new OctreeHelper(worldOctree);
  helper.visible = false;
  scene.add(helper);

  const gui = new GUI({ width: 240 });
  const debugObj = {'Octree debug': false};
  gui.add(debugObj, 'Octree debug').onChange(v => helper.visible = v);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  lastSceneBox = box.clone();
  innerBox = box.clone();
  innerBox.min.add(new THREE.Vector3(LEVEL_MARGIN_XZ, 0, LEVEL_MARGIN_XZ));
  innerBox.max.add(new THREE.Vector3(-LEVEL_MARGIN_XZ, 0, -LEVEL_MARGIN_XZ));

  const center = box.getCenter(new THREE.Vector3());
  spawnPlayerOnFloor(center.x, center.z);

  SPAWN_MIN_Y = sampleSpawnHeightThreshold(800);
  if (SPAWN_MIN_Y == null) SPAWN_MIN_Y = playerCollider.end.y + 0.4;

  await loadEnemyAssets();

  assetsReady = true;
  if (gameStarted || pendingStart) {
    pendingStart = false;
    waveIndex = 0;
    waveActive = false;
    startWave(0);
  }

  updateCrosshairVisibility();
  updateHUD();
});

// ================== Bucle ==================
function animate(){
  const frameDelta = clock.getDelta();
  const dt = Math.min(0.05, frameDelta) / STEPS_PER_FRAME;

  if (!gameStarted){
    renderer.render(scene, camera);
    stats.update();
    return;
  }

  for (let i=0; i<STEPS_PER_FRAME; i++){
    controls(dt);
    updatePlayer(dt);
    updateSpheres(dt);
    updateProjectiles(dt);
    updateLasers(dt);
    teleportPlayerIfOob();

    for (const e of enemies){
      if (e.model) {
        e.update(dt);
        resolvePlayerEnemyPush(e);
      }
    }
  }

  if (waveActive && !gameFinished) {
    const currentTag = `wave${waveIndex+1}`;
    if (!aliveInWave(currentTag)) {
      waveActive = false;

      if (waveIndex + 1 < WAVE_SIZES.length) {
        waveIndex++;
        startWave(waveIndex);
      } else {
        gameFinished = true;
        finalResult = Math.ceil(playerHP) + score;
        showBanner(`¡Victoria! HP restante: ${Math.ceil(playerHP)} | Score: ${score} | Resultado final: ${finalResult}`, 5);
        console.log('[WAVES] ¡Todas las oleadas completadas!');
      }
    }
  }

  const diff = camTarget.clone().sub(camera.position);
  camVel.addScaledVector(diff, CAM_SPRING * frameDelta);
  camVel.multiplyScalar(Math.exp(-CAM_DAMP * frameDelta));
  camera.position.addScaledVector(camVel, frameDelta);

  updateHUD();

  if (playerHP <= 0) {
    showBanner('GAME OVER', 2.5);
    playerHP = PLAYER_MAX_HP;
    const c = camera.position;
    spawnPlayerOnFloor(c.x, c.z);
    updateHUD();
  }

  renderer.render(scene, camera);
  stats.update();
}

// ================== Empuje jugador–enemigo ==================
function resolvePlayerEnemyPush(e){
  if (e.dead || !e.model) return;

  const r = e.collider.radius + playerCollider.radius;
  const pMid = new THREE.Vector3().addVectors(playerCollider.start, playerCollider.end).multiplyScalar(0.5);
  const eMid = e.center();
  const diff = new THREE.Vector3().subVectors(pMid, eMid);
  const d = diff.length();

  if (d < r) {
    const n = diff.normalize();
    const pen = (r - d) * 0.8;
    playerCollider.translate(n.clone().multiplyScalar(pen*0.5));
    e.collider.translate(n.clone().multiplyScalar(-pen*0.5));

    const vnP = n.dot(playerVelocity);
    if (vnP < 0) playerVelocity.addScaledVector(n, -vnP*0.7);

    const vnE = n.dot(e.velocity);
    if (vnE > 0) e.velocity.addScaledVector(n, -vnE*0.7);
  }
}

// ================== Esferas jugador (incluye kill a enemigos) ==================
function playerSphereCollision(sphere){
  const center = vector1.addVectors(playerCollider.start, playerCollider.end).multiplyScalar(0.5);
  const sc = sphere.collider.center;
  const r = playerCollider.radius + sphere.collider.radius;
  const r2 = r*r;

  for (const point of [playerCollider.start, playerCollider.end, center]) {
    const d2 = point.distanceToSquared(sc);
    if (d2 < r2) {
      const normal = vector1.subVectors(point, sc).normalize();
      const v1 = vector2.copy(normal).multiplyScalar(normal.dot(playerVelocity));
      const v2 = vector3.copy(normal).multiplyScalar(normal.dot(sphere.velocity));
      playerVelocity.add(v2).sub(v1);
      sphere.velocity.add(v1).sub(v2);
      const d = (r - Math.sqrt(d2))/2;
      sc.addScaledVector(normal, -d);
    }
  }
}

function sphereEnemyCollision(sphere){
  const c = sphere.collider.center;

  for (const e of enemies){
    if (e.dead || !e.model) continue;

    const p = closestPointOnSegment(e.collider.start, e.collider.end, c);
    const sumR = e.collider.radius + sphere.collider.radius;

    if (p.distanceToSquared(c) <= sumR*sumR) {
      const kb = sphere.velocity.clone().setY(0);
      e.damage(999, kb.lengthSq() ? kb.normalize() : null);
      sphere.velocity.set(0,0,0);
      sphere.collider.center.set(0,-100,0);
      sphere.mesh.position.copy(sphere.collider.center);
      break;
    }
  }
}

function spheresCollisions(){
  for (let i=0; i<spheres.length; i++){
    const s1 = spheres[i];
    for (let j=i+1; j<spheres.length; j++){
      const s2 = spheres[j];
      const d2 = s1.collider.center.distanceToSquared(s2.collider.center);
      const r = s1.collider.radius + s2.collider.radius;
      const r2 = r*r;

      if (d2 < r2) {
        const normal = vector1.subVectors(s1.collider.center, s2.collider.center).normalize();
        const v1 = vector2.copy(normal).multiplyScalar(normal.dot(s1.velocity));
        const v2 = vector3.copy(normal).multiplyScalar(normal.dot(s2.velocity));
        s1.velocity.add(v2).sub(v1);
        s2.velocity.add(v1).sub(v2);
        const d = (r - Math.sqrt(d2))/2;
        s1.collider.center.addScaledVector(normal, d);
        s2.collider.center.addScaledVector(normal, -d);
      }
    }
  }
}

function updateSpheres(dt){
  spheres.forEach(s=>{
    s.collider.center.addScaledVector(s.velocity, dt);

    const result = worldOctree.sphereIntersect(s.collider);
    if (result) {
      s.velocity.addScaledVector(result.normal, -result.normal.dot(s.velocity)*1.5);
      s.collider.center.add(result.normal.multiplyScalar(result.depth));
    } else {
      s.velocity.y -= GRAVITY*dt;
    }

    const damping = Math.exp(-1.5*dt) - 1;
    s.velocity.addScaledVector(s.velocity, damping);

    playerSphereCollision(s);
    sphereEnemyCollision(s);
  });

  spheresCollisions();

  for (const s of spheres) {
    s.mesh.position.copy(s.collider.center);
    if (s.velocity.lengthSq() > 1e-10) {
      vector1.copy(s.velocity).normalize();
      s.mesh.quaternion.setFromUnitVectors(BULLET_BASE_AXIS, vector1);
    }
  }
}
