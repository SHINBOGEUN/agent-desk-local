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
  const k = Math.sqrt(area / n) * 0.75;
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
      move.x += (cx - point.x) * 0.02 * k / 10;
      move.y += (cy - point.y) * 0.02 * k / 10;
      const length = Math.hypot(move.x, move.y) || 1;
      const limited = Math.min(length, temperature);
      point.x = Math.min(width - margin, Math.max(margin, point.x + (move.x / length) * limited));
      point.y = Math.min(height - margin, Math.max(margin, point.y + (move.y / length) * limited));
    }
    temperature = Math.max(0.5, temperature * 0.97);
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
