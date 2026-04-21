import type { AXNode, Snapshot } from '../../shared/protocol';
import { hitTest } from './hittest';
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
const selectedEl = $('selected');
const stackEl = $<HTMLOListElement>('stack');
const statusEl = $('status');
const sourceEl = $('source');
const deviceEl = $('device');
const liveDot = document.querySelector<HTMLElement>('.title .dot')!;

const overlay = new InspectorOverlay({
  screen: screenEl,
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

const bridge = new BridgeClient(wsUrl, {
  onHello: (msg) => {
    deviceEl.textContent = msg.deviceId;
    const { idb, simctl, booted } = msg.capabilities;
    // Clear stale mock data as soon as we connect to a real bridge — we'll
    // replace it with real frames / real AX, or a clear "unavailable" note.
    clearMockState();
    if (!booted) setStatus('err', 'no booted simulator');
    else if (!idb && simctl) setStatus('live', 'frames only — install idb for inspector');
    else setStatus('live');
  },
  onSnapshot: (s) => {
    hasRealTree = true;
    applySnapshot(s);
    setSource(s.source);
  },
  onFrame: (blob) => {
    hasRealFrames = true;
    if (liveFrameUrl) URL.revokeObjectURL(liveFrameUrl);
    liveFrameUrl = URL.createObjectURL(blob);
    frameImg.src = liveFrameUrl;
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
});

function clearMockState() {
  // When connected to a real bridge, wipe mock nodes so hit-test doesn't
  // draw phantom overlays on top of real sim frames.
  snapshot = { ...mockSnapshot, nodes: [], source: 'none' };
  selected = null;
  hovered = [];
  overlay.showHover(null);
  overlay.showSelection(null);
  renderSelected(null, []);
  setSource('none');
}

bridge.connect();

// ---------- inspect interactions ----------
setInspectMode(true);

screenEl.addEventListener('mousemove', (e) => {
  if (!inspectMode || frozen) return;
  const p = overlay.hitPoint(e);
  if (!p) { hovered = []; overlay.showHover(null); return; }
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
    selected = path.at(-1) ?? null;
    overlay.showSelection(selected);
    renderSelected(selected, path);
    logSelectionForAgent(selected, path);
  } else {
    // passthrough tap → sim
    bridge.send({ type: 'hid:tap', x: p.x, y: p.y });
  }
});

// Cmd / Ctrl to freeze hover (so you can drag over to the sidebar)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') frozen = true;
  if (e.key === 'i' || e.key === 'I') setInspectMode(!inspectMode);
  if (e.key === 'Escape') { selected = null; overlay.showSelection(null); renderSelected(null, []); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') frozen = false;
});

inspectBtn.addEventListener('click', () => setInspectMode(!inspectMode));
refreshBtn.addEventListener('click', () => bridge.send({ type: 'inspect:refresh' }));
homeBtn.addEventListener('click', () => bridge.send({ type: 'hid:key', key: 'home' }));

// ---------- rendering ----------

function applySnapshot(s: Snapshot) {
  snapshot = s;
  overlay.setSimSize(s.simSize.w, s.simSize.h);
  // keep selection if the element still exists, otherwise drop it
  if (selected) {
    const still = s.nodes.find(n => n.id === selected!.id) ?? null;
    selected = still;
    overlay.showSelection(selected);
    renderSelected(selected, still ? [still] : []);
  }
}

function setInspectMode(on: boolean) {
  inspectMode = on;
  inspectBtn.setAttribute('aria-pressed', String(on));
  screenEl.classList.toggle('inspect', on);
  if (!on) overlay.showHover(null);
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
  const label = node.label ? ` <span class="lbl">“${escapeHtml(node.label)}”</span>` : '';
  const id = node.identifier ? ` <span class="dim">#${escapeHtml(node.identifier)}</span>` : '';
  selectedEl.innerHTML = `
    <div><span class="tag">&lt;${escapeHtml(node.type)} /&gt;</span>${label}${id}</div>
    <div class="meta">
      <span>${Math.round(node.frame.w)}×${Math.round(node.frame.h)}</span>
      <span>@ ${Math.round(node.frame.x)}, ${Math.round(node.frame.y)}</span>
      <span class="dim">${escapeHtml(node.role)}</span>
    </div>
  `;

  stackEl.innerHTML = '';
  path.forEach((n, i) => {
    const li = document.createElement('li');
    if (i === path.length - 1) li.className = 'deepest';
    const label = n.label ? ` <span class="lbl">“${escapeHtml(n.label)}”</span>` : '';
    li.innerHTML = `
      <span class="tag">&lt;${escapeHtml(n.type)} /&gt;</span>${label}
      <span class="coord">${Math.round(n.frame.w)}×${Math.round(n.frame.h)}</span>
    `;
    li.addEventListener('mouseenter', () => overlay.showHover(n));
    li.addEventListener('click', () => { selected = n; overlay.showSelection(n); renderSelected(n, path.slice(0, i + 1)); });
    stackEl.appendChild(li);
  });
}

function logSelectionForAgent(node: AXNode | null, path: AXNode[]) {
  if (!node) return;
  // This is the payload a coding agent would receive as context.
  // Intentionally minimal: what was tapped + ancestor chain for grep.
  const payload = {
    type: node.type,
    role: node.role,
    label: node.label,
    identifier: node.identifier,
    frame: node.frame,
    ancestors: path.slice(0, -1).map(n => ({
      type: n.type, label: n.label, identifier: n.identifier,
    })),
  };
  // eslint-disable-next-line no-console
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
