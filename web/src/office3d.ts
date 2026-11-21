// The 3D agent office (Three.js): one animated AI robot per role at its own desk, a wall screen behind each desk with
// what the events say that role is doing, and the harness check gate in the middle. When the harness passes work on,
// the sender walks the document to the gate, the gate scans it, and the document travels to the next desk.
// Everything on screen comes from the run's events (moods from steps, screen text from stationOf, routes from hand-offs).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { LampState, Mood } from './scene.ts';
import { GATE_AT, OBSTACLES, SPOTS, nextPlan, route, seeded } from './office-life.ts';
import type { Circle, Plan } from './office-life.ts';

export interface PanelView { title: string; lines: string[]; foot: string; tone: 'work' | 'ok' | 'bad' | 'ask' | 'idle' }
export interface OfficeState {
  robots: { role: string; mood: Mood }[];
  panels: Record<string, PanelView>;
  lamps: { gate: string; state: LampState }[];
  handoff: { id: string; from: string; to: string; tone: 'info' | 'ok' | 'problem' } | null;
  runtimes: Record<string, string> | undefined;
  live: boolean;
  still: boolean;
}
export interface Anchor { x: number; y: number }

const SEATS: Record<string, { x: number; z: number; yaw: number }> = {
  lead: { x: -4.0, z: -1.7, yaw: 0.45 },
  verifier: { x: 4.0, z: -1.7, yaw: -0.45 },
  builder: { x: 1.55, z: 2.5, yaw: -0.12 },
  researcher: { x: -1.55, z: 2.5, yaw: 0.12 },
};
const GATE = new THREE.Vector3(GATE_AT.x, 0, GATE_AT.z);
const BODY: Record<string, string> = { lead: '#F2C14E', builder: '#F0843C', verifier: '#8C9BFF', researcher: '#4FC29A' };
const RUNTIME: Record<string, string> = { codex: '#3CC3B0', claude: '#A993FF' };
const TONE: Record<string, string> = { info: '#9DB4FF', ok: '#7FCF8F', problem: '#FF8F84' };
const LAMP: Record<LampState, string> = { ok: '#7FCF8F', fail: '#FF8F84', skip: '#6F7A8E', wait: '#323B4E' };

type Clip = 'Idle' | 'Walking' | 'Wave' | 'ThumbsUp' | 'No' | 'Yes' | 'Sitting' | 'Standing' | 'Dance' | 'Jump';

interface Robot {
  role: string;
  home: THREE.Vector3;
  homeYaw: number;
  group: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string;
  face: THREE.Mesh | null;
  bones: Record<string, THREE.Bone | undefined>;
  rest: [THREE.Bone, THREE.Quaternion][];
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  screen: THREE.Mesh;
  screenCanvas: HTMLCanvasElement;
  screenTex: THREE.CanvasTexture;
  screenKey: string;
  screenAt: number;
  screenLight: THREE.PointLight;
  strip: THREE.MeshBasicMaterial;
  keys: THREE.MeshBasicMaterial;
  doc: THREE.Mesh;
  mood: Mood;
  moodSince: number;
  seen: boolean;
  /** What it is doing (from office-life), where it is walking, and a delivery to the gate when one is under way. */
  plan: Plan;
  path: THREE.Vector3[];
  deliver: { phase: 'out' | 'scan'; t: number } | null;
  random: () => number;
  speed: number;
  pose: 'type' | 'think' | 'stretch';
  poseUntil: number;
  nodAt: number;
  spot: string | null;
  listening: string | null;
  mug: THREE.Object3D;
  tool: THREE.Object3D | null;
  oneShot: string | null;
}

const easeInOut = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export class Office {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.1, 100);
  private timer = new THREE.Timer();
  private robots = new Map<string, Robot>();
  private state: OfficeState | null = null;
  private gate!: { crystal: THREE.Mesh; crystalMat: THREE.MeshStandardMaterial; ring: THREE.Mesh; arch: THREE.MeshStandardMaterial; beam: THREE.Mesh; beamMat: THREE.MeshBasicMaterial; light: THREE.PointLight; lamps: { mat: THREE.MeshStandardMaterial; light: THREE.PointLight }[]; flash: number; flashColor: THREE.Color };
  private courier!: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; trail: THREE.Mesh; id: string; t: number; route: THREE.Vector3[] | null; tone: string };
  private floorCanvas = document.createElement('canvas');
  private floorTex: THREE.CanvasTexture;
  private floorKey = '';
  private width = 1;
  private height = 1;
  private lastHandoff = '';
  private ready = false;
  yaw = 0;
  private focus = new THREE.Vector3(0, 0.9, 0);

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color('#141922');
    this.scene.fog = new THREE.Fog('#141922', 18, 34);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.93);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.floorCanvas.width = this.floorCanvas.height = 1024;
    this.floorTex = new THREE.CanvasTexture(this.floorCanvas);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    this.buildRoom();
    this.buildGate();
    this.buildCourier();
    this.buildProps();
  }

  // ---------- loading ----------

  async load(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    const base = gltf.scene;
    // size the robot by its head bone (the skinned bounding box is not reliable): head pivot at about 1.32 m
    base.updateMatrixWorld(true);
    let headY = 0;
    base.traverse(node => { if ((node as THREE.Bone).isBone && node.name === 'Head' && !headY) headY = node.getWorldPosition(new THREE.Vector3()).y; });
    const scale = headY > 0 ? 1.32 / headY : 1;
    for (const role of Object.keys(SEATS)) this.robots.set(role, this.buildRobot(role, base, gltf.animations, scale));
    this.ready = true;
  }

  // ---------- building ----------

  private buildRoom(): void {
    const hemi = new THREE.HemisphereLight('#9fb3ff', '#1a1f2b', 0.9);
    const sun = new THREE.DirectionalLight('#fff1dc', 2.0);
    sun.position.set(5, 11, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -10; cam.right = 10; cam.top = 10; cam.bottom = -10; cam.near = 1; cam.far = 30;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    const rim = new THREE.DirectionalLight('#7f9bff', 1.0);
    rim.position.set(-6, 5, -8);
    this.scene.add(hemi, sun, rim);

    const platform = new THREE.Mesh(new THREE.CylinderGeometry(9.2, 9.5, 0.5, 96), new THREE.MeshStandardMaterial({ color: '#10141c', roughness: 0.9 }));
    platform.position.y = -0.26;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(9.2, 96), new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: 0.75, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const edge = new THREE.Mesh(new THREE.TorusGeometry(9.2, 0.03, 8, 160), new THREE.MeshBasicMaterial({ color: '#4b5d93' }));
    edge.rotation.x = Math.PI / 2;
    edge.position.y = 0.01;
    this.scene.add(platform, floor, edge);
  }

  private paintFloor(runtimes: Record<string, string> | undefined, roles: string[]): void {
    const key = JSON.stringify([runtimes, roles]);
    if (key === this.floorKey) return;
    this.floorKey = key;
    const g = this.floorCanvas.getContext('2d')!;
    const S = this.floorCanvas.width, R = 9.2;
    const px = (v: number): number => (0.5 + v / (2 * R)) * S;
    g.fillStyle = '#1b212c'; g.fillRect(0, 0, S, S);
    const shade = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    shade.addColorStop(0, '#252d3b'); shade.addColorStop(1, '#171c25');
    g.fillStyle = shade; g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(157,180,255,0.06)'; g.lineWidth = 1;
    for (let i = 0; i <= S; i += 28) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); }
    // circle texture uv: u = 0.5 + x / 2R, v = 0.5 + z / 2R after the -90° tilt (canvas y grows toward +z)
    const gx = px(GATE.x), gz = px(GATE.z);
    for (const role of roles) {
      const seat = SEATS[role]!;
      const color = RUNTIME[runtimes?.[role] ?? ''] ?? '#9DB4FF';
      const sx = px(seat.x), sz = px(seat.z);
      g.strokeStyle = 'rgba(157,180,255,0.22)'; g.lineWidth = 10; g.setLineDash([]);
      g.beginPath(); g.moveTo(sx, sz); g.lineTo(gx, gz); g.stroke();
      g.strokeStyle = 'rgba(157,180,255,0.55)'; g.lineWidth = 2; g.setLineDash([14, 12]);
      g.beginPath(); g.moveTo(sx, sz); g.lineTo(gx, gz); g.stroke(); g.setLineDash([]);
      const glow = g.createRadialGradient(sx, sz, 8, sx, sz, 120);
      glow.addColorStop(0, `${color}40`); glow.addColorStop(1, `${color}00`);
      g.fillStyle = glow; g.beginPath(); g.arc(sx, sz, 120, 0, Math.PI * 2); g.fill();
    }
    const core = g.createRadialGradient(gx, gz, 10, gx, gz, 170);
    core.addColorStop(0, 'rgba(157,180,255,0.30)'); core.addColorStop(1, 'rgba(157,180,255,0)');
    g.fillStyle = core; g.beginPath(); g.arc(gx, gz, 170, 0, Math.PI * 2); g.fill();
    this.floorTex.needsUpdate = true;
  }

  private buildGate(): void {
    const root = new THREE.Group();
    root.position.copy(GATE);
    const metal = new THREE.MeshStandardMaterial({ color: '#2b3446', metalness: 0.7, roughness: 0.35 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.4, 0.3, 64), metal);
    base.position.y = 0.15; base.castShadow = true; base.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.TorusGeometry(1.26, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color: '#9db4ff' }));
    top.rotation.x = Math.PI / 2; top.position.y = 0.31;
    // the scan arch: documents pass through it
    const arch = new THREE.MeshStandardMaterial({ color: '#3a4560', metalness: 0.8, roughness: 0.25, emissive: '#9db4ff', emissiveIntensity: 0.25 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.07, 16, 96, Math.PI), arch);
    ring.position.y = 0.3; ring.castShadow = true;
    const legs = [-0.95, 0.95].map(x => { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.12, 16), metal); leg.position.set(x, 0.36, 0); return leg; });
    const beamMat = new THREE.MeshBasicMaterial({ color: '#9db4ff', transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const beam = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48, 0, Math.PI), beamMat);
    beam.position.y = 0.3;
    const crystalMat = new THREE.MeshStandardMaterial({ color: '#c7d4ff', emissive: '#9db4ff', emissiveIntensity: 0.8, metalness: 0.2, roughness: 0.15, flatShading: true });
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), crystalMat);
    crystal.position.y = 1.62;
    const light = new THREE.PointLight('#9db4ff', 6, 6, 2);
    light.position.y = 1.4;
    const lamps = [-0.45, 0, 0.45].map(x => {
      const mat = new THREE.MeshStandardMaterial({ color: LAMP.wait, emissive: '#000000', roughness: 0.3 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), mat);
      lamp.position.set(x, 0.38, 1.05);
      const glow = new THREE.PointLight('#000000', 0, 1.4, 2);
      glow.position.copy(lamp.position).add(new THREE.Vector3(0, 0.15, 0.1));
      root.add(lamp, glow);
      return { mat, light: glow };
    });
    root.add(base, top, ring, ...legs, beam, crystal, light);
    this.scene.add(root);
    this.gate = { crystal, crystalMat, ring, arch, beam, beamMat, light, lamps, flash: 0, flashColor: new THREE.Color('#9db4ff') };
  }

  /** The rest of the office: a coffee bar, a whiteboard, a lounge, a server rack, a bookshelf, a window and plants. */
  private buildProps(): void {
    const add = (mesh: THREE.Mesh, x: number, y: number, z: number, ry = 0): THREE.Mesh => {
      mesh.position.set(x, y, z); mesh.rotation.y = ry; mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
    };
    const mat = (color: string, roughness = 0.6, metalness = 0.1): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const glow = (color: string): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color });

    // coffee bar
    add(new THREE.Mesh(new RoundedBoxGeometry(0.75, 1.0, 1.9, 3, 0.04), mat('#3b2f2a', 0.7)), -7.05, 0.5, 1.55, 0);
    add(new THREE.Mesh(new RoundedBoxGeometry(0.85, 0.05, 2.0, 2, 0.02), mat('#cfc8bd', 0.35)), -7.05, 1.02, 1.55);
    add(new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.55, 0.42, 3, 0.05), mat('#1f232b', 0.3, 0.6)), -7.1, 1.33, 1.1);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), glow('#ff6b5e')), -6.88, 1.45, 1.1);
    for (const [i, color] of ['#e8e4da', '#3a6ea5', '#c0504d'].entries()) add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.13, 14), mat(color, 0.4)), -7.0, 1.11, 1.75 + i * 0.2);

    // whiteboard
    const boardCanvas = document.createElement('canvas');
    boardCanvas.width = 1024; boardCanvas.height = 512;
    const bg = boardCanvas.getContext('2d')!;
    bg.fillStyle = '#f4f6fa'; bg.fillRect(0, 0, 1024, 512);
    bg.strokeStyle = '#3a6ea5'; bg.lineWidth = 6;
    const box = (x: number, y: number, w: number, h: number): void => { bg.strokeRect(x, y, w, h); };
    box(70, 90, 200, 110); box(410, 90, 200, 110); box(750, 90, 200, 110); box(410, 320, 200, 110);
    bg.beginPath(); bg.moveTo(270, 145); bg.lineTo(410, 145); bg.moveTo(610, 145); bg.lineTo(750, 145); bg.moveTo(510, 200); bg.lineTo(510, 320); bg.stroke();
    bg.fillStyle = '#c0504d'; bg.font = '600 44px "Noto Sans KR", sans-serif'; bg.fillText('lead', 120, 160); bg.fillText('build', 455, 160); bg.fillText('review', 775, 160); bg.fillText('gate', 465, 390);
    const boardTex = new THREE.CanvasTexture(boardCanvas); boardTex.colorSpace = THREE.SRGBColorSpace;
    add(new THREE.Mesh(new RoundedBoxGeometry(3.1, 1.6, 0.08, 2, 0.03), mat('#c9ced8', 0.4, 0.4)), 0, 1.55, -5.35);
    add(new THREE.Mesh(new THREE.PlaneGeometry(2.95, 1.45), new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.5 })), 0, 1.55, -5.305);
    for (const x of [-1.4, 1.4]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 10), mat('#8a93a3', 0.4, 0.6)), x, 0.8, -5.4);

    // lounge: two beanbags and a low table
    for (const [x, z, color] of [[6.15, 1.0, '#4a5fa8'], [6.35, 2.95, '#a8504a']] as const) {
      const bag = add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), mat(color, 0.9)), x + 0.45, 0.3, z);
      bag.scale.set(1, 0.55, 1);
    }
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 32), mat('#c9a77a', 0.5)), 6.75, 0.45, 1.95);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.42, 12), mat('#2a3243', 0.5, 0.5)), 6.75, 0.21, 1.95);

    // server rack with blinking lights
    add(new THREE.Mesh(new RoundedBoxGeometry(0.85, 2.1, 0.85, 3, 0.03), mat('#151a22', 0.4, 0.6)), 5.8, 1.05, -4.8, -0.75);
    this.rackLights = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 3; col++) {
        const light = glow(row % 3 === 0 ? '#3cc3b0' : '#7fcf8f');
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.01), light);
        const local = new THREE.Vector3(-0.2 + col * 0.2, 0.3 + row * 0.2, 0.43).applyAxisAngle(UP, -0.75);
        add(led, 5.8 + local.x, local.y, -4.8 + local.z, -0.75);
        this.rackLights.push(light);
      }
    }

    // bookshelf
    add(new THREE.Mesh(new RoundedBoxGeometry(1.2, 2.0, 0.45, 2, 0.02), mat('#5a4636', 0.8)), -5.8, 1.0, -4.8, 0.75);
    const colors = ['#c0504d', '#3a6ea5', '#e0b85a', '#4fc29a', '#8c9bff', '#e8e4da'];
    for (let shelf = 0; shelf < 4; shelf++) {
      for (let k = 0; k < 7; k++) {
        const h = 0.3 + ((shelf * 7 + k) % 3) * 0.04;
        const local = new THREE.Vector3(-0.45 + k * 0.14, 0.28 + shelf * 0.46 + h / 2, 0.06).applyAxisAngle(UP, 0.75);
        add(new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.3), mat(colors[(shelf + k) % colors.length]!, 0.8)), -5.8 + local.x, local.y, -4.8 + local.z, 0.75);
      }
    }

    // a window panel on the back wall: night city lights
    const windowCanvas = document.createElement('canvas');
    windowCanvas.width = 512; windowCanvas.height = 256;
    const wg = windowCanvas.getContext('2d')!;
    const sky = wg.createLinearGradient(0, 0, 0, 256); sky.addColorStop(0, '#0b1226'); sky.addColorStop(1, '#2a2f5a');
    wg.fillStyle = sky; wg.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 26; i++) { const w = 18 + (i * 37) % 30, h = 50 + (i * 53) % 150, x = (i * 41) % 512; wg.fillStyle = '#121a30'; wg.fillRect(x, 256 - h, w, h); wg.fillStyle = '#f0c063'; for (let j = 0; j < h / 18; j++) if ((i + j) % 3 === 0) wg.fillRect(x + 4, 256 - h + 6 + j * 18, 4, 5); }
    const windowTex = new THREE.CanvasTexture(windowCanvas); windowTex.colorSpace = THREE.SRGBColorSpace;
    add(new THREE.Mesh(new RoundedBoxGeometry(2.6, 1.5, 0.08, 2, 0.03), mat('#2a3243', 0.4, 0.5)), 3.4, 1.9, -7.3, -0.25);
    add(new THREE.Mesh(new THREE.PlaneGeometry(2.45, 1.36), new THREE.MeshBasicMaterial({ map: windowTex, toneMapped: false })), 3.4 + Math.sin(-0.25) * 0.05, 1.9, -7.3 + Math.cos(-0.25) * 0.05, -0.25);

    // plants
    for (const [x, z] of [[-7.6, -1.6], [7.4, -1.4], [-3.0, -6.6], [7.0, 4.6], [-6.8, 4.4]] as const) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.5, 18), mat('#c9a77a', 0.7)), x, 0.25, z);
      for (let k = 0; k < 4; k++) add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.3 - k * 0.04, 1), mat(k % 2 ? '#3f8f4f' : '#4fa65f', 0.8)), x + Math.sin(k * 2.1) * 0.12, 0.7 + k * 0.22, z + Math.cos(k * 2.1) * 0.12);
    }
  }
  private rackLights: THREE.MeshBasicMaterial[] = [];

  private buildCourier(): void {
    const mat = new THREE.MeshStandardMaterial({ color: '#f3f5fa', emissive: '#9db4ff', emissiveIntensity: 0.9, roughness: 0.4 });
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.025, 0.44, 2, 0.01), mat);
    mesh.castShadow = true;
    const trail = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14), new THREE.MeshBasicMaterial({ color: '#9db4ff', transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
    mesh.add(trail);
    mesh.visible = false;
    this.scene.add(mesh);
    this.courier = { mesh, mat, trail, id: '', t: 0, route: null, tone: 'info' };
  }

  private buildRobot(role: string, base: THREE.Object3D, clips: THREE.AnimationClip[], scale: number): Robot {
    const seat = SEATS[role]!;
    const home = new THREE.Vector3(seat.x, 0, seat.z);
    const group = new THREE.Group();
    group.position.copy(home);
    group.rotation.y = seat.yaw;

    // the robot: its own copy of the skinned model, body tinted per role
    const model = cloneSkinned(base);
    model.scale.setScalar(scale);
    const bones: Robot['bones'] = {};
    let face: THREE.Mesh | null = null;
    model.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const material = (mesh.material as THREE.MeshStandardMaterial).clone();
        if (material.name === 'Main') { material.color.set(BODY[role] ?? '#F2C14E'); material.roughness = 0.45; material.metalness = 0.15; }
        mesh.material = material;
        if (mesh.morphTargetDictionary && 'Sad' in mesh.morphTargetDictionary) face = mesh;
      }
      const bone = node as THREE.Bone;
      if (bone.isBone && !bones[bone.name]) bones[bone.name] = bone;
    });
    const random = seeded(role);
    const mixer = new THREE.AnimationMixer(model);
    // each robot keeps its own rhythm, so no two move in step
    mixer.timeScale = 0.88 + random() * 0.24;
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of clips) actions.set(clip.name, mixer.clipAction(clip));
    for (const name of ['ThumbsUp', 'No', 'Yes', 'Jump']) { const a = actions.get(name); if (a) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } }
    const idle = actions.get('Idle');
    idle?.play();
    if (idle) idle.time = random() * idle.getClip().duration;
    actions.get('Wave')?.setLoop(THREE.LoopRepeat, Infinity);

    // the ring under the robot shows its model's colour (Codex teal / Claude violet)
    const ringMat = new THREE.MeshBasicMaterial({ color: '#9DB4FF' });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 8, 64), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.02;
    group.add(ring);

    // accessories, fixed to the head and hands so they follow the animations (sizes in metres)
    group.updateMatrixWorld(true);
    const probe = new THREE.Group(); probe.add(model); probe.updateMatrixWorld(true);
    const tool = this.addAccessories(role, bones, scale);
    const mug = new THREE.Group();
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.15, 18), new THREE.MeshStandardMaterial({ color: ['#e8e4da', '#3a6ea5', '#c0504d', '#2e2e2e'][Math.floor(random() * 4)] ?? '#e8e4da', roughness: 0.4 }));
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.012, 8, 16), cup.material);
    handle.position.x = 0.075; handle.rotation.y = Math.PI / 2;
    mug.add(cup, handle);
    mug.visible = false;
    fixTo(bones.Palm2R ?? bones.LowerArmR, mug, 0, 0.06, 0.06, scale);
    group.add(model);

    // the station: a desk in front of the robot, a wall screen behind it
    const station = new THREE.Group();
    station.position.copy(home);
    station.rotation.y = seat.yaw;
    const deskMat = new THREE.MeshStandardMaterial({ color: '#2a3243', metalness: 0.5, roughness: 0.45 });
    const desk = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.07, 0.62, 3, 0.03), deskMat);
    desk.position.set(0, 0.74, 0.6); desk.castShadow = true; desk.receiveShadow = true;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 0.5), deskMat); legL.position.set(-0.68, 0.36, 0.6); legL.castShadow = true;
    const legR = legL.clone(); legR.position.x = 0.68;
    const strip = new THREE.MeshBasicMaterial({ color: '#9DB4FF' });
    const edge = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.015, 0.015), strip);
    edge.position.set(0, 0.72, 0.915);
    const keys = new THREE.MeshBasicMaterial({ color: '#9DB4FF', transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending });
    const keyboard = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.26), keys);
    keyboard.rotation.x = -Math.PI / 2; keyboard.position.set(0, 0.782, 0.5);
    const doc = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.02, 0.4, 2, 0.008), new THREE.MeshStandardMaterial({ color: '#eef1f7', roughness: 0.5 }));
    doc.position.set(0.42, 0.79, 0.6); doc.rotation.y = 0.2; doc.castShadow = true;
    doc.visible = false;

    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 768; screenCanvas.height = 448;
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    screenTex.anisotropy = 4;
    const frame = new THREE.Mesh(new RoundedBoxGeometry(2.36, 1.42, 0.06, 3, 0.03), new THREE.MeshStandardMaterial({ color: '#1a202c', metalness: 0.6, roughness: 0.4 }));
    frame.position.set(0, 2.25, -0.75); frame.castShadow = true;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.24, 1.31), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
    screen.position.set(0, 2.25, -0.715);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1.6, 12), deskMat);
    pole.position.set(0, 0.8, -0.78); pole.castShadow = true;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.05, 24), deskMat);
    foot.position.set(0, 0.025, -0.78);
    const screenLight = new THREE.PointLight('#9DB4FF', 1.2, 2.6, 2);
    screenLight.position.set(0, 2.3, -0.55);
    station.add(desk, legL, legR, edge, keyboard, doc, frame, screen, pole, foot, screenLight);
    this.scene.add(station, group);

    return {
      role, home, homeYaw: seat.yaw, group, model, mixer, actions, current: 'Idle', face, bones, ring, ringMat,
      rest: ['UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR', 'ShoulderL', 'ShoulderR', 'Neck', 'Head'].map(name => bones[name]).filter((bone): bone is THREE.Bone => !!bone).map(bone => [bone, bone.quaternion.clone()]),
      screen, screenCanvas, screenTex, screenKey: '', screenAt: 0, screenLight, strip, keys, doc,
      mood: 'idle', moodSince: 0, seen: false, oneShot: null,
      plan: { kind: 'desk', until: 0 }, path: [], deliver: null, random, speed: 1.15 + random() * 0.35, pose: 'type', poseUntil: 0, nodAt: 0,
      spot: null, listening: null, mug, tool,
    };
  }

  private addAccessories(role: string, bones: Robot['bones'], scale: number): THREE.Object3D | null {
    const head = bones.Head;
    const handR = bones.Palm2R ?? bones.LowerArmR;
    const handL = bones.Palm2L ?? bones.LowerArmL;
    // bones live in model units; children are sized in metres and divided by the model scale
    const attach = (bone: THREE.Bone | undefined, object: THREE.Object3D, x: number, y: number, z: number): void => fixTo(bone, object, x, y, z, scale);
    let tool: THREE.Object3D | null = null;
    if (role === 'lead') {
      const band = new THREE.MeshStandardMaterial({ color: '#2c3446', metalness: 0.6, roughness: 0.3 });
      const set = new THREE.Group();
      const arc = new THREE.Mesh(new THREE.TorusGeometry(0.53, 0.035, 10, 48, Math.PI), band);
      const cupL = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 24), band); cupL.rotation.z = Math.PI / 2; cupL.position.x = -0.53;
      const cupR = cupL.clone(); cupR.position.x = 0.53;
      const mic = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.36, 4, 8), band); mic.position.set(-0.42, -0.2, 0.26); mic.rotation.set(Math.PI / 2, 0, 0.9);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshStandardMaterial({ color: '#3cc3b0', emissive: '#3cc3b0', emissiveIntensity: 1.5 })); tip.position.set(-0.27, -0.3, 0.42);
      set.add(arc, cupL, cupR, mic, tip);
      attach(head, set, 0, 0.3, 0);
    } else if (role === 'builder') {
      const hatMat = new THREE.MeshStandardMaterial({ color: '#f2c230', roughness: 0.4 });
      const hat = new THREE.Group();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.04, 40), hatMat); brim.position.set(0, 0.0, 0.06);
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.86), hatMat); ridge.position.y = 0.48;
      hat.add(dome, brim, ridge);
      attach(head, hat, 0, 0.5, -0.02);
    } else if (role === 'verifier') {
      const gold = new THREE.MeshStandardMaterial({ color: '#e0b85a', metalness: 0.9, roughness: 0.25 });
      const glass = new THREE.Group();
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.26, 10), new THREE.MeshStandardMaterial({ color: '#4a3a2a' }));
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.024, 10, 32), gold); rim.position.y = 0.28;
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.14, 28), new THREE.MeshPhysicalMaterial({ color: '#cfe0ff', transmission: 0.6, roughness: 0.05, transparent: true, opacity: 0.45, side: THREE.DoubleSide })); lens.position.y = 0.28;
      glass.add(handle, rim, lens);
      attach(handR, glass, 0, 0.05, 0.05);
      tool = glass;
      const monocle = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 28), gold);
      attach(head, monocle, -0.22, 0.25, 0.5);
    } else if (role === 'researcher') {
      const book = new THREE.Group();
      const cover = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.06), new THREE.MeshStandardMaterial({ color: '#7a3e2a', roughness: 0.6 }));
      const pages = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.062), new THREE.MeshStandardMaterial({ color: '#f1ece0', roughness: 0.9 })); pages.position.x = 0.012;
      book.add(cover, pages);
      book.rotation.x = -0.9;
      attach(handL, book, 0.1, 0.06, 0.08);
      tool = book;
      const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.08, 12, 28), new THREE.MeshStandardMaterial({ color: '#2f8f88', roughness: 0.8 }));
      scarf.rotation.x = Math.PI / 2;
      attach(bones.Neck, scarf, 0, 0.02, 0);
    }
    return tool;
  }

  // ---------- screens ----------

  private paintScreen(robot: Robot, view: PanelView, accent: string, now: number, animate: boolean): void {
    const key = JSON.stringify(view) + accent;
    if (key === robot.screenKey && !(animate && now - robot.screenAt > 0.15)) return;
    robot.screenKey = key; robot.screenAt = now;
    const c = robot.screenCanvas, g = c.getContext('2d')!;
    const W = c.width, H = c.height;
    const tone = view.tone === 'ok' ? '#7FCF8F' : view.tone === 'bad' ? '#FF8F84' : view.tone === 'ask' ? '#F0C063' : view.tone === 'idle' ? '#6F7A8E' : accent;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#111827'); bg.addColorStop(1, '#0b1019');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = `${tone}26`; g.fillRect(0, 0, W, 84);
    g.fillStyle = tone; g.fillRect(0, 84, W, 3);
    g.font = '700 44px "Noto Sans KR", "Malgun Gothic", sans-serif'; g.textBaseline = 'middle';
    g.fillText(fit(g, view.title, W - 64), 32, 44);
    g.fillStyle = '#E4E8F0'; g.font = '500 36px "Noto Sans KR", "Malgun Gothic", sans-serif';
    let y = 140;
    for (const line of view.lines) {
      for (const part of wrapText(g, line, W - 64, 3)) { if (y > H - 90) break; g.fillText(part, 32, y); y += 50; }
    }
    g.fillStyle = '#9AA4B6'; g.font = '500 30px "JetBrains Mono", "Noto Sans KR", monospace';
    g.fillText(fit(g, view.foot, W - 260), 32, H - 40);
    if (animate) {
      // a busy meter: it shows activity only, no content
      for (let i = 0; i < 14; i++) {
        const h = 8 + 26 * Math.abs(Math.sin(now * 5 + i * 0.8));
        g.fillStyle = `${tone}CC`;
        g.fillRect(W - 32 - (14 - i) * 14, H - 26 - h, 8, h);
      }
    }
    robot.screenTex.needsUpdate = true;
  }

  // ---------- animation ----------

  setState(state: OfficeState): void { this.state = state; }

  resize(width: number, height: number, dpr: number): void {
    this.width = width; this.height = height;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private play(robot: Robot, name: string, fade = 0.35): void {
    if (robot.current === name) return;
    const next = robot.actions.get(name);
    const prev = robot.actions.get(robot.current);
    if (!next) return;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    prev?.fadeOut(fade);
    robot.current = name;
  }

  /** The clip for a robot that has arrived where it was going. */
  private restingClip(robot: Robot): Clip {
    if (robot.plan.kind === 'ask' && !robot.path.length) return 'Wave';
    return 'Idle';
  }

  /** Desks are two circles each, so a robot walks around a desk rather than through it. */
  private obstacles(): Circle[] {
    const out: Circle[] = [...OBSTACLES];
    for (const robot of this.robots.values()) {
      const center = new THREE.Vector3(0, 0, 0.6).applyAxisAngle(UP, robot.homeYaw).add(robot.home);
      const side = new THREE.Vector3(0.42, 0, 0).applyAxisAngle(UP, robot.homeYaw);
      out.push({ x: center.x + side.x, z: center.z + side.z, r: 0.45 }, { x: center.x - side.x, z: center.z - side.z, r: 0.45 });
    }
    return out;
  }

  /** Where a plan puts the robot and which way it faces there. */
  private goalOf(robot: Robot, plan: Plan): { at: THREE.Vector3; face: number } {
    if (plan.kind === 'desk') return { at: robot.home.clone(), face: robot.homeYaw };
    if (plan.kind === 'spot') return { at: new THREE.Vector3(plan.spot.x, 0, plan.spot.z), face: Math.atan2(plan.spot.look.x - plan.spot.x, plan.spot.look.z - plan.spot.z) };
    if (plan.kind === 'ask') return { at: new THREE.Vector3(Math.max(-2.5, Math.min(2.5, robot.home.x * 0.6)), 0, 5.6), face: 0 };
    const other = this.robots.get(plan.with);
    const there = other ? other.group.position.clone() : robot.home.clone();
    const away = robot.group.position.clone().sub(there).setY(0);
    if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
    const at = there.clone().add(away.setLength(1.2));
    return { at, face: Math.atan2(there.x - at.x, there.z - at.z) };
  }

  private setPlan(robot: Robot, plan: Plan): void {
    const before = robot.plan;
    if (before.kind === 'chat') { const other = this.robots.get(before.with); if (other && other.listening === robot.role) other.listening = null; }
    robot.plan = plan;
    robot.spot = plan.kind === 'spot' ? plan.spot.id : null;
    if (plan.kind === 'chat') {
      const other = this.robots.get(plan.with);
      if (other) { other.listening = robot.role; if (other.plan.until < plan.until) other.plan = { ...other.plan, until: plan.until } as Plan; }
    }
    const goal = this.goalOf(robot, plan).at;
    const from = robot.group.position;
    robot.path = from.distanceTo(goal) < 0.05 ? [] : route({ x: from.x, z: from.z }, { x: goal.x, z: goal.z }, this.obstacles()).map(p => new THREE.Vector3(p.x, 0, p.z));
  }

  /** Picks the next plan when the current one is over or the robot's duty changed. */
  private think(robot: Robot, now: number): void {
    if (robot.deliver || robot.oneShot) return;
    const duty: Plan['kind'] | null = robot.mood === 'working' || robot.mood === 'failed' ? 'desk' : robot.mood === 'asking' ? 'ask' : null;
    const plan = robot.plan;
    if (duty) { if (plan.kind !== duty || plan.until !== Infinity) this.setPlan(robot, nextPlan({ role: robot.role, mood: robot.mood, now, free: [], partners: [], random: robot.random })); return; }
    if (plan.until !== Infinity && now < plan.until) return;
    if (robot.listening) return;
    const taken = new Set([...this.robots.values()].filter(other => other !== robot).map(other => other.spot));
    const free = SPOTS.filter(spot => !taken.has(spot.id));
    const partners = [...this.robots.values()].filter(other => other !== robot && other.group.visible && (other.mood === 'idle' || other.mood === 'done') && !other.deliver && !other.path.length && !other.listening && other.plan.kind !== 'chat').map(other => other.role);
    this.setPlan(robot, nextPlan({ role: robot.role, mood: robot.mood, now, free, partners, random: robot.random }));
  }

  private project(p: THREE.Vector3): Anchor | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (1 - (v.y * 0.5 + 0.5)) * this.height };
  }

  anchors(): { tags: Record<string, Anchor | null>; gate: Anchor | null; gateBase: Anchor | null } {
    const tags: Record<string, Anchor | null> = {};
    // name tags follow the robots, at their feet
    for (const [role, robot] of this.robots) tags[role] = robot.group.visible ? this.project(robot.group.position.clone().add(new THREE.Vector3(0, 0, 0.35))) : null;
    return { tags, gate: this.project(GATE.clone().add(new THREE.Vector3(0, 2.05, 0))), gateBase: this.project(GATE.clone().add(new THREE.Vector3(0, 0, 1.5))) };
  }

  frame(): void {
    const state = this.state;
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    const now = this.timer.getElapsed();
    if (!state) return;
    const t = state.still ? 1 : now;
    this.paintFloor(state.runtimes, state.robots.map(robot => robot.role));

    // a new hand-off starts a delivery: the sender walks the document to the gate, then it travels on
    const h = state.handoff;
    if (this.ready && h && h.id !== this.lastHandoff) {
      const first = this.lastHandoff === '';
      this.lastHandoff = h.id;
      if (!first && state.live && !state.still) this.startDelivery(h);
    }

    for (const [role, robot] of this.robots) {
      const entry = state.robots.find(item => item.role === role);
      const station = robot.screen.parent!;
      robot.group.visible = station.visible = !!entry;
      if (!entry) continue;
      if (!robot.seen) { robot.seen = true; robot.mood = entry.mood; robot.moodSince = now - 100; }
      else if (entry.mood !== robot.mood) { this.onMood(robot, entry.mood, now, state); }
      const accent = RUNTIME[state.runtimes?.[role] ?? ''] ?? '#9DB4FF';
      robot.ringMat.color.set(accent);
      robot.strip.color.set(accent);
      robot.screenLight.color.set(accent);
      robot.screenLight.intensity = robot.mood === 'idle' ? 0.3 : 1.2;
      const view = state.panels[role];
      if (view) this.paintScreen(robot, view, accent, now, robot.mood === 'working' && !state.still);
      this.animateRobot(robot, accent, t, now, dt, state.still);
    }
    this.animateGate(state, t, dt);
    this.animateCourier(dt, state.still);

    // camera: three-quarter view of the room, drifting slightly, turned by the user's drag
    const sway = state.still ? 0 : Math.sin(now * 0.1) * 0.05;
    const yaw = this.yaw + sway;
    // the whole office stays in view: the robots move around it
    this.focus.set(0, 0.8, -0.4);
    const radius = 14.5, pitch = 0.55;
    this.camera.position.set(this.focus.x + Math.sin(yaw) * radius * Math.cos(pitch), this.focus.y + radius * Math.sin(pitch), this.focus.z + Math.cos(yaw) * radius * Math.cos(pitch));
    this.camera.lookAt(this.focus);
    this.composer.render(dt);
  }

  private onMood(robot: Robot, mood: Mood, now: number, state: OfficeState): void {
    const before = robot.mood;
    robot.mood = mood;
    robot.moodSince = now;
    if (state.still || robot.deliver) return;
    if (mood === 'done' && before === 'working') this.oneShot(robot, 'ThumbsUp');
    else if (mood === 'failed') this.oneShot(robot, 'No');
  }

  private oneShot(robot: Robot, name: string): void {
    const action = robot.actions.get(name);
    if (!action) return;
    robot.oneShot = name;
    this.play(robot, name, 0.2);
    const done = (event: { action: THREE.AnimationAction }): void => {
      if (event.action !== action) return;
      robot.mixer.removeEventListener('finished', done);
      robot.oneShot = null;
      this.play(robot, this.restingClip(robot), 0.4);
    };
    robot.mixer.addEventListener('finished', done);
  }

  private pendingRoute: THREE.Vector3[] = [];

  private startDelivery(h: NonNullable<OfficeState['handoff']>): void {
    const sender = this.robots.get(h.from);
    const gateIn = GATE.clone().add(new THREE.Vector3(0, 1.0, 0));
    const deskOf = (role: string): THREE.Vector3 | null => {
      const r = this.robots.get(role);
      return r ? new THREE.Vector3(0.42, 0.81, 0.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), r.homeYaw).add(r.home) : null;
    };
    const to = h.to === 'you' ? new THREE.Vector3(0, 2.6, 9) : h.to === 'harness' ? null : deskOf(h.to);
    this.pendingRoute = to ? [gateIn, to] : [gateIn];
    this.courier.tone = h.tone;
    this.courier.t = 0;
    this.gate.flashColor.set(TONE[h.tone] ?? '#9DB4FF');
    if (sender && sender.group.visible && !sender.deliver) {
      // the sender walks it over; the document leaves its hands at the gate
      sender.deliver = { phase: 'out', t: 0 };
      const stop = GATE.clone().add(sender.group.position.clone().sub(GATE).setY(0).setLength(2.0));
      const from = sender.group.position;
      sender.path = route({ x: from.x, z: from.z }, { x: stop.x, z: stop.z }, this.obstacles().slice(1)).map(p => new THREE.Vector3(p.x, 0, p.z));
      this.courier.route = null;
    } else {
      // the harness itself sends it (a sent-back reason): it starts in the gate
      this.courier.mesh.position.copy(gateIn);
      this.courier.route = [...this.pendingRoute];
    }
  }

  private animateRobot(robot: Robot, accent: string, t: number, now: number, dt: number, still: boolean): void {
    const g = robot.group;
    if (!still) this.think(robot, now);
    const goal = this.goalOf(robot, robot.plan);

    // walking: along the planned route, turning into the direction of travel
    if (robot.path.length && !still) {
      const next = robot.path[0]!;
      const to = next.clone().sub(g.position).setY(0);
      const step = robot.speed * dt;
      if (to.length() <= step) {
        g.position.copy(next);
        robot.path.shift();
        if (!robot.path.length) this.arrived(robot);
      } else {
        g.position.addScaledVector(to.normalize(), step);
        g.rotation.y = turnTowards(g.rotation.y, Math.atan2(to.x, to.z), dt * 7);
      }
      if (!robot.oneShot) this.play(robot, 'Walking', 0.25);
      const walk = robot.actions.get('Walking');
      if (walk) walk.timeScale = robot.speed / 1.3;
    } else {
      if (still) { g.position.copy(goal.at.distanceTo(g.position) < 0.05 ? goal.at : g.position); }
      if (robot.deliver?.phase === 'scan') {
        robot.deliver.t += dt;
        g.rotation.y = turnTowards(g.rotation.y, Math.atan2(GATE.x - g.position.x, GATE.z - g.position.z), dt * 6);
        if (robot.deliver.t > 1.2) { robot.deliver = null; this.setPlan(robot, robot.plan); }
      } else {
        const listen = robot.listening ? this.robots.get(robot.listening) : null;
        const face = listen && !listen.path.length ? Math.atan2(listen.group.position.x - g.position.x, listen.group.position.z - g.position.z) : goal.face;
        g.rotation.y = turnTowards(g.rotation.y, face, dt * 5);
      }
      if (!robot.oneShot) this.play(robot, this.restingClip(robot));
      // a chat: now and then one of them nods
      if (!still && (robot.plan.kind === 'chat' || robot.listening) && !robot.path.length && now > robot.nodAt) {
        robot.nodAt = now + 2.5 + robot.random() * 3.5;
        if (robot.random() < 0.6) this.oneShot(robot, 'Yes');
      }
    }

    for (const [bone, rest] of robot.rest) bone.quaternion.copy(rest);
    robot.mixer.update(still ? 0 : dt);
    robot.model.updateMatrixWorld(true);
    const settled = !robot.path.length && !robot.oneShot && robot.current === 'Idle' && !robot.deliver;
    const typing = settled && robot.plan.kind === 'desk' && robot.mood === 'working';
    this.posture(robot, settled, typing, t, now);

    robot.doc.visible = robot.mood === 'done';
    robot.mug.visible = settled && robot.plan.kind === 'spot' && robot.plan.spot.kind === 'coffee';
    if (robot.tool) robot.tool.visible = !robot.mug.visible && (robot.role === 'researcher' || robot.mood === 'working');
    robot.keys.opacity = typing && robot.pose === 'type' ? 0.55 + Math.sin(t * 8) * 0.15 : 0;

    // faces: the model has three expressions
    if (robot.face?.morphTargetDictionary && robot.face.morphTargetInfluences) {
      const dict = robot.face.morphTargetDictionary, inf = robot.face.morphTargetInfluences;
      const want = { Sad: robot.mood === 'failed' ? 1 : 0, Surprised: robot.mood === 'asking' ? 0.8 : 0, Angry: 0 };
      for (const [name, value] of Object.entries(want)) {
        const i = dict[name];
        if (i !== undefined) inf[i] = inf[i]! + (value - inf[i]!) * (1 - Math.exp(-dt * 6));
      }
    }
    robot.ringMat.color.set(robot.mood === 'failed' ? '#FF8F84' : robot.mood === 'asking' ? '#F0C063' : accent);
    robot.ring.scale.setScalar(robot.mood === 'working' ? 1 + Math.sin(now * 3) * 0.04 : 1);
  }

  private arrived(robot: Robot): void {
    if (robot.deliver?.phase === 'out') {
      robot.deliver = { phase: 'scan', t: 0 };
      // the document leaves its hands into the gate
      this.courier.route = [...this.pendingRoute];
      this.courier.t = 0;
      this.courier.mesh.position.copy(robot.group.position).add(new THREE.Vector3(0, 1.0, 0));
    }
  }

  /** Hands and head on top of the clip: typing, thinking, stretching at the desk; coffee, writing, reading elsewhere. */
  private posture(robot: Robot, settled: boolean, typing: boolean, t: number, now: number): void {
    if (!settled) return;
    const g = robot.group;
    const b = robot.bones;
    const local = (x: number, y: number, z: number): THREE.Vector3 => g.localToWorld(new THREE.Vector3(x, y, z));
    const elbowL = local(0.34, 0.85, 0.05), elbowR = local(-0.34, 0.85, 0.05);
    const sideways = new THREE.Vector3(1, 0, 0).applyQuaternion(g.quaternion);
    const upward = new THREE.Vector3(0, 1, 0);
    const hands = (left: THREE.Vector3 | null, right: THREE.Vector3 | null): void => {
      if (left) reach(b.UpperArmL, b.LowerArmL, b.Palm2L, left, elbowL);
      if (right) reach(b.UpperArmR, b.LowerArmR, b.Palm2R, right, elbowR);
    };
    const plan = robot.plan;
    if (typing) {
      if (now > robot.poseUntil) {
        const r = robot.random();
        robot.pose = r < 0.72 ? 'type' : r < 0.9 ? 'think' : 'stretch';
        robot.poseUntil = now + (robot.pose === 'type' ? 5 + robot.random() * 7 : robot.pose === 'think' ? 2 + robot.random() * 2.5 : 1.6 + robot.random());
      }
      if (robot.pose === 'think') {
        hands(local(0.22, 0.8, 0.4), local(-0.04, 1.22, 0.3));
        rotateWorld(b.Head, sideways, -0.12);
        rotateWorld(b.Head, upward, 0.25 * Math.sin(now * 0.6));
        return;
      }
      if (robot.pose === 'stretch') { hands(local(0.28, 2.1, -0.05), local(-0.28, 2.1, -0.05)); rotateWorld(b.Head, sideways, -0.2); return; }
      const rate = robot.role === 'builder' ? 14 : robot.role === 'lead' ? 7 : 9;
      const tap = (phase: number): number => Math.max(0, Math.sin(t * rate + phase)) * 0.06;
      if (robot.role === 'verifier') {
        hands(local(0.25, 0.8 + tap(0), 0.44), local(-0.05 + Math.sin(t * 1.3) * 0.22, 1.05, 0.5));
        rotateWorld(b.Head, upward, Math.sin(t * 1.3) * 0.25);
      } else if (robot.role === 'lead') hands(local(0.12, 1.0, 0.4), local(-0.05, 0.98 + tap(0) * 1.5, 0.45));
      else if (robot.role === 'researcher') hands(local(0.14, 0.98, 0.42), local(-0.14, 0.98 + Math.max(0, Math.sin(t * 2)) * 0.08, 0.42));
      else hands(local(0.25, 0.8 + tap(0), 0.46), local(-0.25, 0.8 + tap(1.9), 0.46));
      rotateWorld(b.Head, sideways, 0.16 + Math.sin(t * 1.1) * 0.05);
      return;
    }
    if (plan.kind === 'desk' && robot.mood === 'failed') { hands(local(0.3, 0.8, 0.36), local(-0.3, 0.8, 0.36)); rotateWorld(b.Head, sideways, 0.35); return; }
    if (plan.kind === 'spot') {
      const kind = plan.spot.kind;
      if (kind === 'coffee') {
        const sip = (now + robot.speed * 3) % 6 < 1.6;
        hands(null, sip ? local(-0.04, 1.42, 0.36) : local(-0.18, 1.0, 0.32));
        if (sip) rotateWorld(b.Head, sideways, -0.15);
      } else if (kind === 'board') {
        const write = local(-0.1 + Math.sin(t * 1.7) * 0.25, 1.35 + Math.sin(t * 3.1) * 0.12, 0.75);
        hands(null, write);
        rotateWorld(b.Head, upward, Math.sin(t * 1.7) * 0.18);
      } else if (kind === 'lounge') {
        hands(local(0.2, 1.72, -0.18), local(-0.2, 1.72, -0.18));
        rotateWorld(b.Head, sideways, -0.12);
      } else if (kind === 'window') {
        hands(local(0.14, 0.86, -0.28), local(-0.14, 0.86, -0.28));
        rotateWorld(b.Head, upward, Math.sin(now * 0.3) * 0.3);
      } else if (kind === 'shelf' || (robot.role === 'researcher')) {
        hands(local(0.14, 0.98, 0.42), local(-0.14, 0.98, 0.42));
        rotateWorld(b.Head, sideways, 0.25);
      } else if (kind === 'rack') {
        const point = (now + robot.speed * 5) % 7 < 2.5;
        hands(null, point ? local(-0.15, 1.35, 0.7) : null);
      }
    }
  }

  private animateGate(state: OfficeState, t: number, dt: number): void {
    const gate = this.gate;
    this.rackLights.forEach((light, i) => { const on = state.still || Math.sin(t * (2 + (i % 5)) + i * 1.7) > -0.3; light.color.set(on ? (i % 3 === 0 ? '#3cc3b0' : '#7fcf8f') : '#1d2a2a'); });
    gate.crystal.rotation.y = t * 0.8;
    gate.crystal.position.y = 1.62 + Math.sin(t * 1.6) * 0.06;
    gate.flash = Math.max(0, gate.flash - dt * 1.4);
    gate.beamMat.opacity = gate.flash * 0.35;
    gate.beamMat.color.copy(gate.flashColor);
    gate.arch.emissive.copy(gate.flashColor);
    gate.arch.emissiveIntensity = 0.25 + gate.flash * 1.2;
    gate.crystalMat.emissive.copy(new THREE.Color('#9db4ff').lerp(gate.flashColor, gate.flash));
    gate.crystalMat.emissiveIntensity = 0.8 + gate.flash * 1.2;
    gate.light.color.copy(gate.crystalMat.emissive);
    gate.light.intensity = 4 + gate.flash * 6;
    state.lamps.forEach((lamp, index) => {
      const entry = gate.lamps[index];
      if (!entry) return;
      const color = new THREE.Color(LAMP[lamp.state]);
      const waiting = lamp.state === 'wait';
      const pulse = waiting && state.live && !state.still ? 0.3 + 0.3 * Math.abs(Math.sin(t * 2.4)) : 0;
      entry.mat.color.copy(color);
      entry.mat.emissive.copy(waiting ? new THREE.Color('#9db4ff') : color);
      entry.mat.emissiveIntensity = waiting ? pulse : lamp.state === 'skip' ? 0.2 : 2.2;
      entry.light.color.copy(color);
      entry.light.intensity = waiting || lamp.state === 'skip' ? 0 : 1.5;
    });
  }

  private animateCourier(dt: number, still: boolean): void {
    const c = this.courier;
    if (!c.route || !c.route.length || still) { c.mesh.visible = false; return; }
    const color = new THREE.Color(TONE[c.tone] ?? '#9DB4FF');
    c.mat.emissive.copy(color);
    (c.trail.material as THREE.MeshBasicMaterial).color.copy(color);
    c.mesh.visible = true;
    const target = c.route[0]!;
    const dist = c.mesh.position.distanceTo(target);
    const atGate = target.distanceTo(GATE.clone().add(new THREE.Vector3(0, 1.0, 0))) < 0.01;
    if (dist < 0.05) {
      if (atGate) { this.gate.flash = 1; c.t += dt; if (c.t < 0.7) return; }
      c.t = 0;
      c.route.shift();
      if (!c.route.length) { c.mesh.visible = false; c.route = null; }
      return;
    }
    const step = Math.min(dist, dt * 3.2);
    const dir = target.clone().sub(c.mesh.position).normalize();
    c.mesh.position.addScaledVector(dir, step);
    c.mesh.position.y += Math.sin(Math.min(1, dist / 4) * Math.PI) * dt * 0.6;
    c.mesh.rotation.y += dt * 2;
  }

  dispose(): void {
    this.renderer.dispose();
    this.composer.dispose();
    this.scene.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach(m => m.dispose()); else material?.dispose();
    });
  }
}

/** Fixes an object to a bone, with offset and size given in the robot's own frame (metres, +z = where it faces). */
function fixTo(bone: THREE.Bone | undefined, object: THREE.Object3D, x: number, y: number, z: number, fallbackScale: number): void {
  if (!bone) return;
  const k = bone.getWorldScale(new THREE.Vector3()).x || fallbackScale;
  const inverse = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
  object.quaternion.premultiply(inverse);
  object.scale.setScalar(1 / k);
  object.position.copy(new THREE.Vector3(x, y, z).applyQuaternion(inverse).divideScalar(k));
  object.traverse(node => { if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).castShadow = true; });
  bone.add(object);
}

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _p = new THREE.Quaternion();

/** Turns a bone (in world space) so the direction to its child points at `target`. */
function aim(bone: THREE.Bone | undefined, child: THREE.Object3D | undefined, target: THREE.Vector3): void {
  if (!bone || !child || !bone.parent) return;
  const origin = bone.getWorldPosition(_a);
  const current = child.getWorldPosition(_b).sub(origin).normalize();
  const wanted = target.clone().sub(origin).normalize();
  const turn = new THREE.Quaternion().setFromUnitVectors(current, wanted);
  const world = bone.getWorldQuaternion(_q);
  const parent = bone.parent.getWorldQuaternion(_p).invert();
  bone.quaternion.copy(parent.multiply(turn.multiply(world)));
  bone.updateMatrixWorld(true);
}

/** Two-bone reach: the elbow goes toward `elbow`, then the forearm points at the hand target. */
function reach(upper: THREE.Bone | undefined, lower: THREE.Bone | undefined, hand: THREE.Object3D | undefined, target: THREE.Vector3, elbow: THREE.Vector3): void {
  if (!upper || !lower) return;
  const shoulder = upper.getWorldPosition(new THREE.Vector3());
  const upperLength = lower.getWorldPosition(new THREE.Vector3()).distanceTo(shoulder);
  // put the elbow on the line from the shoulder toward the hint, one upper-arm length away
  const elbowAt = elbow.clone().sub(shoulder).setLength(upperLength).add(shoulder);
  aim(upper, lower, elbowAt.lerp(target, 0.35));
  aim(lower, hand, target);
}

/** Rotates a bone about a world axis, keeping its parent as it is. */
function rotateWorld(bone: THREE.Bone | undefined, axis: THREE.Vector3, angle: number): void {
  if (!bone || !bone.parent) return;
  const turn = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(parent.multiply(turn.multiply(world)));
  bone.updateMatrixWorld(true);
}

function turnTowards(current: number, target: number, k: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * Math.min(1, k);
}

function fit(g: CanvasRenderingContext2D, text: string, width: number): string {
  if (g.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s}…`;
}

function wrapText(g: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of text) {
    if (g.measureText(line + ch).width > width) {
      out.push(line);
      line = ch.trim() ? ch : '';
      if (out.length === maxLines) break;
    } else line += ch;
  }
  if (out.length < maxLines && line) out.push(line);
  else if (out.length === maxLines && line) out[maxLines - 1] = fit(g, `${out[maxLines - 1]}${line}`, width);
  return out;
}
