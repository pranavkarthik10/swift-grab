import type { AXNode, Snapshot } from '../../shared/protocol';

// `idb ui describe-all --json` returns a flat array of AX elements for the
// currently focused app. Each element has a frame in device-pixel coords,
// a role, and (optionally) a label/value/identifier.
type RawAX = {
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | null;
  frame: { x: number; y: number; width: number; height: number };
  role: string;
  role_description?: string;
  type?: string;
  title?: string | null;
  enabled?: boolean;
};

export async function captureSnapshot(deviceId: string): Promise<Snapshot | null> {
  try {
    const p = Bun.spawn(['idb', 'ui', 'describe-all', '--json'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const txt = await new Response(p.stdout).text();
    await p.exited;
    if (p.exitCode !== 0) return null;
    const raw = JSON.parse(txt) as RawAX[];
    return normalize(raw, deviceId);
  } catch {
    return null;
  }
}

function normalize(raw: RawAX[], deviceId: string): Snapshot {
  const nodes: AXNode[] = raw.map((r, i) => ({
    id: r.AXUniqueId || `n${i}`,
    type: prettyType(r),
    role: r.role,
    roleDescription: r.role_description ?? null,
    label: r.AXLabel ?? r.title ?? null,
    identifier: r.AXUniqueId ?? null,
    value: r.AXValue ?? null,
    frame: {
      x: r.frame.x,
      y: r.frame.y,
      w: r.frame.width,
      h: r.frame.height,
    },
    enabled: r.enabled ?? true,
  }));
  const bbox = nodes.reduce(
    (acc, n) => ({
      w: Math.max(acc.w, n.frame.x + n.frame.w),
      h: Math.max(acc.h, n.frame.y + n.frame.h),
    }),
    { w: 0, h: 0 },
  );
  return {
    deviceId,
    simSize: bbox,
    nodes,
    capturedAt: Date.now(),
    source: 'idb',
  };
}

function prettyType(r: RawAX): string {
  if (r.type) return r.type;
  const role = r.role.replace(/^AX/, '');
  // Small readability tweaks to match SwiftUI / UIKit naming.
  if (role === 'StaticText') return 'Text';
  if (role === 'Group') return 'View';
  return role;
}
