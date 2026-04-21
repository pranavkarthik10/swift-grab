import type { AXNode, Frame } from '../../shared/protocol';

export function area(f: Frame): number {
  return f.w * f.h;
}

export function contains(f: Frame, x: number, y: number): boolean {
  return x >= f.x && y >= f.y && x <= f.x + f.w && y <= f.y + f.h;
}

/**
 * Returns the ancestor chain for a point in sim-pixel coordinates.
 *
 * The AX tree from idb is a flat list, so we reconstruct containment by
 * sorting all rectangles that contain the point by area descending — the
 * largest (outermost) rect comes first, the smallest (deepest leaf) last.
 *
 * Ties broken by list order (stable sort) so repeated hover feels stable.
 */
export function hitTest(nodes: AXNode[], x: number, y: number): AXNode[] {
  const hits: AXNode[] = [];
  for (const n of nodes) if (contains(n.frame, x, y)) hits.push(n);
  hits.sort((a, b) => area(b.frame) - area(a.frame));
  return hits;
}

export function describe(n: AXNode): string {
  const label = n.label ? ` “${n.label}”` : '';
  const w = Math.round(n.frame.w);
  const h = Math.round(n.frame.h);
  return `<${n.type} />${label} — ${w}×${h}`;
}
