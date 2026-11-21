// The 3D agent room: one AI character per role at its own station, the harness core in the middle with a lamp per
// check, and the work packet the harness passes between roles. Everything shown comes from the run's events:
// moods from the steps, screen text from stationOf, the packet from the latest hand-off.

import { box, capsule, cylinder, disc, hex, Node, quad, Renderer, sphere, torus } from './gl3d.ts';
import type { Camera, Material, Vec3 } from './gl3d.ts';
import type { LampState, Mood } from './scene.ts';

export interface PanelView { title: string; lines: string[]; foot: string; tone: 'work' | 'ok' | 'bad' | 'ask' | 'idle' }
export interface CrewState {
  robots: { role: string; mood: Mood }[];
  panels: Record<string, PanelView>;
  lamps: { gate: string; state: LampState }[];
  handoff: { id: string; from: string; to: string; tone: 'info' | 'ok' | 'problem' } | null;
  runtimes: Record<string, string> | undefined;
  live: boolean;
  still: boolean;
}

export const SEATS: Record<string, { pos: Vec3; yaw: number; side: number }> = {
  lead: { pos: [-3.9, 0, -2.6], yaw: 0.4, side: -1 },
  verifier: { pos: [3.9, 0, -2.6], yaw: -0.4, side: 1 },
  builder: { pos: [1.45, 0, 2.3], yaw: -0.2, side: 1 },
  researcher: { pos: [-1.45, 0, 2.3], yaw: 0.2, side: -1 },
};
const CORE: Vec3 = [0, 0, -0.3];
const RUNTIME: Record<string, string> = { codex: '#3CC3B0', claude: '#A993FF' };
const TONE: Record<string, string> = { info: '#9DB4FF', ok: '#7FCF8F', problem: '#FF8F84' };
const LAMP: Record<LampState, string> = { ok: '#7FCF8F', fail: '#FF8F84', skip: '#6F7A8E', wait: '#3A4458' };
const BODY: Record<string, string> = { lead: '#E8EBF1', builder: '#DCE1E8', verifier: '#E2DEEE', researcher: '#DCE8E4' };

const scale3 = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
const mix3 = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const ease = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
const approach = (current: number, target: number, dt: number, speed = 8): number => current + (target - current) * (1 - Math.exp(-speed * dt));

interface Rig {
  role: string;
  root: Node; body: Node; head: Node; eyes: Node[];
  shoulderL: Node; shoulderR: Node; elbowL: Node; elbowR: Node; page: Node | null;
  eyeMat: Material; chestMat: Material; ringMat: Material; tipMat: Material; glowMat: Material; keysMat: Material; keys: Node;
  panel: Node; stand: Node; panelMat: Material; panelCanvas: HTMLCanvasElement; panelKey: string; panelDrawnAt: number;
  mood: Mood; moodSince: number; blinkAt: number; blinkEnd: number; seen: boolean;
  pose: { bodyY: number; headX: number; headY: number; headZ: number; sLx: number; sLz: number; sRx: number; sRz: number; eL: number; eR: number; spin: number };
}

export class Crew {
  private r: Renderer;
  private world = new Node();
  private rigs = new Map<string, Rig>();
  private core: { crystal: Node; ringA: Node; ringB: Node; lamps: { node: Node; mat: Material; glow: Material }[]; crystalMat: Material; flash: number };
  private packet: { node: Node; mat: Material; glowMat: Material; id: string; start: number; once: boolean };
  private floorCanvas = document.createElement('canvas');
  private floorMat: Material;
  private floorKey = '';
  private state: CrewState | null = null;
  private last = 0;
  yaw = 0;
  camera: Camera = { eye: [0, 8, 12], target: [0, 0.9, 0.5], fov: 0.6 };

  constructor(canvas: HTMLCanvasElement) {
    this.r = new Renderer(canvas);
    const r = this.r;
    // floor: a round platform with a painted grid
    this.floorCanvas.width = this.floorCanvas.height = 1024;
    this.floorMat = { color: [1, 1, 1], texture: null, unlit: true };
    const platform = new Node(r.mesh('platform', () => cylinder(7.2, 7.4, 0.36, 72)), { color: hex('#141922') }).at(0, -0.19, 0);
    const floor = new Node(r.mesh('floor', () => disc(7.2, 72)), this.floorMat).at(0, 0.002, 0);
    this.world.add(platform, floor);
    this.core = this.buildCore();
    this.packet = this.buildPacket();
    for (const role of Object.keys(SEATS)) this.rigs.set(role, this.buildRig(role));
  }

  // ---------- building ----------

  private buildCore(): Crew['core'] {
    const r = this.r;
    const base = new Node().at(...CORE);
    base.add(
      new Node(r.mesh('core-base', () => cylinder(0.95, 1.1, 0.34, 48)), { color: hex('#2A3346'), shine: 0.3 }).at(0, 0.17, 0),
      new Node(r.mesh('core-edge', () => torus(1.0, 0.03, 64, 8)), { color: hex('#9DB4FF'), emissive: scale3(hex('#9DB4FF'), 0.6), unlit: true }).at(0, 0.35, 0),
      new Node(r.mesh('core-col', () => cylinder(0.14, 0.24, 0.8, 24)), { color: hex('#1E2533'), shine: 0.5 }).at(0, 0.74, 0),
    );
    const crystalMat: Material = { color: hex('#B9C8FF'), emissive: scale3(hex('#9DB4FF'), 0.45), shine: 0.9 };
    const crystal = new Node(r.mesh('crystal', () => sphere(0.3, 6, 4)), crystalMat).at(0, 1.42, 0);
    const ringMat: Material = { color: hex('#9DB4FF'), emissive: scale3(hex('#9DB4FF'), 0.7), unlit: true, alpha: 0.85, additive: true };
    const ringA = new Node(r.mesh('core-ring', () => torus(0.56, 0.022, 64, 8)), ringMat).at(0, 1.42, 0);
    const ringB = new Node(r.mesh('core-ring2', () => torus(0.7, 0.016, 64, 8)), ringMat).at(0, 1.42, 0);
    const halo = new Node(r.mesh('halo', () => sphere(0.62, 20, 12)), { color: hex('#9DB4FF'), unlit: true, alpha: 0.12, additive: true }).at(0, 1.42, 0);
    base.add(crystal, ringA, ringB, halo);
    const lamps = [-0.38, 0, 0.38].map(x => {
      const mat: Material = { color: hex(LAMP.wait), emissive: [0, 0, 0], shine: 0.8 };
      const glow: Material = { color: hex(LAMP.wait), unlit: true, alpha: 0.0, additive: true };
      const node = new Node(r.mesh('lamp', () => sphere(0.085, 16, 10)), mat).at(x, 0.43, 0.82);
      node.add(new Node(r.mesh('lamp-glow', () => sphere(0.2, 16, 10)), glow));
      base.add(node);
      return { node, mat, glow };
    });
    this.world.add(base);
    return { crystal, ringA, ringB, lamps, crystalMat, flash: 0 };
  }

  private buildPacket(): Crew['packet'] {
    const r = this.r;
    const mat: Material = { color: hex('#E6EAF2'), emissive: scale3(hex('#9DB4FF'), 0.6), shine: 0.8 };
    const glowMat: Material = { color: hex('#9DB4FF'), unlit: true, alpha: 0.35, additive: true };
    const node = new Node(r.mesh('packet', () => box(0.2, 0.26, 0.05)), mat);
    node.add(new Node(r.mesh('packet-glow', () => sphere(0.26, 16, 10)), glowMat));
    node.visible = false;
    this.world.add(node);
    return { node, mat, glowMat, id: '', start: 0, once: false };
  }

  private buildRig(role: string): Rig {
    const r = this.r;
    const seat = SEATS[role]!;
    const shell: Material = { color: hex(BODY[role] ?? '#DDE2EA'), shine: 0.35 };
    const dark: Material = { color: hex('#0E131C'), shine: 0.9 };
    const joint: Material = { color: hex('#7C879A'), shine: 0.3 };
    const eyeMat: Material = { color: [0, 0, 0], emissive: hex('#9DB4FF'), unlit: true };
    const chestMat: Material = { color: [0, 0, 0], emissive: hex('#9DB4FF'), unlit: true };
    const ringMat: Material = { color: hex('#9DB4FF'), emissive: scale3(hex('#9DB4FF'), 0.8), unlit: true };
    const tipMat: Material = { color: [0, 0, 0], emissive: hex('#9DB4FF'), unlit: true };
    const glowMat: Material = { color: hex('#9DB4FF'), unlit: true, alpha: 0.22, additive: true };

    const root = new Node().at(...seat.pos).turn(0, seat.yaw, 0);
    root.add(
      new Node(r.mesh('shadow', () => disc(0.55, 32)), { color: [0, 0, 0], unlit: true, alpha: 0.45 }).at(0, 0.012, 0),
      new Node(r.mesh('glow-disc', () => disc(0.85, 32)), glowMat).at(0, 0.02, 0),
      new Node(r.mesh('hover-ring', () => torus(0.3, 0.035, 40, 8)), ringMat).at(0, 0.15, 0),
    );

    const body = new Node().at(0, 0.66, 0);
    root.add(body);
    body.add(
      new Node(r.mesh('torso', () => capsule(0.34, 0.26)), shell),
      new Node(r.mesh('belt', () => torus(0.335, 0.03, 40, 8)), joint).at(0, -0.1, 0),
      new Node(r.mesh('chest', () => sphere(0.07, 14, 10)), chestMat).at(0, 0.12, 0.3),
      new Node(r.mesh('neck', () => cylinder(0.11, 0.13, 0.14, 16)), joint).at(0, 0.5, 0),
    );

    const head = new Node().at(0, 0.88, 0);
    body.add(head);
    const eyes = [-0.1, 0.1].map(x => new Node(r.mesh('eye', () => capsule(0.04, 0.03, 12)), eyeMat).at(x, 0.0, 0.36));
    head.add(
      new Node(r.mesh('head', () => sphere(0.36, 28, 18)), shell),
      new Node(r.mesh('visor', () => capsule(0.135, 0.3, 20)), dark).at(0, 0.0, 0.24).turn(0, 0, Math.PI / 2),
      ...eyes,
      new Node(r.mesh('ear', () => cylinder(0.085, 0.085, 0.07, 16)), joint).at(-0.36, 0, 0).turn(0, 0, Math.PI / 2),
      new Node(r.mesh('ear', () => cylinder(0.085, 0.085, 0.07, 16)), joint).at(0.36, 0, 0).turn(0, 0, Math.PI / 2),
      new Node(r.mesh('antenna', () => cylinder(0.014, 0.014, 0.22, 8)), joint).at(0, 0.45, 0),
      new Node(r.mesh('tip', () => sphere(0.045, 12, 8)), tipMat).at(0, 0.58, 0),
    );

    const arm = (side: number): { shoulder: Node; elbow: Node; hand: Node } => {
      const shoulder = new Node().at(side * 0.4, 0.2, 0);
      const elbow = new Node().at(0, -0.3, 0);
      const hand = new Node(r.mesh('hand', () => sphere(0.085, 14, 10)), joint).at(0, -0.28, 0);
      shoulder.add(
        new Node(r.mesh('shoulder', () => sphere(0.1, 14, 10)), joint),
        new Node(r.mesh('upper', () => capsule(0.075, 0.16, 14)), shell).at(0, -0.15, 0),
        elbow,
      );
      elbow.add(new Node(r.mesh('fore', () => capsule(0.068, 0.14, 14)), shell).at(0, -0.13, 0), hand);
      body.add(shoulder);
      return { shoulder, elbow, hand };
    };
    const left = arm(-1);
    const right = arm(1);

    // role look: something you can tell apart from across the room
    let page: Node | null = null;
    if (role === 'lead') {
      const band: Material = { color: hex('#E0B85A'), shine: 0.6 };
      head.add(
        new Node(r.mesh('headset', () => torus(0.385, 0.025, 32, 8, Math.PI)), band).turn(0, Math.PI / 2, Math.PI / 2),
        new Node(r.mesh('cup', () => cylinder(0.11, 0.11, 0.08, 16)), band).at(-0.39, 0, 0).turn(0, 0, Math.PI / 2),
        new Node(r.mesh('cup', () => cylinder(0.11, 0.11, 0.08, 16)), band).at(0.39, 0, 0).turn(0, 0, Math.PI / 2),
        new Node(r.mesh('mic', () => capsule(0.018, 0.2, 8)), band).at(-0.3, -0.17, 0.2).turn(0.9, 0.5, 0.9),
        new Node(r.mesh('mic-tip', () => sphere(0.035, 10, 8)), dark).at(-0.2, -0.24, 0.32),
      );
      const tablet = new Node(r.mesh('tablet', () => box(0.34, 0.44, 0.03)), { color: hex('#2A3346'), shine: 0.6 }).at(0, -0.06, 0.08).turn(-1.1, 0, 0);
      tablet.add(new Node(r.mesh('tablet-screen', () => quad(0.29, 0.38)), { color: hex('#9DB4FF'), unlit: true, alpha: 0.75, additive: true }).at(0, 0, 0.017));
      left.hand.add(tablet);
    } else if (role === 'builder') {
      const hat: Material = { color: hex('#E6A23C'), shine: 0.55 };
      head.add(
        new Node(r.mesh('hat', () => sphere(0.36, 28, 10, Math.PI / 2)), hat).at(0, 0.19, -0.04),
        new Node(r.mesh('brim', () => cylinder(0.39, 0.39, 0.03, 32)), hat).at(0, 0.2, -0.02),
        new Node(r.mesh('hat-ridge', () => box(0.07, 0.06, 0.56)), hat).at(0, 0.54, -0.04),
      );
      body.add(new Node(r.mesh('toolbelt', () => torus(0.35, 0.05, 40, 8)), { color: hex('#5A4632'), shine: 0.2 }).at(0, -0.14, 0));
    } else if (role === 'verifier') {
      const gold: Material = { color: hex('#E0B85A'), shine: 0.7 };
      head.add(new Node(r.mesh('monocle', () => torus(0.08, 0.014, 24, 6)), gold).at(0.1, 0.0, 0.405).turn(Math.PI / 2, 0, 0));
      const glass = new Node().at(0, -0.05, 0.05).turn(-0.4, 0, 0);
      glass.add(
        new Node(r.mesh('handle', () => cylinder(0.025, 0.03, 0.2, 10)), { color: hex('#5A4632') }),
        new Node(r.mesh('lens-rim', () => torus(0.13, 0.02, 28, 6)), gold).at(0, 0.24, 0).turn(Math.PI / 2, 0, 0),
        new Node(r.mesh('lens', () => disc(0.12, 24)), { color: hex('#BFD3FF'), unlit: true, alpha: 0.3, additive: true }).at(0, 0.24, 0).turn(Math.PI / 2, 0, 0),
      );
      right.hand.add(glass);
    } else if (role === 'researcher') {
      body.add(new Node(r.mesh('scarf', () => torus(0.2, 0.075, 28, 10)), { color: hex('#3FA7A0'), shine: 0.2 }).at(0, 0.46, 0));
      const book = new Node().at(0.4, -0.02, 0.12).turn(-1.0, 0, 0);
      const cover: Material = { color: hex('#B5653A'), shine: 0.2 };
      const paper: Material = { color: hex('#F1EEE6'), shine: 0.05 };
      book.add(
        new Node(r.mesh('cover', () => box(0.5, 0.36, 0.02)), cover),
        new Node(r.mesh('pages', () => box(0.46, 0.33, 0.03)), paper).at(0, 0, 0.022),
      );
      page = new Node(r.mesh('page', () => box(0.22, 0.32, 0.005)), paper).at(0, 0, 0.04);
      const pageInner = page;
      const hinge = new Node().at(0, 0, 0.04);
      pageInner.pos = [0.11, 0, 0];
      hinge.add(pageInner);
      book.add(hinge);
      page = hinge;
      left.hand.add(book);
    }

    // the station: a holo keyboard in front, a screen at the outer side
    const keysMat: Material = { color: hex('#9DB4FF'), unlit: true, alpha: 0.35, additive: true };
    const keys = new Node(r.mesh('keys', () => quad(0.86, 0.34)), keysMat).at(0, 0.78, 0.6).turn(-1.1, 0, 0);
    const panelCanvas = document.createElement('canvas');
    panelCanvas.width = 576; panelCanvas.height = 360;
    const panelMat: Material = { color: [1, 1, 1], unlit: true, texture: null, alpha: 0.96 };
    // the screen lives in world space so it can turn to the camera on its own
    const [ox, oz] = [seat.side * 1.75, 0.1];
    const wx = seat.pos[0] + Math.cos(seat.yaw) * ox + Math.sin(seat.yaw) * oz;
    const wz = seat.pos[2] - Math.sin(seat.yaw) * ox + Math.cos(seat.yaw) * oz;
    const panel = new Node(r.mesh('panel', () => quad(2.3, 1.44)), panelMat).at(wx, seat.pos[2] > 0 ? 1.75 : 2.1, wz);
    const stand = new Node(r.mesh('panel-stand', () => cylinder(0.02, 0.02, 1.4, 8)), { color: hex('#3A4458') }).at(wx, 0.7, wz);
    root.add(keys);
    root.scale = 1.3;
    if (seat.pos[2] < 0) panel.scale = 1.3;
    this.world.add(panel, stand);
    this.world.add(root);
    return {
      role, root, body, head, eyes, shoulderL: left.shoulder, shoulderR: right.shoulder, elbowL: left.elbow, elbowR: right.elbow, page,
      eyeMat, chestMat, ringMat, tipMat, glowMat, keysMat, keys, panel, stand, panelMat, panelCanvas, panelKey: '', panelDrawnAt: 0,
      mood: 'idle', moodSince: 0, blinkAt: 2 + Math.random() * 3, blinkEnd: 0, seen: false,
      pose: { bodyY: 0.56, headX: 0.35, headY: 0, headZ: 0, sLx: 0, sLz: 0.1, sRx: 0, sRz: -0.1, eL: 0, eR: 0, spin: 0 },
    };
  }

  // ---------- painting ----------

  private paintFloor(runtimes: Record<string, string> | undefined, roles: string[]): void {
    const key = JSON.stringify([runtimes, roles]);
    if (key === this.floorKey) return;
    this.floorKey = key;
    const c = this.floorCanvas, g = c.getContext('2d')!;
    const S = c.width, R = 7.2;
    const px = (x: number): number => (0.5 + x / (2 * R)) * S;
    g.clearRect(0, 0, S, S);
    const bg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    bg.addColorStop(0, '#222A38'); bg.addColorStop(1, '#181D27');
    g.fillStyle = bg; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.clip();
    g.strokeStyle = 'rgba(157,180,255,0.07)'; g.lineWidth = 1;
    for (let i = 0; i <= S; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); }
    g.restore();
    g.strokeStyle = 'rgba(157,180,255,0.18)'; g.lineWidth = 2;
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2); g.stroke();
    const cx = px(CORE[0]), cz = px(CORE[2]);
    for (const role of roles) {
      const seat = SEATS[role]!;
      const color = RUNTIME[runtimes?.[role] ?? ''] ?? '#9DB4FF';
      const sx = px(seat.pos[0]), sz = px(seat.pos[2]);
      g.setLineDash([10, 10]); g.strokeStyle = 'rgba(157,180,255,0.35)'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(sx, sz); g.lineTo(cx, cz); g.stroke(); g.setLineDash([]);
      const glow = g.createRadialGradient(sx, sz, 10, sx, sz, 120);
      glow.addColorStop(0, `${color}55`); glow.addColorStop(1, `${color}00`);
      g.fillStyle = glow; g.beginPath(); g.arc(sx, sz, 120, 0, Math.PI * 2); g.fill();
      g.strokeStyle = `${color}AA`; g.lineWidth = 3; g.beginPath(); g.arc(sx, sz, 92, 0, Math.PI * 2); g.stroke();
    }
    const core = g.createRadialGradient(cx, cz, 10, cx, cz, 150);
    core.addColorStop(0, 'rgba(157,180,255,0.35)'); core.addColorStop(1, 'rgba(157,180,255,0)');
    g.fillStyle = core; g.beginPath(); g.arc(cx, cz, 150, 0, Math.PI * 2); g.fill();
    this.floorMat.texture = this.r.texture(c, this.floorMat.texture);
  }

  private paintPanel(rig: Rig, view: PanelView, accent: string, now: number, animate: boolean): void {
    const key = JSON.stringify(view) + accent;
    if (key === rig.panelKey && !(animate && now - rig.panelDrawnAt > 0.12)) return;
    rig.panelKey = key; rig.panelDrawnAt = now;
    const c = rig.panelCanvas, g = c.getContext('2d')!;
    const W = c.width, H = c.height;
    const toneColor = view.tone === 'ok' ? '#7FCF8F' : view.tone === 'bad' ? '#FF8F84' : view.tone === 'ask' ? '#F0C063' : view.tone === 'idle' ? '#6F7A8E' : accent;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(16,22,34,0.86)';
    roundRect(g, 4, 4, W - 8, H - 8, 22); g.fill();
    g.strokeStyle = toneColor; g.lineWidth = 3; roundRect(g, 4, 4, W - 8, H - 8, 22); g.stroke();
    g.fillStyle = `${toneColor}22`; roundRect(g, 4, 4, W - 8, 72, 22); g.fill();
    g.fillStyle = toneColor; g.font = '700 38px "Noto Sans KR", "Malgun Gothic", sans-serif'; g.textBaseline = 'middle';
    g.fillText(fit(g, view.title, W - 48), 24, 41);
    g.fillStyle = '#E4E8F0'; g.font = '500 33px "Noto Sans KR", "Malgun Gothic", sans-serif';
    let y = 118;
    for (const line of view.lines) {
      for (const part of wrapText(g, line, W - 48, 3)) { if (y > H - 80) break; g.fillText(part, 24, y); y += 44; }
    }
    g.fillStyle = '#9AA4B6'; g.font = '500 27px "JetBrains Mono", "Noto Sans KR", monospace';
    g.fillText(fit(g, view.foot, W - 210), 24, H - 34);
    if (animate) {
      // activity meter: only says "busy", it carries no content
      for (let i = 0; i < 12; i++) {
        const h = 6 + 18 * Math.abs(Math.sin(now * 5 + i * 0.9));
        g.fillStyle = `${toneColor}AA`;
        g.fillRect(W - 24 - (12 - i) * 12, H - 26 - h, 7, h);
      }
    }
    rig.panelMat.texture = this.r.texture(c, rig.panelMat.texture);
  }

  // ---------- per frame ----------

  setState(state: CrewState): void { this.state = state; }

  resize(width: number, height: number, dpr: number): void { this.r.resize(width, height, dpr); }

  /** Where to put the HTML labels: under each robot, above its head, and above the packet. */
  anchors(): { tags: Record<string, { x: number; y: number } | null>; heads: Record<string, { x: number; y: number } | null>; core: { x: number; y: number } | null; coreBase: { x: number; y: number } | null } {
    const tags: Record<string, { x: number; y: number } | null> = {};
    const heads: Record<string, { x: number; y: number } | null> = {};
    for (const [role, rig] of this.rigs) {
      if (!rig.root.visible) { tags[role] = null; heads[role] = null; continue; }
      const p = rig.root.pos;
      tags[role] = this.r.project([p[0], 2.75, p[2]]);
      heads[role] = this.r.project([p[0], 3.05, p[2]]);
    }
    return { tags, heads, core: this.r.project([CORE[0], 2.35, CORE[2]]), coreBase: this.r.project([CORE[0], 0, CORE[2] + 1.25]) };
  }

  frame(seconds: number): void {
    const state = this.state;
    if (!state) return;
    const t = state.still ? 0.5 : seconds;
    const dt = this.last ? Math.min(0.1, Math.max(0, seconds - this.last)) : 0.016;
    this.last = seconds;
    const roles = state.robots.map(robot => robot.role);
    this.paintFloor(state.runtimes, roles);

    // camera: a gentle sway, plus what the user dragged
    const yaw = this.yaw + (state.still ? 0 : Math.sin(seconds * 0.12) * 0.06);
    const radius = 14.2, pitch = 0.52;
    const target: Vec3 = [0, 1.0, -0.2];
    this.camera = { eye: [target[0] + Math.sin(yaw) * radius * Math.cos(pitch), target[1] + radius * Math.sin(pitch), target[2] + Math.cos(yaw) * radius * Math.cos(pitch)], target, fov: 0.58 };

    for (const [role, rig] of this.rigs) {
      const robot = state.robots.find(item => item.role === role);
      rig.root.visible = rig.panel.visible = rig.stand.visible = !!robot;
      if (!robot) continue;
      // a robot already in its mood when the room opens does not replay the change (no cheering on every visit)
      if (!rig.seen) { rig.seen = true; rig.mood = robot.mood; rig.moodSince = seconds - 100; }
      else if (robot.mood !== rig.mood) { rig.mood = robot.mood; rig.moodSince = seconds; }
      const accent = RUNTIME[state.runtimes?.[role] ?? ''] ?? '#9DB4FF';
      this.animateRig(rig, accent, t, seconds, dt, state.still);
      const panelView = state.panels[role];
      if (panelView) this.paintPanel(rig, panelView, accent, seconds, rig.mood === 'working' && !state.still);
      // the screen turns to face the camera
      // screens stay parallel to the view, so their text reads as a flat card
      rig.panel.rot = [-pitch * 0.85, yaw, 0];
    }
    this.animateCore(state, t, dt);
    this.animatePacket(state, seconds);
    this.r.render(this.world, this.camera);
  }

  private animateRig(rig: Rig, accent: string, t: number, now: number, dt: number, still: boolean): void {
    const base = hex(accent);
    const since = now - rig.moodSince;
    const p = rig.pose;
    let eye = base, eyePower = 1.15, keys = 0;
    let target = { bodyY: 0.66, headX: 0, headY: 0, headZ: 0, sLx: 0.05, sLz: 0.12, sRx: 0.05, sRz: -0.12, eL: -0.1, eR: -0.1, spin: 0 };
    const typing = (rate: number, amount: number): void => {
      target.sLx = -1.0; target.sRx = -1.0; target.sLz = 0.28; target.sRz = -0.28;
      target.eL = -0.75 + Math.sin(t * rate) * amount; target.eR = -0.75 + Math.sin(t * rate + 1.7) * amount;
    };
    switch (rig.mood) {
      case 'working': {
        keys = 0.55 + 0.2 * Math.sin(t * 6);
        target.bodyY = 0.68 + Math.sin(t * 2.2) * 0.03;
        target.headX = 0.12 + Math.sin(t * 1.3) * 0.05;
        if (rig.role === 'builder') { typing(16, 0.22); target.headX = -0.08 + Math.sin(t * 1.3) * 0.04; target.headY = Math.sin(t * 0.8) * 0.15; }
        else if (rig.role === 'lead') {
          target.sLx = -1.05; target.sLz = 0.35; target.eL = -1.0;
          target.sRx = -0.9 + Math.sin(t * 3) * 0.12; target.sRz = -0.5; target.eR = -0.9 + Math.sin(t * 6) * 0.15;
          target.headX = 0.25; target.headY = 0.15 + Math.sin(t * 0.7) * 0.2;
        } else if (rig.role === 'verifier') {
          target.sRx = -1.25; target.sRz = -0.2 + Math.sin(t * 1.4) * 0.35; target.eR = -0.5;
          target.sLx = -0.95; target.sLz = 0.28; target.eL = -0.75 + Math.sin(t * 7) * 0.1;
          target.headY = Math.sin(t * 1.4) * 0.3; target.headX = 0.2;
        } else {
          target.sLx = -0.9; target.sLz = 0.25; target.eL = -0.95; target.sRx = -0.9; target.sRz = -0.3; target.eR = -0.95;
          target.headX = 0.28; target.headY = Math.sin(t * 0.9) * 0.1;
        }
        break;
      }
      case 'idle':
        eyePower = 0.3; target.bodyY = 0.54 + Math.sin(t * 0.9) * 0.015; target.headX = 0.38; target.sLx = 0.1; target.sRx = 0.1;
        break;
      case 'done': {
        eye = mix3(base, hex('#7FCF8F'), 0.35);
        if (since < 1.8 && !still) {
          const k = since / 1.8;
          target.sLz = 2.6; target.sRz = -2.6; target.sLx = -0.2; target.sRx = -0.2; target.eL = -0.3; target.eR = -0.3;
          target.bodyY = 0.7 + Math.abs(Math.sin(k * Math.PI * 3)) * 0.35; target.headX = -0.25;
          target.spin = ease(k / 0.7) * Math.PI * 2;
        } else {
          target.bodyY = 0.66 + Math.sin(t * 1.4) * 0.02; target.headX = -0.05; target.sLz = 0.3; target.sRz = -0.3; target.spin = 0;
        }
        break;
      }
      case 'failed':
        eye = hex('#FF6B5E'); eyePower = 0.9;
        target.bodyY = 0.5; target.headX = 0.55; target.sLx = 0.25; target.sRx = 0.25; target.sLz = 0.05; target.sRz = -0.05;
        if (since < 0.8 && !still) target.headY = Math.sin(since * 30) * 0.15 * (1 - since / 0.8);
        break;
      case 'asking':
        eye = hex('#F0C063');
        target.bodyY = 0.7 + Math.sin(t * 2) * 0.03; target.headZ = 0.2; target.headX = -0.1;
        target.sRz = -2.55 + Math.sin(t * 6) * 0.25; target.sRx = -0.1; target.eR = -0.35;
        break;
    }
    const speed = rig.mood === 'done' && since < 1.8 ? 14 : 7;
    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      if (key === 'spin') continue;
      p[key] = approach(p[key], target[key], dt, speed);
    }
    p.spin = rig.mood === 'done' && since < 1.8 ? target.spin : approach(p.spin, 0, dt, 4);

    rig.body.pos = [0, p.bodyY, 0];
    rig.body.rot = [0, p.spin, 0];
    rig.head.rot = [p.headX, p.headY, p.headZ];
    rig.shoulderL.rot = [p.sLx, 0, p.sLz];
    rig.shoulderR.rot = [p.sRx, 0, p.sRz];
    rig.elbowL.rot = [p.eL, 0, 0];
    rig.elbowR.rot = [p.eR, 0, 0];
    if (rig.page) rig.page.rot = [0, rig.mood === 'working' ? -((t * 0.6) % 1) * Math.PI : 0, 0];

    // blink
    if (now > rig.blinkAt) { rig.blinkEnd = now + 0.13; rig.blinkAt = now + 2.5 + Math.random() * 3; }
    const blinking = now < rig.blinkEnd && rig.mood !== 'idle' && !still;
    for (const e of rig.eyes) e.scale = blinking ? 0.25 : 1;
    rig.eyeMat.emissive = scale3(eye, eyePower);
    rig.chestMat.emissive = scale3(eye, eyePower * (0.7 + 0.3 * Math.sin(t * 3)));
    rig.tipMat.emissive = scale3(eye, rig.mood === 'working' ? 0.6 + 0.6 * Math.abs(Math.sin(t * 4)) : eyePower * 0.6);
    rig.ringMat.color = base; rig.ringMat.emissive = scale3(base, rig.mood === 'idle' ? 0.25 : 0.8);
    rig.glowMat.color = base; rig.glowMat.alpha = rig.mood === 'idle' ? 0.08 : 0.22;
    rig.keysMat.color = base; rig.keysMat.alpha = keys * 0.6;
    rig.keys.visible = keys > 0;
  }

  private animateCore(state: CrewState, t: number, dt: number): void {
    const c = this.core;
    c.crystal.rot = [0, t * 0.6, 0];
    c.ringA.rot = [0.6 + Math.sin(t * 0.5) * 0.2, t * 1.1, 0.2];
    c.ringB.rot = [-0.5, -t * 0.8, 0.4 + Math.cos(t * 0.4) * 0.2];
    c.flash = Math.max(0, c.flash - dt * 1.8);
    c.crystalMat.emissive = scale3(mix3(hex('#9DB4FF'), hex(TONE[state.handoff?.tone ?? 'info']!), c.flash), 0.45 + c.flash * 0.9);
    c.ringA.scale = c.ringB.scale = 1 + c.flash * 0.25;
    state.lamps.forEach((lamp, index) => {
      const entry = c.lamps[index];
      if (!entry) return;
      const color = hex(LAMP[lamp.state]);
      const blink = lamp.state === 'wait' && state.live ? 0.4 + 0.4 * Math.abs(Math.sin(t * 2.5)) : 0;
      entry.mat.color = color;
      entry.mat.emissive = lamp.state === 'wait' ? scale3(hex('#9DB4FF'), blink * 0.5) : scale3(color, 0.7);
      entry.glow.color = color;
      entry.glow.alpha = lamp.state === 'wait' ? blink * 0.25 : lamp.state === 'skip' ? 0.05 : 0.4;
    });
    this.r.point = { pos: [CORE[0], 1.6, CORE[2]], color: scale3(mix3(hex('#6F86D6'), hex(TONE[state.handoff?.tone ?? 'info']!), c.flash), 0.6 + c.flash * 1.4) };
  }

  private spot(role: string): Vec3 {
    if (role === 'harness') return [CORE[0], 1.42, CORE[2]];
    if (role === 'you') return [0, 3.2, 6.5];
    const seat = SEATS[role];
    return seat ? [seat.pos[0], 1.7, seat.pos[2]] : [0, 1.4, 0];
  }

  private animatePacket(state: CrewState, now: number): void {
    const pk = this.packet;
    const h = state.handoff;
    if (!h) { pk.node.visible = false; return; }
    if (h.id !== pk.id) { pk.id = h.id; pk.start = now; pk.once = false; }
    const cycle = 3.2;
    let k = (now - pk.start) / 2.6;
    if (state.live && !state.still) k = ((now - pk.start) % cycle) / 2.6;
    if (k > 1 || state.still) { pk.node.visible = false; return; }
    pk.node.visible = true;
    const color = hex(TONE[h.tone] ?? '#9DB4FF');
    pk.mat.emissive = scale3(color, 0.7);
    pk.glowMat.color = color;
    const from = this.spot(h.from), mid = this.spot('harness'), to = this.spot(h.to);
    const viaCore = h.from !== 'harness' && h.to !== 'harness';
    const leg = (a: Vec3, b: Vec3, x: number): Vec3 => {
      const e = ease(x);
      const lift = Math.sin(e * Math.PI) * 1.1;
      return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e + lift, a[2] + (b[2] - a[2]) * e];
    };
    let pos: Vec3;
    if (viaCore) {
      if (k < 0.45) pos = leg(from, mid, k / 0.45);
      else if (k < 0.58) { pos = [mid[0], mid[1] + Math.sin((k - 0.45) / 0.13 * Math.PI) * 0.15, mid[2]]; this.core.flash = 1; }
      else pos = leg(mid, to, (k - 0.58) / 0.42);
    } else {
      pos = leg(from, to, k);
      if (h.from === 'harness' && k < 0.1) this.core.flash = 1;
    }
    pk.node.pos = pos;
    pk.node.rot = [0.3, now * 3, 0.2];
  }

  dispose(): void { this.r.dispose(); }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
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
