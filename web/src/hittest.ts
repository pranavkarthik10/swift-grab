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

/**
 * Returns the best available human-readable label for a node. Falls back
 * to roleDescription (e.g. "Nav bar", "scroll view"), then AXUniqueId,
 * when a visible AXLabel isn't set. Useful for SwiftUI views where the
 * toolbar / container doesn't have a direct text label.
 */
export function bestLabel(n: AXNode): { text: string; kind: 'label' | 'role' | 'id' | 'none' } {
  if (n.label && n.label.trim()) return { text: n.label, kind: 'label' };
  if (n.roleDescription && n.roleDescription.trim())
    return { text: n.roleDescription, kind: 'role' };
  if (n.identifier && n.identifier.trim())
    return { text: n.identifier, kind: 'id' };
  return { text: '', kind: 'none' };
}
