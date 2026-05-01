import type { AXNode, Snapshot } from '../../shared/protocol';
import { area, bestLabel, hitTest } from './hittest';
import { InspectorOverlay } from './overlay';
import { mockFrameDataUrl, mockSnapshot } from './mock';
import { BridgeClient } from './ws';

declare global {
  interface Window {
    __SIM_GRAB_CONFIG__?: {
      bridgePort?: string;
    };
  }
}

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
const copyScreenshotBtn = $<HTMLButtonElement>('copyScreenshotBtn');
const includeScreenshotEl = $<HTMLInputElement>('includeScreenshot');
const deviceSel = $<HTMLSelectElement>('deviceSel');
const transportSel = $<HTMLSelectElement>('transportSel');
const axDomLayer = $('axDomLayer');
const axDomViewport = $('axDomViewport');
const closeSidebarBtn = $<HTMLButtonElement>('closeSidebar');
const openSidebarBtn = $<HTMLButtonElement>('openSidebar');
const floatingCopyScreenshotBtn = $<HTMLButtonElement>('floatingCopyScreenshotBtn');
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
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
const bridgePort = window.__SIM_GRAB_CONFIG__?.bridgePort || viteEnv?.VITE_SIM_GRAB_BRIDGE_PORT || '7878';
const wsUrl = `ws://${location.hostname || 'localhost'}:${bridgePort}/ws`;
let liveFrameUrl: string | null = null;
let hasRealFrames = false;
let hasRealTree = false;
let transportPref: 'auto' | 'capturekit' | 'screenshot' = 'auto';
let lastFrameSource: 'capturekit' | 'screenshot' | 'none' = 'none';
let currentTransport: 'capturekit' | 'screenshot' | 'none' = 'none';
let pointInspectSeq = 0;
let selectedPointInspectSeq = 0;
let lastCopiedContext = '';
let lastAxDomRenderKey = '';

const bridge = new BridgeClient(wsUrl, {
  onHello: (msg) => {
    deviceEl.textContent = msg.deviceId;
    const { idb, simctl, booted, videoTransport } = msg.capabilities;
    renderDeviceOptions(msg.capabilities.devices, msg.capabilities.selectedUdid);
    clearMockState();
    if (!booted) setStatus('err', 'no booted simulator');
    else if (!idb && simctl) setStatus('live', 'frames only — install idb for inspector');
    else setStatus('live', transportStatusNote(videoTransport));
    currentTransport = videoTransport;
    if (transportPref === 'auto') transportSel.value = 'auto';
    updateAutoTransport();
  },
  onSnapshot: (s) => {
    hasRealTree = true;
    applySnapshot(s);
    setSource(s.source);
  },
  onPointInspect: (msg) => {
    if (!inspectMode || msg.requestId !== selectedPointInspectSeq) return;
    const path = mergePath(hitTest(snapshot.nodes, msg.x, msg.y), msg.node);
    const leaf = path.at(-1) ?? null;
    if (!leaf) return;
    selectNode(leaf, path);
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
    const note = transportStatusNote(meta.source, meta.fps);
    if (note) setStatus('live', note);

    lastFrameSource = meta.source;
    currentTransport = meta.source;
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
    renderAxDom();
  }
});
window.addEventListener('resize', () => renderAxDom());

function clearMockState() {
  // When connected to a real bridge, wipe mock nodes so hit-test doesn't
  // draw phantom overlays on top of real sim frames.
  snapshot = { ...mockSnapshot, nodes: [], source: 'none' };
  clearSelection();
  hovered = [];
  axDomViewport.innerHTML = '';
  lastAxDomRenderKey = '';
  overlay.showHover(null);
  setSource('none');
}

bridge.connect();

function clearSelection() {
  selected = null;
  selectedPointInspectSeq = 0;
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

function pathForNode(node: AXNode): AXNode[] {
  const midX = node.frame.x + node.frame.w / 2;
  const midY = node.frame.y + node.frame.h / 2;
  return mergePath(hitTest(snapshot.nodes, midX, midY), node);
}

function selectNode(node: AXNode, path = pathForNode(node)) {
  selected = node;
  overlay.showSelection(node);
  renderSelected(node, path);
  logSelectionForAgent(node, path);
  void copySelectionContext(node, path);
}

function selectOrToggleNode(node: AXNode, path = pathForNode(node)) {
  // Selection should be idempotent. A stale selected node can survive an AX
  // refresh; toggling it off on the next click makes the UI feel like it
  // randomly needs a second click.
  selectNode(node, path);
}

function updateAutoTransport() {
  if (transportPref !== 'auto') return;
  const want = inspectMode ? 'screenshot' : 'capturekit';
  if (currentTransport === want) return;
  currentTransport = want;
  bridge.send({ type: 'video:transport', transport: want });
}

function renderAxDom() {
  if (frameImg.naturalWidth <= 0 || frameImg.naturalHeight <= 0) return;
  const viewport = overlay.getOverlayContentRect();
  const renderKey = [
    snapshot.capturedAt,
    snapshot.nodes.length,
    `${snapshot.simSize.w}x${snapshot.simSize.h}`,
    `${frameImg.naturalWidth}x${frameImg.naturalHeight}`,
    `${Math.round(viewport.x * 10)},${Math.round(viewport.y * 10)},${Math.round(viewport.w * 10)},${Math.round(viewport.h * 10)}`,
  ].join('|');
  if (renderKey === lastAxDomRenderKey) return;
  lastAxDomRenderKey = renderKey;
  axDomViewport.innerHTML = '';
  axDomViewport.style.left = `${viewport.x}px`;
  axDomViewport.style.top = `${viewport.y}px`;
  axDomViewport.style.width = `${viewport.w}px`;
  axDomViewport.style.height = `${viewport.h}px`;
  const nodes = [...snapshot.nodes].sort((a, b) => area(b.frame) - area(a.frame));
  for (const node of nodes) {
    if (node.frame.w <= 0 || node.frame.h <= 0) continue;
    const el = document.createElement('div');
    const label = bestLabel(node);
    const spoken = label.text ? `${node.type} ${label.text}` : node.type;
    const path = pathForNode(node);
    const context = buildSelectionContext(node, path);
    el.className = `ax-dom-node ${node.role === 'AXGroup' ? 'group' : ''}`.trim();
    el.style.left = `${(node.frame.x / snapshot.simSize.w) * 100}%`;
    el.style.top = `${(node.frame.y / snapshot.simSize.h) * 100}%`;
    el.style.width = `${Math.max((node.frame.w / snapshot.simSize.w) * 100, 0.2)}%`;
    el.style.height = `${Math.max((node.frame.h / snapshot.simSize.h) * 100, 0.2)}%`;
    el.style.zIndex = String(Math.max(1, Math.round(1_000_000 - area(node.frame))));
    el.setAttribute('role', domRoleForNode(node));
    el.dataset.axNodeId = node.id;
    el.dataset.axRole = node.role;
    if (node.roleDescription) el.dataset.axRoleDescription = node.roleDescription;
    el.dataset.axType = node.type;
    if (node.label) el.dataset.axLabel = node.label;
    if (node.identifier) el.dataset.axIdentifier = node.identifier;
    if (node.value) el.dataset.axValue = node.value;
    if (node.help) el.dataset.axHelp = node.help;
    if (node.subrole) el.dataset.axSubrole = node.subrole;
    if (node.customActions.length) el.dataset.axCustomActions = node.customActions.join(', ');
    el.dataset.axEnabled = String(node.enabled);
    el.dataset.axContentRequired = String(node.contentRequired);
    el.dataset.axFrame = `${Math.round(node.frame.x)},${Math.round(node.frame.y)},${Math.round(node.frame.w)},${Math.round(node.frame.h)}`;
    el.dataset.agentContext = context;
    el.setAttribute('aria-label', `App UI element for code change: ${spoken}`);
    el.setAttribute('aria-description', context);
    el.title = context;
    el.textContent = spoken;
    el.addEventListener('mousemove', (e) => {
      if (!inspectMode || frozen) return;
      e.stopPropagation();
      previewNode(node, path);
    });
    el.addEventListener('mouseleave', (e) => {
      if (!inspectMode || frozen) return;
      e.stopPropagation();
      hovered = [];
      overlay.showHover(null);
      if (!selected) renderSelectedPreview(null, []);
    });
    el.addEventListener('pointerdown', (e) => {
      if (!inspectMode) return;
      e.preventDefault();
      e.stopPropagation();
      selectOrToggleNode(node, path);
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (inspectMode) {
        e.preventDefault();
        return;
      }
      const p = overlay.hitPoint(e);
      if (p) bridge.send({ type: 'hid:tap', x: p.x, y: p.y });
    });
    axDomViewport.appendChild(el);
  }
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
  previewNode(deepest, hovered);
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
    selectOrToggleNode(next, path);
    if (!selected) return;
    requestPointInspect(p);
  } else {
    // passthrough tap → sim
    bridge.send({ type: 'hid:tap', x: p.x, y: p.y });
  }
});

function previewNode(node: AXNode | null, path: AXNode[]) {
  hovered = path;
  overlay.showHover(node);
  renderSelectedPreview(node, path);
}

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
copyScreenshotBtn.addEventListener('click', () => {
  void copyScreenshot();
});
floatingCopyScreenshotBtn.addEventListener('click', () => {
  void copyScreenshot();
});
deviceSel.addEventListener('change', () => {
  if (!deviceSel.value) return;
  bridge.send({ type: 'device:select', udid: deviceSel.value });
});
transportSel.addEventListener('change', () => {
  const v = transportSel.value as typeof transportPref;
  transportPref = v;
  if (v === 'auto') {
    updateAutoTransport();
    return;
  }
  currentTransport = v;
  bridge.send({ type: 'video:transport', transport: v });
});

function renderDeviceOptions(
  devices: Array<{ udid: string; name: string; runtime: string; lastBootedAt: string | null }>,
  selectedUdid: string | null,
) {
  deviceSel.innerHTML = '';
  if (!devices.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No booted simulator';
    deviceSel.appendChild(opt);
    deviceSel.disabled = true;
    return;
  }
  deviceSel.disabled = false;
  for (const device of devices) {
    const opt = document.createElement('option');
    opt.value = device.udid;
    opt.textContent = `${device.name} (${device.udid.slice(0, 8)})`;
    deviceSel.appendChild(opt);
  }
  deviceSel.value = selectedUdid ?? devices[0]!.udid;
}

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
  renderAxDom();
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

  updateAutoTransport();
  if (on) bridge.send({ type: 'inspect:refresh' });
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

function transportStatusNote(transport: 'capturekit' | 'screenshot' | 'none', fps = 50) {
  if (transport === 'capturekit') return `ScreenCaptureKit ${fps}fps`;
  if (transport === 'screenshot') {
    return transportPref === 'auto' && inspectMode ? 'inspect alignment (simctl)' : 'simctl fallback';
  }
  return '';
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
      selectOrToggleNode(n, path.slice(0, i + 1));
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

async function copySelectionContext(node: AXNode, path: AXNode[]) {
  const text = buildSelectionContext(node, path);
  if (!text || text === lastCopiedContext) return;
  try {
    if (includeScreenshotEl.checked) {
      await writeClipboardWithOptionalScreenshot(text, true);
    } else {
      await copyText(text);
    }
    lastCopiedContext = text;
    console.log(includeScreenshotEl.checked ? '[copied] selection context + screenshot' : '[copied] selection context');
  } catch (err) {
    console.warn('[clipboard] failed to copy selection context', err);
  }
}

async function copyScreenshot() {
  try {
    const blob = await currentScreenshotBlob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type]: blob }),
    ]);
    console.log('[copied] screenshot');
  } catch (err) {
    console.warn('[clipboard] failed to copy screenshot', err);
  }
}

async function writeClipboardWithOptionalScreenshot(text: string, includeScreenshot: boolean) {
  if (!includeScreenshot) {
    await navigator.clipboard.writeText(text);
    return;
  }

  try {
    const blob = await currentScreenshotBlob();
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        [blob.type]: blob,
      }),
    ]);
  } catch (err) {
    console.warn('[clipboard] failed to include screenshot; copying text only', err);
    await copyText(text);
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (err) {
    console.warn('[clipboard] navigator.writeText failed; trying selection fallback', err);
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  textArea.remove();
  if (!copied) throw new Error('Clipboard fallback copy command failed.');
}

async function currentScreenshotBlob(): Promise<Blob> {
  if (!frameImg.complete || frameImg.naturalWidth <= 0 || frameImg.naturalHeight <= 0) {
    throw new Error('No simulator frame is ready to copy.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = frameImg.naturalWidth;
  canvas.height = frameImg.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create screenshot canvas.');
  ctx.drawImage(frameImg, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode screenshot.');
  return blob;
}

function buildSelectionContext(node: AXNode, path: AXNode[]): string {
  const lines = [
    'Use this simulator UI selection as context for changing the app code.',
    'Do not solve this by controlling the simulator. Find and edit the app implementation that renders this UI.',
    `- device: ${snapshot.deviceId}`,
    `- tree source: ${snapshot.source}`,
    `- simulator size: ${Math.round(snapshot.simSize.w)}x${Math.round(snapshot.simSize.h)}`,
    `- selected: ${formatNodeForAgent(node)}`,
  ];
  lines.push(`- enabled: ${node.enabled}`);
  lines.push(`- content required: ${node.contentRequired}`);
  if (node.value) lines.push(`- value: ${node.value}`);
  if (node.identifier) lines.push(`- identifier: ${node.identifier}`);
  if (node.roleDescription) lines.push(`- role description: ${node.roleDescription}`);
  if (node.subrole) lines.push(`- subrole: ${node.subrole}`);
  if (node.help) lines.push(`- help: ${node.help}`);
  if (node.customActions.length) lines.push(`- custom actions: ${node.customActions.join(', ')}`);
  if (path.length > 1) {
    lines.push('- ancestors:');
    for (const ancestor of path.slice(0, -1)) {
      lines.push(`  - ${formatNodeForAgent(ancestor)}`);
    }
  }
  return lines.join('\n');
}

function formatNodeForAgent(node: AXNode): string {
  const label = bestLabel(node);
  const labelBit = label.text ? ` "${label.text}"` : '';
  const idBit = node.identifier ? ` #${node.identifier}` : '';
  const roleDescription = node.roleDescription ? ` (${node.roleDescription})` : '';
  return `<${node.type} />${labelBit}${idBit} ${node.role}${roleDescription} @ ${Math.round(node.frame.x)},${Math.round(node.frame.y)} ${Math.round(node.frame.w)}x${Math.round(node.frame.h)}`;
}

function domRoleForNode(node: AXNode): string {
  if (node.role === 'AXButton') return 'button';
  if (node.role === 'AXLink') return 'link';
  if (node.role === 'AXTextField' || node.role === 'AXTextArea') return 'textbox';
  if (node.role === 'AXImage') return 'img';
  if (node.role === 'AXStaticText') return 'text';
  return 'generic';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;'  :
    c === '>' ? '&gt;'  :
    c === '"' ? '&quot;': '&#39;'
  );
}
