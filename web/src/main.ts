import type { AXNode, Snapshot } from '../../shared/protocol';
import { area, bestLabel, hitTest } from './hittest';
import { InspectorOverlay } from './overlay';
import { mockFrameDataUrl, mockSnapshot } from './mock';
import { BridgeClient } from './ws';

// ---------- DOM refs ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const screenEl = $('screen');
const frameImg = $<HTMLImageElement>('frameImg');
const overlayEl = $('overlay');
const overlayBox = $('overlayBox');
const overlayLabel = $('overlayLabel');
const selectionBox = $('selectionBox');
const inspectBtn = $<HTMLButtonElement>('inspectBtn');
const refreshBtn = $<HTMLButtonElement>('refreshBtn');
const homeBtn = $<HTMLButtonElement>('homeBtn');
const transportSel = $<HTMLSelectElement>('transportSel');
const closeSidebarBtn = $<HTMLButtonElement>('closeSidebar');
const openSidebarBtn = $<HTMLButtonElement>('openSidebar');
const selectedEl = $('selected');
const stackEl = $<HTMLOListElement>('stack');
const statusEl = $('status');
const sourceEl = $('source');
const deviceEl = $('device');
const liveDot = document.querySelector<HTMLElement>('.title .dot')!;

const overlay = new InspectorOverlay({
  screen: screenEl,
  frameImg,
  overlay: overlayEl,
  box: overlayBox,
  label: overlayLabel,
  selection: selectionBox,
});

// ---------- state ----------
let snapshot: Snapshot = mockSnapshot;
let inspectMode = true;
let frozen = false;
let selected: AXNode | null = null;
let hovered: AXNode[] = [];

applySnapshot(snapshot);
frameImg.src = mockFrameDataUrl;
setStatus('mock');
setSource('mock');
deviceEl.textContent = snapshot.deviceId;

// ---------- bridge ----------
const wsUrl = `ws://${location.hostname || 'localhost'}:7878/ws`;
let liveFrameUrl: string | null = null;
let hasRealFrames = false;
let hasRealTree = false;
let transportPref: 'auto' | 'capturekit' | 'screenshot' = 'auto';
let lastFrameSource: 'capturekit' | 'screenshot' | 'none' = 'none';
let lastHelloTransport: 'capturekit' | 'screenshot' | 'none' = 'none';
let pointInspectSeq = 0;
let selectedPointInspectSeq = 0;

const bridge = new BridgeClient(wsUrl, {
  onHello: (msg) => {
    deviceEl.textContent = msg.deviceId;
    const { idb, simctl, booted, videoTransport } = msg.capabilities;
    clearMockState();
    if (!booted) setStatus('err', 'no booted simulator');
    else if (!idb && simctl) setStatus('live', 'frames only — install idb for inspector');
    else setStatus('live', videoTransport === 'capturekit' ? 'ScreenCaptureKit 50fps' : videoTransport === 'screenshot' ? 'simctl fallback' : '');
    if (transportPref === 'auto') transportSel.value = 'auto';
    lastHelloTransport = videoTransport;
  },
  onSnapshot: (s) => {
    hasRealTree = true;
    applySnapshot(s);
    setSource(s.source);
  },
  onPointInspect: (msg) => {
    if (msg.requestId !== selectedPointInspectSeq) return;
    const path = mergePath(hitTest(snapshot.nodes, msg.x, msg.y), msg.node);
    const leaf = path.at(-1) ?? null;
    selected = leaf;
    overlay.showSelection(selected);
    renderSelected(selected, path);
    logSelectionForAgent(selected, path);
  },
  onFrame: (blob) => {
    if (!hasRealFrames) console.log('[frame] first frame', blob.size, 'bytes', blob.type);
    hasRealFrames = true;
    if (liveFrameUrl) URL.revokeObjectURL(liveFrameUrl);
    liveFrameUrl = URL.createObjectURL(blob);
    frameImg.src = liveFrameUrl;
  },
  onFrameMeta: (meta) => {
    // ScreenCaptureKit emits real pixel dimensions; use them as the
    // coord space only if the AX tree hasn't already given us one.
    if (!hasRealTree && meta.width > 0 && meta.height > 0) {
      overlay.setSimSize(meta.width, meta.height);
    }
    const note =
      meta.source === 'capturekit' ? `ScreenCaptureKit ${meta.fps}fps` :
      meta.source === 'screenshot' ? 'simctl fallback' :
      '';
    if (note) setStatus('live', note);

    lastFrameSource = meta.source;
    overlay.setFrameMeta(meta.width, meta.height, meta.source);
  },
  onStatus: (s) => {
    if (s === 'live') liveDot.classList.add('live');
    else if (s === 'error' || s === 'closed') {
      liveDot.classList.remove('live');
      hasRealFrames = false;
      hasRealTree = false;
      setStatus('mock');
      applySnapshot(mockSnapshot);
      frameImg.src = mockFrameDataUrl;
      setSource('mock');
    } else {
      setStatus('connecting');
    }
  },
  onError: (m) => console.warn('[bridge]', m),
});

// When the first real frame arrives, use its natural dimensions as the
// sim coordinate space if we don't yet have an AX-tree-derived simSize.
frameImg.addEventListener('load', () => {
  if (!hasRealTree && hasRealFrames && frameImg.naturalWidth > 0) {
    overlay.setSimSize(frameImg.naturalWidth, frameImg.naturalHeight);
  }
  if (frameImg.naturalWidth > 0 && frameImg.naturalHeight > 0) {
    overlay.setFrameMeta(frameImg.naturalWidth, frameImg.naturalHeight, lastFrameSource);
  }
});

function clearMockState() {
  // When connected to a real bridge, wipe mock nodes so hit-test doesn't
  // draw phantom overlays on top of real sim frames.
  snapshot = { ...mockSnapshot, nodes: [], source: 'none' };
  clearSelection();
  hovered = [];
  overlay.showHover(null);
  setSource('none');
}

bridge.connect();

function clearSelection() {
  selected = null;
  overlay.showSelection(null);
  renderSelected(null, []);
}

function requestPointInspect(p: { x: number; y: number }) {
  const requestId = ++pointInspectSeq;
  selectedPointInspectSeq = requestId;
  bridge.send({ type: 'inspect:point', x: p.x, y: p.y, requestId });
}

function mergePath(path: AXNode[], pointNode: AXNode | null): AXNode[] {
  if (!pointNode) return path;
  if (path.some((n) => sameNode(n, pointNode))) return path;
  return [...path, pointNode].sort((a, b) => area(b.frame) - area(a.frame));
}

function sameNode(a: AXNode, b: AXNode): boolean {
  return (
    a.id === b.id ||
    (
      a.role === b.role &&
      a.label === b.label &&
      a.frame.x === b.frame.x &&
      a.frame.y === b.frame.y &&
      a.frame.w === b.frame.w &&
      a.frame.h === b.frame.h
    )
  );
}

// ---------- inspect interactions ----------
setInspectMode(true);

screenEl.addEventListener('mousemove', (e) => {
  if (!inspectMode || frozen) return;
  const p = overlay.hitPoint(e);
  if (!p) {
    hovered = [];
    overlay.showHover(null);
    return;
  }
  hovered = hitTest(snapshot.nodes, p.x, p.y);
  const deepest = hovered.at(-1) ?? null;
  overlay.showHover(deepest);
  renderSelectedPreview(deepest, hovered);
});

screenEl.addEventListener('mouseleave', () => {
  if (frozen) return;
  hovered = [];
  overlay.showHover(null);
  if (!selected) renderSelectedPreview(null, []);
});

screenEl.addEventListener('click', (e) => {
  const p = overlay.hitPoint(e);
  if (!p) return;
  if (inspectMode) {
    const path = hitTest(snapshot.nodes, p.x, p.y);
    const next = path.at(-1) ?? null;
    if (!next) {
      clearSelection();
      return;
    }
    if (selected && sameNode(selected, next)) {
      clearSelection();
      return;
    }
    selected = next;
    overlay.showSelection(selected);
    renderSelected(selected, path);
    logSelectionForAgent(selected, path);
    requestPointInspect(p);
  } else {
    // passthrough tap → sim
    bridge.send({ type: 'hid:tap', x: p.x, y: p.y });
  }
});

// ---------- wheel → swipe (scroll passthrough) ----------
// Mouse wheel / trackpad scroll over the sim maps to `idb ui swipe`.
// idb swipes are blocking (~150ms per call) so we coalesce deltas into
// a single swipe fired after a short idle window. Not buttery-smooth
// like native scroll but good enough for navigating lists.
let wheelAccumY = 0;
let wheelStart: { x: number; y: number } | null = null;
let wheelTimer: number | null = null;

screenEl.addEventListener('wheel', (e) => {
  if (inspectMode) return;
  e.preventDefault();
  const p = overlay.hitPoint(e);
  if (!p) return;
  if (!wheelStart) wheelStart = p;
  wheelAccumY += e.deltaY;
  if (wheelTimer != null) window.clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => {
    const start = wheelStart!;
    const delta = Math.max(-400, Math.min(400, wheelAccumY));
    const duration = Math.max(100, Math.min(500, Math.abs(delta) * 1.2));
    bridge.send({
      type: 'hid:swipe',
      x1: start.x, y1: start.y,
      x2: start.x, y2: start.y - delta,
      durationMs: duration,
    });
    wheelAccumY = 0;
    wheelStart = null;
    wheelTimer = null;
  }, 70);
}, { passive: false });

// ---------- mouse drag → swipe ----------
// In interaction mode, dragging on the sim creates a swipe.
// (No modifier keys; avoids relying on trackpad gestures.)
let dragStartClient: { x: number; y: number } | null = null;
let dragStartSim: { x: number; y: number } | null = null;
let dragging = false;

screenEl.addEventListener('mousedown', (e) => {
  if (inspectMode) return;
  // Only left mouse button.
  if (e.button !== 0) return;
  const p = overlay.hitPointClient(e.clientX, e.clientY);
  if (!p) return;
  dragStartClient = { x: e.clientX, y: e.clientY };
  dragStartSim = p;
  dragging = false;
});

window.addEventListener('mousemove', (e) => {
  if (inspectMode) return;
  if (!dragStartClient || !dragStartSim) return;
  const dx = e.clientX - dragStartClient.x;
  const dy = e.clientY - dragStartClient.y;
  if (!dragging) {
    if (Math.hypot(dx, dy) >= 8) dragging = true;
    else return;
  }
  // Prevent text selection / accidental drags while swiping.
  e.preventDefault?.();
});

window.addEventListener('mouseup', (e) => {
  if (inspectMode) { dragStartClient = null; dragStartSim = null; dragging = false; return; }
  if (!dragStartClient || !dragStartSim) return;
  const end = overlay.hitPointClient(e.clientX, e.clientY);
  const start = dragStartSim;
  dragStartClient = null;
  dragStartSim = null;
  const wasDragging = dragging;
  dragging = false;
  if (!end) return;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (!wasDragging || dist < 12) return;
  const duration = Math.max(120, Math.min(650, dist * 1.1));
  bridge.send({
    type: 'hid:swipe',
    x1: start.x, y1: start.y,
    x2: end.x, y2: end.y,
    durationMs: duration,
  });
});

// Cmd / Ctrl to freeze hover (so you can drag over to the sidebar)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') frozen = true;
  if ((e.key === 'I' || e.key === 'i') && e.shiftKey) {
    const nowHidden = !document.body.classList.contains('sidebar-hidden');
    userOverride = nowHidden ? 'closed' : 'open';
    applySidebarState();
    e.preventDefault();
    return;
  }
  if (e.key === 'i' || e.key === 'I') {
    setInspectMode(!inspectMode);
    e.preventDefault();
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    bridge.send({ type: 'inspect:refresh' });
    e.preventDefault();
    return;
  }
  if (e.key === 'h' || e.key === 'H') {
    bridge.send({ type: 'hid:key', key: 'home' });
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') clearSelection();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') frozen = false;
});
window.addEventListener('blur', () => { frozen = false; });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') frozen = false;
});

inspectBtn.addEventListener('click', () => setInspectMode(!inspectMode));
refreshBtn.addEventListener('click', () => bridge.send({ type: 'inspect:refresh' }));
homeBtn.addEventListener('click', () => bridge.send({ type: 'hid:key', key: 'home' }));
transportSel.addEventListener('change', () => {
  const v = transportSel.value as typeof transportPref;
  transportPref = v;
  if (v === 'auto') return;
  bridge.send({ type: 'video:transport', transport: v });
});

// ---------- sidebar visibility ----------
const AUTO_NARROW_PX = 760;
let userOverride: 'open' | 'closed' | null = null;

function applySidebarState() {
  const narrow = window.innerWidth < AUTO_NARROW_PX;
  const shouldHide =
    userOverride === 'closed' ||
    (userOverride === null && narrow);
  document.body.classList.toggle('sidebar-hidden', shouldHide);
  document.body.classList.toggle('auto-narrow', shouldHide && userOverride === null);
}

closeSidebarBtn.addEventListener('click', () => { userOverride = 'closed'; applySidebarState(); });
openSidebarBtn.addEventListener('click',  () => { userOverride = 'open';   applySidebarState(); });
window.addEventListener('resize', () => {
  const narrow = window.innerWidth < AUTO_NARROW_PX;
  if (userOverride === 'closed' && !narrow) userOverride = null;
  if (userOverride === 'open'   && narrow)  userOverride = null;
  applySidebarState();
});
applySidebarState();

// ---------- rendering ----------

function applySnapshot(s: Snapshot) {
  snapshot = s;
  overlay.setSimSize(s.simSize.w, s.simSize.h);
  if (selected) {
    const still = s.nodes.find(n => n.id === selected!.id) ?? null;
    if (!still) {
      clearSelection();
      return;
    }
    selected = still;
    overlay.showSelection(selected);
    renderSelected(selected, [still]);
  }
}

function setInspectMode(on: boolean) {
  inspectMode = on;
  inspectBtn.setAttribute('aria-pressed', String(on));
  screenEl.classList.toggle('inspect', on);
  if (!on) {
    hovered = [];
    overlay.showHover(null);
    clearSelection();
  }

  // In AUTO mode: use simctl frames for inspect (accurate AX mapping),
  // and CaptureKit for interaction (fast, low-latency).
  if (transportPref === 'auto') {
    const want = on ? 'screenshot' : 'capturekit';
    // Only send if it would be a change (avoid spamming).
    if (lastHelloTransport !== want) {
      bridge.send({ type: 'video:transport', transport: want });
      lastHelloTransport = want;
    }
  }
}

function setStatus(kind: 'connecting' | 'live' | 'mock' | 'err', note?: string) {
  statusEl.className = `status ${kind}`;
  const base =
    kind === 'live' ? 'connected' :
    kind === 'mock' ? 'mock mode — bridge offline' :
    kind === 'err'  ? 'error' :
                      'connecting…';
  statusEl.textContent = note ? `${base} · ${note}` : base;
}
function setSource(src: Snapshot['source']) { sourceEl.textContent = `tree: ${src}`; }

function renderSelectedPreview(node: AXNode | null, path: AXNode[]) {
  if (!selected) renderSelected(node, path);
}

function renderSelected(node: AXNode | null, path: AXNode[]) {
  if (!node) {
    selectedEl.classList.add('empty');
    selectedEl.textContent = 'hover any element';
    stackEl.innerHTML = '<li class="empty">—</li>';
    return;
  }
  selectedEl.classList.remove('empty');

  const bl = bestLabel(node);
  const labelHtml =
    bl.kind === 'label' ? ` <span class="lbl">“${escapeHtml(bl.text)}”</span>`
    : bl.kind === 'role' ? ` <span class="role">${escapeHtml(bl.text)}</span>`
    : bl.kind === 'id'   ? ` <span class="dim">#${escapeHtml(bl.text)}</span>`
    : '';
  const extraId =
    bl.kind !== 'id' && node.identifier
      ? ` <span class="dim">#${escapeHtml(node.identifier)}</span>` : '';
  const metaBits = [
    node.value
      ? `<div class="meta"><span class="dim">value:</span> <code>${escapeHtml(node.value)}</code></div>`
      : '',
    node.subrole
      ? `<div class="meta"><span class="dim">subrole:</span> <code>${escapeHtml(node.subrole)}</code></div>`
      : '',
    node.help
      ? `<div class="meta"><span class="dim">help:</span> <code>${escapeHtml(node.help)}</code></div>`
      : '',
    node.customActions.length
      ? `<div class="meta"><span class="dim">actions:</span> <code>${escapeHtml(node.customActions.join(', '))}</code></div>`
      : '',
    node.contentRequired
      ? `<div class="meta"><span class="dim">content required</span></div>`
      : '',
  ].filter(Boolean).join('');

  selectedEl.innerHTML = `
    <div><span class="tag">&lt;${escapeHtml(node.type)} /&gt;</span>${labelHtml}${extraId}</div>
    <div class="meta">
      <span>${Math.round(node.frame.w)}×${Math.round(node.frame.h)}</span>
      <span>@ ${Math.round(node.frame.x)}, ${Math.round(node.frame.y)}</span>
      <span class="dim">${escapeHtml(node.role)}</span>
    </div>
    ${metaBits}
  `;

  stackEl.innerHTML = '';
  path.forEach((n, i) => {
    const li = document.createElement('li');
    if (i === path.length - 1) li.className = 'deepest';
    const bl = bestLabel(n);
    const labelHtml =
      bl.kind === 'label' ? ` <span class="lbl">“${escapeHtml(bl.text)}”</span>`
      : bl.kind === 'role' ? ` <span class="role">${escapeHtml(bl.text)}</span>`
      : bl.kind === 'id'   ? ` <span class="dim">#${escapeHtml(bl.text)}</span>`
      : '';
    li.innerHTML = `
      <span class="tag">&lt;${escapeHtml(n.type)} /&gt;</span>${labelHtml}
      <span class="coord">${Math.round(n.frame.w)}×${Math.round(n.frame.h)}</span>
    `;
    li.addEventListener('mouseenter', () => overlay.showHover(n));
    li.addEventListener('click', () => {
      if (selected && sameNode(selected, n)) {
        clearSelection();
        return;
      }
      selected = n;
      overlay.showSelection(n);
      renderSelected(n, path.slice(0, i + 1));
    });
    stackEl.appendChild(li);
  });
}

function logSelectionForAgent(node: AXNode | null, path: AXNode[]) {
  if (!node) return;
  const payload = {
    type: node.type,
    role: node.role,
    label: node.label,
    identifier: node.identifier,
    subrole: node.subrole,
    help: node.help,
    customActions: node.customActions,
    frame: node.frame,
    ancestors: path.slice(0, -1).map(n => ({
      type: n.type, label: n.label, identifier: n.identifier, subrole: n.subrole,
    })),
  };
  console.log('[selected]', payload);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;'  :
    c === '>' ? '&gt;'  :
    c === '"' ? '&quot;': '&#39;'
  );
}
