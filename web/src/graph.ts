// Layout for the notes graph: a small force simulation (Fruchterman-Reingold), deterministic so the
// picture does not jump between renders. Pure functions, no DOM, so they are tested like the rest of model.ts.

export interface GraphNodeIn { id: string; links: number }
export interface GraphEdgeIn { from: string; to: string }
export interface Point { x: number; y: number }

/** Stable pseudo-random number in [0, 1) from a string, for starting positions. */
export function hashUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Positions for the nodes inside width x height (with a margin). Linked nodes pull together, all nodes push
 * apart, a weak pull keeps loose ones near the centre. Same input, same output.
 */
export function layoutGraph(nodes: readonly GraphNodeIn[], edges: readonly GraphEdgeIn[], options: { width: number; height: number; iterations?: number; margin?: number }): Map<string, Point> {
  const { width, height } = options;
  const margin = options.margin ?? 24;
  const positions = new Map<string, Point>();
  const n = nodes.length;
  if (!n) return positions;
  const cx = width / 2;
  const cy = height / 2;
  nodes.forEach((node, index) => {
    const angle = (index / n) * Math.PI * 2 + hashUnit(node.id) * 0.5;
    const radius = Math.min(width, height) * 0.35 * (0.4 + 0.6 * hashUnit(`${node.id}#r`));
    positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  });
  if (n === 1) { positions.set(nodes[0]!.id, { x: cx, y: cy }); return positions; }
  const area = (width - margin * 2) * (height - margin * 2);
  const k = Math.sqrt(area / n) * 0.8;
  const iterations = options.iterations ?? 220;
  let temperature = Math.min(width, height) / 8;
  const ids = nodes.map(node => node.id);
  const links = edges.filter(edge => positions.has(edge.from) && positions.has(edge.to) && edge.from !== edge.to);
  for (let step = 0; step < iterations; step++) {
    const shift = new Map<string, Point>(ids.map(id => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i++) {
      const a = positions.get(ids[i]!)!;
      for (let j = i + 1; j < n; j++) {
        const b = positions.get(ids[j]!)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) { dx = hashUnit(ids[i]! + ids[j]!) - 0.5; dy = 0.5 - hashUnit(ids[j]! + ids[i]!); distance = Math.hypot(dx, dy) || 0.01; }
        const force = (k * k) / distance;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const sa = shift.get(ids[i]!)!; sa.x += fx; sa.y += fy;
        const sb = shift.get(ids[j]!)!; sb.x -= fx; sb.y -= fy;
      }
    }
    for (const edge of links) {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const force = (distance * distance) / k;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      const sa = shift.get(edge.from)!; sa.x -= fx; sa.y -= fy;
      const sb = shift.get(edge.to)!; sb.x += fx; sb.y += fy;
    }
    for (const id of ids) {
      const point = positions.get(id)!;
      const move = shift.get(id)!;
      // Gravity grows with distance, so notes without links stay near the rest instead of drifting to a corner.
      move.x += (cx - point.x) * 0.15;
      move.y += (cy - point.y) * 0.15;
      const length = Math.hypot(move.x, move.y) || 1;
      const limited = Math.min(length, temperature);
      point.x += (move.x / length) * limited;
      point.y += (move.y / length) * limited;
    }
    temperature = Math.max(0.5, temperature * 0.97);
  }
  // The simulation runs unbounded (clamping piles nodes on the edges); the result is then scaled into the box.
  // Notes without links float far out; the box is fitted to the linked ones and the rest are kept at its edge.
  const linked = new Set(links.flatMap(edge => [edge.from, edge.to]));
  const fitted = [...positions.entries()].filter(([id]) => linked.size === 0 || linked.has(id)).map(([, point]) => point);
  const xs = fitted.map(point => point.x);
  const ys = fitted.map(point => point.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // One scale for both axes (no stretching) and never enlarged, so a few loose pairs stay together in the middle.
  const sx = maxX - minX > 1 ? (width - margin * 2) / (maxX - minX) : Infinity;
  const sy = maxY - minY > 1 ? (height - margin * 2) / (maxY - minY) : Infinity;
  const scale = Math.min(sx, sy, 1);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  for (const point of positions.values()) {
    point.x = Math.min(width - margin, Math.max(margin, cx + (point.x - midX) * scale));
    point.y = Math.min(height - margin, Math.max(margin, cy + (point.y - midY) * scale));
  }
  return positions;
}

/** Ids directly linked to `id` (both directions). */
export function neighbours(id: string, edges: readonly GraphEdgeIn[]): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) { if (edge.from === id) out.add(edge.to); if (edge.to === id) out.add(edge.from); }
  return out;
}

/** Inserts `[[target]]` at the cursor (replacing a selection) and returns the new text and cursor position. */
export function insertLink(text: string, start: number, end: number, target: string): { text: string; cursor: number } {
  const link = `[[${target}]]`;
  const before = text.slice(0, Math.max(0, start));
  const after = text.slice(Math.max(start, end));
  return { text: `${before}${link}${after}`, cursor: before.length + link.length };
}

export interface Point3 { x: number; y: number; z: number }

/**
 * The same force simulation in three dimensions, for the rotating view. Positions are centred on the origin and
 * scaled so the linked notes fit in a sphere of radius 1 (notes without links sit just outside it).
 */
export function layoutGraph3D(nodes: readonly GraphNodeIn[], edges: readonly GraphEdgeIn[], options: { iterations?: number } = {}): Map<string, Point3> {
  const positions = new Map<string, Point3>();
  const n = nodes.length;
  if (!n) return positions;
  const spread = Math.cbrt(n);
  for (const node of nodes) {
    const theta = hashUnit(node.id) * Math.PI * 2;
    const phi = Math.acos(2 * hashUnit(`${node.id}#p`) - 1);
    const radius = spread * (0.3 + 0.7 * hashUnit(`${node.id}#r`));
    positions.set(node.id, { x: radius * Math.sin(phi) * Math.cos(theta), y: radius * Math.cos(phi), z: radius * Math.sin(phi) * Math.sin(theta) });
  }
  if (n === 1) { positions.set(nodes[0]!.id, { x: 0, y: 0, z: 0 }); return positions; }
  const ids = nodes.map(node => node.id);
  const links = edges.filter(edge => positions.has(edge.from) && positions.has(edge.to) && edge.from !== edge.to);
  let temperature = spread / 2;
  for (let step = 0; step < (options.iterations ?? 200); step++) {
    const shift = new Map<string, Point3>(ids.map(id => [id, { x: 0, y: 0, z: 0 }]));
    for (let i = 0; i < n; i++) {
      const a = positions.get(ids[i]!)!;
      for (let j = i + 1; j < n; j++) {
        const b = positions.get(ids[j]!)!;
        const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z;
        const distance = Math.hypot(dx, dy, dz) || 0.01;
        const force = 1 / distance;
        const sa = shift.get(ids[i]!)!; const sb = shift.get(ids[j]!)!;
        sa.x += (dx / distance) * force; sa.y += (dy / distance) * force; sa.z += (dz / distance) * force;
        sb.x -= (dx / distance) * force; sb.y -= (dy / distance) * force; sb.z -= (dz / distance) * force;
      }
    }
    for (const edge of links) {
      const a = positions.get(edge.from)!; const b = positions.get(edge.to)!;
      const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z;
      const distance = Math.hypot(dx, dy, dz) || 0.01;
      const force = distance * distance;
      const sa = shift.get(edge.from)!; const sb = shift.get(edge.to)!;
      sa.x -= (dx / distance) * force; sa.y -= (dy / distance) * force; sa.z -= (dz / distance) * force;
      sb.x += (dx / distance) * force; sb.y += (dy / distance) * force; sb.z += (dz / distance) * force;
    }
    for (const id of ids) {
      const point = positions.get(id)!;
      const move = shift.get(id)!;
      move.x -= point.x * 0.05; move.y -= point.y * 0.05; move.z -= point.z * 0.05;
      const length = Math.hypot(move.x, move.y, move.z) || 1;
      const limited = Math.min(length, temperature);
      point.x += (move.x / length) * limited; point.y += (move.y / length) * limited; point.z += (move.z / length) * limited;
    }
    temperature = Math.max(0.01, temperature * 0.97);
  }
  const linked = new Set(links.flatMap(edge => [edge.from, edge.to]));
  const fitted = [...positions.entries()].filter(([id]) => linked.size === 0 || linked.has(id)).map(([, point]) => point);
  const centre = { x: avg(fitted.map(p => p.x)), y: avg(fitted.map(p => p.y)), z: avg(fitted.map(p => p.z)) };
  const reach = Math.max(...fitted.map(p => Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z)), 0.001);
  for (const [id, point] of positions) {
    point.x = (point.x - centre.x) / reach; point.y = (point.y - centre.y) / reach; point.z = (point.z - centre.z) / reach;
    const radius = Math.hypot(point.x, point.y, point.z);
    if (!linked.has(id) && linked.size && radius > 1.15) { point.x *= 1.15 / radius; point.y *= 1.15 / radius; point.z *= 1.15 / radius; }
  }
  return positions;
}

const avg = (values: number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/** Rotates by yaw (around the vertical axis) and pitch, then projects with perspective. depth: 0 far .. 1 near. */
export function project3D(point: Point3, yaw: number, pitch: number): { x: number; y: number; scale: number; depth: number } {
  const cosY = Math.cos(yaw); const sinY = Math.sin(yaw);
  const x1 = point.x * cosY + point.z * sinY;
  const z1 = -point.x * sinY + point.z * cosY;
  const cosP = Math.cos(pitch); const sinP = Math.sin(pitch);
  const y2 = point.y * cosP - z1 * sinP;
  const z2 = point.y * sinP + z1 * cosP;
  const camera = 3.2;
  const scale = camera / (camera - z2);
  return { x: x1 * scale, y: y2 * scale, scale, depth: Math.min(1, Math.max(0, (z2 + 1.2) / 2.4)) };
}
