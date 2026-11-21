// A small WebGL renderer for the agent room: meshes built from primitives, a node tree, one sun, one point light,
// hemisphere ambient, rim light, emissive and textured (canvas) materials, and transparent passes.
// No dependencies, so the dashboard needs no extra install and the room can be checked in a headless browser.

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

// ---------- matrices (column-major, like WebGL) ----------

export const identity = (): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };

export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = identity();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  return m;
}

/** Translation * rotY * rotX * rotZ * uniform scale. */
export function compose(pos: Vec3, rot: Vec3, scale: number): Mat4 {
  const [rx, ry, rz] = rot;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Ry * Rx * Rz
  const m00 = cy * cz + sy * sx * sz, m01 = -cy * sz + sy * sx * cz, m02 = sy * cx;
  const m10 = cx * sz, m11 = cx * cz, m12 = -sx;
  const m20 = -sy * cz + cy * sx * sz, m21 = sy * sz + cy * sx * cz, m22 = cy * cx;
  const m = new Float32Array(16);
  m[0] = m00 * scale; m[1] = m10 * scale; m[2] = m20 * scale;
  m[4] = m01 * scale; m[5] = m11 * scale; m[6] = m21 * scale;
  m[8] = m02 * scale; m[9] = m12 * scale; m[10] = m22 * scale;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  return m;
}

export const transformPoint = (m: Mat4, p: Vec3): Vec3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

// ---------- geometry: interleaved position(3) normal(3) uv(2), plain triangles ----------

type Geo = number[];
const push = (g: Geo, p: Vec3, n: Vec3, u: number, v: number): void => { g.push(p[0], p[1], p[2], n[0], n[1], n[2], u, v); };

export function box(w: number, h: number, d: number): Float32Array {
  const g: Geo = [];
  const x = w / 2, y = h / 2, z = d / 2;
  const face = (n: Vec3, corners: Vec3[]): void => {
    const [a, b, c, e] = corners as [Vec3, Vec3, Vec3, Vec3];
    push(g, a, n, 0, 0); push(g, b, n, 1, 0); push(g, c, n, 1, 1);
    push(g, a, n, 0, 0); push(g, c, n, 1, 1); push(g, e, n, 0, 1);
  };
  face([0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]);
  face([0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]);
  face([1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]]);
  face([-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]]);
  face([0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]]);
  face([0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]]);
  return new Float32Array(g);
}

/** A sphere, or the top part of one when `thetaMax` < PI (a dome for a hat). Centred on the origin. */
export function sphere(r: number, seg = 24, rings = 16, thetaMax = Math.PI, yOffset = 0): Float32Array {
  const g: Geo = [];
  const at = (i: number, j: number): [Vec3, Vec3, number, number] => {
    const theta = (j / rings) * thetaMax, phi = (i / seg) * Math.PI * 2;
    const n: Vec3 = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
    return [[n[0] * r, n[1] * r + yOffset, n[2] * r], n, i / seg, j / rings];
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      for (const q of [a, d, c, a, c, b]) push(g, q[0], q[1], q[2], q[3]);
    }
  }
  return new Float32Array(g);
}

/** A cylinder along y, centred on the origin. */
export function cylinder(rTop: number, rBottom: number, h: number, seg = 24, caps = true): Float32Array {
  const g: Geo = [];
  const slope = (rBottom - rTop) / h;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const n0 = normalize([Math.sin(a0), slope, Math.cos(a0)]), n1 = normalize([Math.sin(a1), slope, Math.cos(a1)]);
    const b0: Vec3 = [Math.sin(a0) * rBottom, -h / 2, Math.cos(a0) * rBottom], b1: Vec3 = [Math.sin(a1) * rBottom, -h / 2, Math.cos(a1) * rBottom];
    const t0: Vec3 = [Math.sin(a0) * rTop, h / 2, Math.cos(a0) * rTop], t1: Vec3 = [Math.sin(a1) * rTop, h / 2, Math.cos(a1) * rTop];
    push(g, b0, n0, i / seg, 0); push(g, b1, n1, (i + 1) / seg, 0); push(g, t1, n1, (i + 1) / seg, 1);
    push(g, b0, n0, i / seg, 0); push(g, t1, n1, (i + 1) / seg, 1); push(g, t0, n0, i / seg, 1);
    if (caps) {
      push(g, [0, h / 2, 0], [0, 1, 0], 0.5, 0.5); push(g, t0, [0, 1, 0], 0, 0); push(g, t1, [0, 1, 0], 1, 0);
      push(g, [0, -h / 2, 0], [0, -1, 0], 0.5, 0.5); push(g, b1, [0, -1, 0], 1, 0); push(g, b0, [0, -1, 0], 0, 0);
    }
  }
  return new Float32Array(g);
}

/** A capsule along y: a cylinder of height h with round ends, centred on the origin. */
export function capsule(r: number, h: number, seg = 20): Float32Array {
  const top = sphere(r, seg, 8, Math.PI / 2, h / 2);
  const bottom = Array.from(sphere(r, seg, 8, Math.PI / 2, h / 2));
  for (let i = 0; i < bottom.length; i += 8) { bottom[i + 1] = -bottom[i + 1]!; bottom[i + 4] = -bottom[i + 4]!; }
  // flip winding of the mirrored half
  for (let i = 0; i < bottom.length; i += 24) {
    for (let k = 0; k < 8; k++) { const tmp = bottom[i + 8 + k]!; bottom[i + 8 + k] = bottom[i + 16 + k]!; bottom[i + 16 + k] = tmp; }
  }
  const side = cylinder(r, r, h, seg, false);
  return new Float32Array([...top, ...bottom, ...side]);
}

/** A ring lying in the XZ plane. */
export function torus(R: number, r: number, seg = 36, tube = 10, arc = Math.PI * 2): Float32Array {
  const g: Geo = [];
  const at = (i: number, j: number): [Vec3, Vec3] => {
    const u = (i / seg) * arc, v = (j / tube) * Math.PI * 2;
    const n: Vec3 = [Math.cos(v) * Math.sin(u), Math.sin(v), Math.cos(v) * Math.cos(u)];
    return [[(R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.cos(u)], n];
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < tube; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      for (const q of [a, b, c, a, c, d]) push(g, q[0], q[1], 0, 0);
    }
  }
  return new Float32Array(g);
}

/** A flat rectangle facing +z (for screens), uv (0,0) bottom-left. */
export function quad(w: number, h: number): Float32Array {
  const x = w / 2, y = h / 2, n: Vec3 = [0, 0, 1];
  const g: Geo = [];
  push(g, [-x, -y, 0], n, 0, 0); push(g, [x, -y, 0], n, 1, 0); push(g, [x, y, 0], n, 1, 1);
  push(g, [-x, -y, 0], n, 0, 0); push(g, [x, y, 0], n, 1, 1); push(g, [-x, y, 0], n, 0, 1);
  return new Float32Array(g);
}

/** A flat disc facing +y. */
export function disc(r: number, seg = 40): Float32Array {
  const g: Geo = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0: Vec3 = [Math.sin(a0) * r, 0, Math.cos(a0) * r], p1: Vec3 = [Math.sin(a1) * r, 0, Math.cos(a1) * r];
    push(g, [0, 0, 0], [0, 1, 0], 0.5, 0.5); push(g, p0, [0, 1, 0], 0.5 + Math.sin(a0) / 2, 0.5 - Math.cos(a0) / 2); push(g, p1, [0, 1, 0], 0.5 + Math.sin(a1) / 2, 0.5 - Math.cos(a1) / 2);
  }
  return new Float32Array(g);
}

// ---------- scene graph ----------

export interface Material {
  color: Vec3;
  emissive?: Vec3;
  alpha?: number;
  shine?: number;
  unlit?: boolean;
  additive?: boolean;
  texture?: WebGLTexture | null;
}

export interface Mesh { buffer: WebGLBuffer; count: number }

export class Node {
  pos: Vec3 = [0, 0, 0];
  rot: Vec3 = [0, 0, 0];
  scale = 1;
  visible = true;
  children: Node[] = [];
  world: Mat4 = identity();
  mesh: Mesh | null;
  material: Material | null;
  constructor(mesh: Mesh | null = null, material: Material | null = null) { this.mesh = mesh; this.material = material; }
  add(...nodes: Node[]): this { this.children.push(...nodes); return this; }
  at(x: number, y: number, z: number): this { this.pos = [x, y, z]; return this; }
  turn(x: number, y: number, z: number): this { this.rot = [x, y, z]; return this; }
}

export const hex = (value: string): Vec3 => {
  const n = parseInt(value.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// ---------- renderer ----------

const VERTEX = `
attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv;
uniform mat4 uProj; uniform mat4 uView; uniform mat4 uModel;
varying vec3 vN; varying vec3 vW; varying vec2 vUv;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz; vN = (uModel * vec4(aNormal, 0.0)).xyz; vUv = aUv;
  gl_Position = uProj * uView * w;
}`;

const FRAGMENT = `
precision mediump float;
uniform vec3 uColor; uniform vec3 uEmissive; uniform vec3 uEye; uniform vec3 uSun;
uniform vec3 uPointPos; uniform vec3 uPointCol;
uniform float uAlpha; uniform float uShine; uniform float uUnlit; uniform float uUseTex;
uniform sampler2D uTex;
varying vec3 vN; varying vec3 vW; varying vec2 vUv;
void main() {
  vec3 base = uColor; float a = uAlpha;
  if (uUseTex > 0.5) { vec4 t = texture2D(uTex, vUv); base *= t.rgb; a *= t.a; }
  if (uUnlit > 0.5) { gl_FragColor = vec4(base + uEmissive, a); return; }
  vec3 n = normalize(vN); vec3 V = normalize(uEye - vW);
  if (dot(n, V) < 0.0) n = -n;
  float d = max(dot(n, uSun), 0.0);
  vec3 hemi = mix(vec3(0.07, 0.08, 0.11), vec3(0.36, 0.40, 0.52), n.y * 0.5 + 0.5);
  vec3 col = base * (hemi + vec3(1.0, 0.95, 0.88) * d * 0.9);
  vec3 toP = uPointPos - vW; float pd = length(toP);
  col += base * uPointCol * max(dot(n, toP / pd), 0.0) / (1.0 + pd * pd * 0.12);
  vec3 h = normalize(uSun + V);
  col += vec3(1.0) * pow(max(dot(n, h), 0.0), 48.0) * uShine;
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rim * vec3(0.32, 0.42, 0.72) * 0.45;
  col += uEmissive;
  gl_FragColor = vec4(col, a);
}`;

interface Draw { node: Node; depth: number }

export interface Camera { eye: Vec3; target: Vec3; fov: number }

export class Renderer {
  readonly gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private attrib: { pos: number; normal: number; uv: number };
  private meshes = new Map<string, Mesh>();
  private view: Mat4 = identity();
  private proj: Mat4 = identity();
  width = 1;
  height = 1;
  sun: Vec3 = normalize([0.45, 0.9, 0.55]);
  point: { pos: Vec3; color: Vec3 } = { pos: [0, 2, 0], color: [0, 0, 0] };

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    const shader = (type: number, source: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
    this.program = program;
    gl.useProgram(program);
    for (const name of ['uProj', 'uView', 'uModel', 'uColor', 'uEmissive', 'uEye', 'uSun', 'uPointPos', 'uPointCol', 'uAlpha', 'uShine', 'uUnlit', 'uUseTex', 'uTex']) this.loc[name] = gl.getUniformLocation(program, name);
    this.attrib = { pos: gl.getAttribLocation(program, 'aPos'), normal: gl.getAttribLocation(program, 'aNormal'), uv: gl.getAttribLocation(program, 'aUv') };
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  mesh(key: string, build: () => Float32Array): Mesh {
    const cached = this.meshes.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const data = build();
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const mesh = { buffer, count: data.length / 8 };
    this.meshes.set(key, mesh);
    return mesh;
  }

  texture(source: HTMLCanvasElement, existing?: WebGLTexture | null): WebGLTexture {
    const gl = this.gl;
    const tex = existing ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = cssWidth; this.height = cssHeight;
    const w = Math.max(1, Math.round(cssWidth * dpr)), h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** CSS pixel position of a world point, or null when it is behind the camera. */
  project(p: Vec3): { x: number; y: number } | null {
    const v = transformPoint(this.view, p);
    const m = this.proj;
    const cx = m[0]! * v[0] + m[8]! * v[2], cy = m[5]! * v[1] + m[9]! * v[2], cw = -v[2];
    if (cw <= 0.01) return null;
    return { x: (cx / cw * 0.5 + 0.5) * this.width, y: (1 - (cy / cw * 0.5 + 0.5)) * this.height };
  }

  render(root: Node, camera: Camera): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.proj = perspective(camera.fov, this.width / Math.max(1, this.height), 0.1, 100);
    this.view = lookAt(camera.eye, camera.target);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.loc.uProj!, false, this.proj);
    gl.uniformMatrix4fv(this.loc.uView!, false, this.view);
    gl.uniform3fv(this.loc.uEye!, camera.eye);
    gl.uniform3fv(this.loc.uSun!, this.sun);
    gl.uniform3fv(this.loc.uPointPos!, this.point.pos);
    gl.uniform3fv(this.loc.uPointCol!, this.point.color);
    gl.uniform1i(this.loc.uTex!, 0);

    const opaque: Draw[] = [];
    const clear: Draw[] = [];
    const walk = (node: Node, parent: Mat4): void => {
      if (!node.visible) return;
      multiply(parent, compose(node.pos, node.rot, node.scale), node.world);
      if (node.mesh && node.material) {
        const m = node.material;
        const transparent = (m.alpha ?? 1) < 1 || m.additive || !!m.texture;
        const w = node.world;
        const depth = Math.hypot(w[12]! - camera.eye[0], w[13]! - camera.eye[1], w[14]! - camera.eye[2]);
        (transparent ? clear : opaque).push({ node, depth });
      }
      for (const child of node.children) walk(child, node.world);
    };
    walk(root, identity());

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const draw of opaque) this.draw(draw.node);
    clear.sort((a, b) => b.depth - a.depth);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    for (const draw of clear) {
      if (draw.node.material!.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.draw(draw.node);
    }
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  private draw(node: Node): void {
    const gl = this.gl;
    const m = node.material!;
    const mesh = node.mesh!;
    gl.uniformMatrix4fv(this.loc.uModel!, false, node.world);
    gl.uniform3fv(this.loc.uColor!, m.color);
    gl.uniform3fv(this.loc.uEmissive!, m.emissive ?? [0, 0, 0]);
    gl.uniform1f(this.loc.uAlpha!, m.alpha ?? 1);
    gl.uniform1f(this.loc.uShine!, m.shine ?? 0.15);
    gl.uniform1f(this.loc.uUnlit!, m.unlit ? 1 : 0);
    gl.uniform1f(this.loc.uUseTex!, m.texture ? 1 : 0);
    if (m.texture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, m.texture); }
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
    gl.enableVertexAttribArray(this.attrib.pos);
    gl.vertexAttribPointer(this.attrib.pos, 3, gl.FLOAT, false, 32, 0);
    if (this.attrib.normal >= 0) { gl.enableVertexAttribArray(this.attrib.normal); gl.vertexAttribPointer(this.attrib.normal, 3, gl.FLOAT, false, 32, 12); }
    if (this.attrib.uv >= 0) { gl.enableVertexAttribArray(this.attrib.uv); gl.vertexAttribPointer(this.attrib.uv, 2, gl.FLOAT, false, 32, 24); }
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  dispose(): void {
    const gl = this.gl;
    for (const mesh of this.meshes.values()) gl.deleteBuffer(mesh.buffer);
    this.meshes.clear();
    gl.deleteProgram(this.program);
  }
}
