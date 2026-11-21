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
const GATE = new THREE.Vector3(0, 0, -1.2);
const BODY: Record<string, string> = { lead: '#F2C14E', builder: '#F0843C', verifier: '#8C9BFF', researcher: '#4FC29A' };
const RUNTIME: Record<string, string> = { codex: '#3CC3B0', claude: '#A993FF' };
const TONE: Record<string, string> = { info: '#9DB4FF', ok: '#7FCF8F', problem: '#FF8F84' };
const LAMP: Record<LampState, string> = { ok: '#7FCF8F', fail: '#FF8F84', skip: '#6F7A8E', wait: '#323B4E' };

type Clip = 'Idle' | 'Walking' | 'Wave' | 'ThumbsUp' | 'No' | 'Yes' | 'Sitting' | 'Standing' | 'Dance' | 'Jump';
type Trip = { kind: 'deliver'; phase: 'out' | 'scan' | 'back'; t: number; carrying: boolean } | null;

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
  trip: Trip;
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
    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of clips) actions.set(clip.name, mixer.clipAction(clip));
    for (const name of ['Wave', 'ThumbsUp', 'No', 'Yes', 'Jump']) { const a = actions.get(name); if (a) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } }
    actions.get('Idle')?.play();

    // the ring under the robot shows its model's colour (Codex teal / Claude violet)
    const ringMat = new THREE.MeshBasicMaterial({ color: '#9DB4FF' });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 8, 64), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.02;
    group.add(ring);

    // accessories, fixed to the head and hands so they follow the animations (sizes in metres)
    group.updateMatrixWorld(true);
    const probe = new THREE.Group(); probe.add(model); probe.updateMatrixWorld(true);
    this.addAccessories(role, bones, scale);
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
      mood: 'idle', moodSince: 0, seen: false, trip: null, oneShot: null,
    };
  }

  private addAccessories(role: string, bones: Robot['bones'], scale: number): void {
    const head = bones.Head;
    const handR = bones.Palm2R ?? bones.LowerArmR;
    const handL = bones.Palm2L ?? bones.LowerArmL;
    // bones live in model units; children are sized in metres and divided by the model scale
    // offsets and sizes are given in the robot's own frame (metres, +z = where it faces), whatever the bone's axes are
    const attach = (bone: THREE.Bone | undefined, object: THREE.Object3D, x: number, y: number, z: number): void => {
      if (!bone) return;
      const k = bone.getWorldScale(new THREE.Vector3()).x || scale;
      const inverse = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
      object.quaternion.premultiply(inverse);
      object.scale.setScalar(1 / k);
      object.position.copy(new THREE.Vector3(x, y, z).applyQuaternion(inverse).divideScalar(k));
      object.traverse(node => { if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).castShadow = true; });
      bone.add(object);
    };
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
      const monocle = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 28), gold);
      attach(head, monocle, -0.22, 0.25, 0.5);
    } else if (role === 'researcher') {
      const book = new THREE.Group();
      const cover = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.06), new THREE.MeshStandardMaterial({ color: '#7a3e2a', roughness: 0.6 }));
      const pages = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.062), new THREE.MeshStandardMaterial({ color: '#f1ece0', roughness: 0.9 })); pages.position.x = 0.012;
      book.add(cover, pages);
      book.rotation.x = -0.9;
      attach(handL, book, 0.1, 0.06, 0.08);
      const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.08, 12, 28), new THREE.MeshStandardMaterial({ color: '#2f8f88', roughness: 0.8 }));
      scarf.rotation.x = Math.PI / 2;
      attach(bones.Neck, scarf, 0, 0.02, 0);
    }
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

  /** The clip a robot should be in at its desk for its mood. */
  private restingClip(robot: Robot): Clip {
    switch (robot.mood) {
      case 'asking': return 'Wave';
      case 'idle': return 'Idle';
      default: return 'Idle';
    }
  }

  private project(p: THREE.Vector3): Anchor | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (1 - (v.y * 0.5 + 0.5)) * this.height };
  }

  anchors(): { tags: Record<string, Anchor | null>; gate: Anchor | null; gateBase: Anchor | null } {
    const tags: Record<string, Anchor | null> = {};
    // name tags sit on the floor in front of each desk, clear of the screens
    for (const [role, robot] of this.robots) tags[role] = robot.group.visible ? this.project(new THREE.Vector3(0, 0, 1.25).applyAxisAngle(new THREE.Vector3(0, 1, 0), robot.homeYaw).add(robot.home)) : null;
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
    const working = [...this.robots.values()].find(robot => robot.group.visible && robot.mood === 'working');
    const goal = working ? new THREE.Vector3(working.home.x * 0.25, 1.0, working.home.z * 0.2 - 0.3) : new THREE.Vector3(0, 1.0, -0.3);
    this.focus.lerp(goal, state.still ? 1 : 1 - Math.exp(-dt * 0.8));
    const radius = 11.8, pitch = 0.5;
    this.camera.position.set(this.focus.x + Math.sin(yaw) * radius * Math.cos(pitch), this.focus.y + radius * Math.sin(pitch), this.focus.z + Math.cos(yaw) * radius * Math.cos(pitch));
    this.camera.lookAt(this.focus);
    this.composer.render(dt);
  }

  private onMood(robot: Robot, mood: Mood, now: number, state: OfficeState): void {
    const before = robot.mood;
    robot.mood = mood;
    robot.moodSince = now;
    if (state.still || robot.trip) return;
    if (mood === 'done' && before === 'working') this.oneShot(robot, 'ThumbsUp');
    else if (mood === 'failed') this.oneShot(robot, 'No');
    else if (mood === 'working' && before !== 'working') this.oneShot(robot, 'Yes');
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
    if (sender && sender.group.visible && !sender.trip) {
      // the sender walks it over; the document leaves its hands at the gate
      sender.trip = { kind: 'deliver', phase: 'out', t: 0, carrying: true };
      this.play(sender, 'Walking', 0.3);
      this.courier.route = null;
    } else {
      // the harness itself sends it (a sent-back reason): it starts in the gate
      this.courier.mesh.position.copy(gateIn);
      this.courier.route = [...this.pendingRoute];
    }
  }

  private animateRobot(robot: Robot, accent: string, t: number, now: number, dt: number, still: boolean): void {
    const g = robot.group;
    const trip = robot.trip;
    const stop = GATE.clone().add(robot.home.clone().sub(GATE).setLength(1.75));
    if (trip) {
      const speed = 1.35;
      const legLength = robot.home.distanceTo(stop);
      if (trip.phase === 'out' || trip.phase === 'back') {
        trip.t += (dt * speed) / legLength;
        const k = Math.min(1, trip.t);
        const from = trip.phase === 'out' ? robot.home : stop, to = trip.phase === 'out' ? stop : robot.home;
        g.position.lerpVectors(from, to, k);
        const dir = to.clone().sub(from);
        const heading = Math.atan2(dir.x, dir.z);
        g.rotation.y = turnTowards(g.rotation.y, heading, dt * 8);
        if (k >= 1) {
          if (trip.phase === 'out') {
            trip.phase = 'scan'; trip.t = 0;
            this.play(robot, 'Idle', 0.3);
            // hand the document to the gate
            this.courier.route = [...this.pendingRoute];
            this.courier.t = 0;
            this.courier.mesh.position.copy(g.position).add(new THREE.Vector3(0, 1.0, 0));
            trip.carrying = false;
          } else {
            robot.trip = null;
            this.play(robot, this.restingClip(robot), 0.3);
          }
        }
      } else if (trip.phase === 'scan') {
        trip.t += dt;
        g.rotation.y = turnTowards(g.rotation.y, Math.atan2(GATE.x - g.position.x, GATE.z - g.position.z), dt * 6);
        if (trip.t > 1.2) { trip.phase = 'back'; trip.t = 0; this.play(robot, 'Walking', 0.3); }
      }
      robot.doc.visible = false;
    } else {
      g.position.lerp(robot.home, 1 - Math.exp(-dt * 6));
      g.rotation.y = turnTowards(g.rotation.y, robot.homeYaw, dt * 5);
      if (!robot.oneShot) this.play(robot, this.restingClip(robot));
      robot.doc.visible = robot.mood === 'done';
    }

    // bones the current clip does not animate keep their rest pose, so the typing offsets never pile up
    for (const [bone, rest] of robot.rest) bone.quaternion.copy(rest);
    robot.mixer.update(still ? 0 : dt);

    // working: the hands reach for the keyboard (or the role's tool) and the head follows the work, on top of Idle
    const working = !trip && !robot.oneShot && robot.mood === 'working' && robot.current === 'Idle';
    if (working) {
      robot.model.updateMatrixWorld(true);
      const b = robot.bones;
      const rate = robot.role === 'builder' ? 14 : 8;
      const tap = (phase: number): number => Math.max(0, Math.sin(t * rate + phase)) * 0.06;
      const local = (x: number, y: number, z: number): THREE.Vector3 => g.localToWorld(new THREE.Vector3(x, y, z));
      let left: THREE.Vector3, right: THREE.Vector3;
      if (robot.role === 'verifier') {
        left = local(0.25, 0.8 + tap(0), 0.44);
        right = local(-0.05 + Math.sin(t * 1.3) * 0.22, 1.05, 0.5);
        rotateWorld(b.Head, g.localToWorld(new THREE.Vector3(0, 1, 0)).sub(g.position).normalize(), Math.sin(t * 1.3) * 0.25);
      } else if (robot.role === 'lead') {
        left = local(0.12, 1.0, 0.4);
        right = local(-0.05, 0.98 + tap(0) * 1.5, 0.45);
      } else if (robot.role === 'researcher') {
        left = local(0.14, 0.98, 0.42);
        right = local(-0.14, 0.98 + Math.max(0, Math.sin(t * 2)) * 0.08, 0.42);
      } else {
        left = local(0.25, 0.8 + tap(0), 0.46);
        right = local(-0.25, 0.8 + tap(1.9), 0.46);
      }
      reach(b.UpperArmL, b.LowerArmL, b.Palm2L, left, g.localToWorld(new THREE.Vector3(0.34, 0.85, 0.05)));
      reach(b.UpperArmR, b.LowerArmR, b.Palm2R, right, g.localToWorld(new THREE.Vector3(-0.34, 0.85, 0.05)));
      const sideways = new THREE.Vector3(1, 0, 0).applyQuaternion(g.quaternion);
      rotateWorld(b.Head, sideways, 0.16 + Math.sin(t * 1.1) * 0.05);
    }
    robot.keys.opacity = working ? 0.55 + Math.sin(t * 8) * 0.15 : 0;

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

  private animateGate(state: OfficeState, t: number, dt: number): void {
    const gate = this.gate;
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
