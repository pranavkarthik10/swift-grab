import { createServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type BridgeMsg,
  type ClientMsg,
  type VideoTransport,
  BIN_TAG_IMAGE,
} from '../../shared/protocol';
import { captureSnapshot, describePoint } from './ax';
import {
  detectCapabilities,
  idbKey,
  idbSwipe,
  idbTap,
  idbText,
  startScreenshotLoop,
} from './sim';
import { captureAvailable, startCapture, type CaptureHandle } from './capture';

const PORT = Number(process.env.PORT ?? 7878);
const FRAME_MS = Number(process.env.FRAME_MS ?? 120); // simctl fallback cadence
const FRAME_FORMAT = (process.env.FRAME_FORMAT === 'png' ? 'png' : 'jpeg') as 'jpeg' | 'png';
const CAPTURE_FPS = Number(process.env.CAPTURE_FPS ?? 50);
const CAPTURE_QUALITY = Number(process.env.CAPTURE_QUALITY ?? 0.7);
const CAPTURE_MAX_WIDTH = Number(process.env.CAPTURE_MAX_WIDTH ?? 1200);
const CAPTURE_RESTART_LIMIT = Number(process.env.CAPTURE_RESTART_LIMIT ?? 6);
const CAPTURE_RESTART_WINDOW_MS = Number(process.env.CAPTURE_RESTART_WINDOW_MS ?? 30_000);
const CAPTURE_RESTART_DELAY_MS = Number(process.env.CAPTURE_RESTART_DELAY_MS ?? 650);
// CAPTURE=0 → skip ScreenCaptureKit and go straight to simctl screenshots.
// Useful when the user hasn't granted Screen Recording permission yet.
const CAPTURE_DISABLE = process.env.CAPTURE === '0';

let selectedUdid: string | null = null;
let caps = await detectCapabilities(selectedUdid);
selectedUdid = caps.udid;
const hasCaptureBin = captureAvailable();
logCaps(caps, canUseCaptureKit(), hasCaptureBin);

function canUseCaptureKit() {
  return !CAPTURE_DISABLE && hasCaptureBin && caps.simctl && caps.booted;
}

function logCaps(c: typeof caps, cap: boolean, binPresent: boolean) {
  console.log('[bridge] capabilities:', { ...c, capturekit: cap });
  if (!c.simctl) console.warn('[bridge] xcrun not found — no frames will be produced');
  if (!c.idb)    console.warn('[bridge] idb not found — no AX tree / taps');
  if (!c.booted) console.warn('[bridge] no booted simulator — boot one with `xcrun simctl boot <udid>`');
  if (!binPresent) console.warn('[bridge] capture binary not built — run `cd bridge/capture && swift build -c release`');
}

type WS = WebSocket;
const sockets = new Set<WS>();

function send(ws: WS, msg: BridgeMsg) {
  ws.send(JSON.stringify(msg));
}
function sendBinary(ws: WS, tag: number, data: Uint8Array) {
  const out = new Uint8Array(data.length + 1);
  out[0] = tag;
  out.set(data, 1);
  ws.send(out);
}
function broadcastJson(msg: BridgeMsg) {
  const s = JSON.stringify(msg);
  for (const ws of sockets) { try { ws.send(s); } catch { /* dropped */ } }
}
function broadcastBinary(tag: number, data: Uint8Array) {
  for (const ws of sockets) { try { sendBinary(ws, tag, data); } catch { /* dropped */ } }
}

function hello(): BridgeMsg {
  return {
    type: 'hello',
    version: '0.1.1',
    deviceId: caps.deviceId,
    capabilities: {
      idb: caps.idb,
      simctl: caps.simctl,
      booted: caps.booted,
      devices: caps.devices,
      selectedUdid: caps.udid,
      capturekit: canUseCaptureKit(),
      videoTransport: videoTransport(),
    },
  };
}

// ---------- snapshot refresh (async + deduped) ----------

let refreshInFlight: Promise<void> | null = null;
let refreshPending = false;

async function refreshAll(): Promise<void> {
  if (!caps.idb || !caps.booted) return;
  if (refreshInFlight) { refreshPending = true; return refreshInFlight; }
  refreshInFlight = (async () => {
    try {
      const snap = await captureSnapshot(caps.deviceId, caps.udid);
      if (snap) broadcastJson({ type: 'snapshot', data: snap });
    } finally {
      refreshInFlight = null;
      if (refreshPending) { refreshPending = false; void refreshAll(); }
    }
  })();
  return refreshInFlight;
}

// ---------- frame producer: ScreenCaptureKit first, simctl fallback ----------

let capture: CaptureHandle | null = null;
let screenshotLoop: { stop: () => void; pulse: () => void } | null = null;
let pulseFrames: () => void = () => {};
let activeTransport: VideoTransport = 'none';
let lastMeta: BridgeMsg | null = null;
let captureRestartTimer: ReturnType<typeof setTimeout> | null = null;
let captureRestartTimes: number[] = [];
let captureSessionId = 0;

function videoTransport(): VideoTransport {
  return activeTransport;
}

function switchTransport(to: VideoTransport) {
  stopCapture();
  stopScreenshots();
  if (to === 'capturekit') {
    const started = startCaptureKit();
    if (!started) startScreenshots();
    return;
  }
  if (to === 'screenshot') {
    startScreenshots();
  }
}

function ensureVideoRunning() {
  if (activeTransport !== 'none' || !caps.booted) return;
  if (!startCaptureKit()) startScreenshots();
}

function startCaptureKit() {
  if (!canUseCaptureKit()) return false;
  const sessionId = ++captureSessionId;
  if (captureRestartTimer) {
    clearTimeout(captureRestartTimer);
    captureRestartTimer = null;
  }
  console.log(`[bridge] starting ScreenCaptureKit @ ${CAPTURE_FPS}fps q=${CAPTURE_QUALITY} maxW=${CAPTURE_MAX_WIDTH}`);
  const handle = startCapture(
    { fps: CAPTURE_FPS, quality: CAPTURE_QUALITY, maxWidth: CAPTURE_MAX_WIDTH },
    (jpeg) => broadcastBinary(BIN_TAG_IMAGE, jpeg),
    (meta) => {
      activeTransport = 'capturekit';
      captureRestartTimes = [];
      const msg: BridgeMsg = {
        type: 'frame:meta',
        width: meta.width,
        height: meta.height,
        fps: meta.fps || CAPTURE_FPS,
        source: 'capturekit',
      };
      lastMeta = msg;
      broadcastJson(msg);
    },
    (err) => {
      if (sessionId !== captureSessionId) return;
      console.warn('[bridge] capture error:', err);
      capture?.stop();
      capture = null;
      activeTransport = 'none';
      lastMeta = null;
      if (shouldRestartCapture(err)) {
        scheduleCaptureRestart(err);
        return;
      }
      startScreenshots();
    },
  );
  capture = handle;
  activeTransport = 'capturekit';
  // pulseFrames is a no-op under SCK — frames stream at 50fps already
  pulseFrames = () => {};
  return true;
}

function stopCapture() {
  captureSessionId++;
  if (captureRestartTimer) {
    clearTimeout(captureRestartTimer);
    captureRestartTimer = null;
  }
  capture?.stop();
  capture = null;
  if (activeTransport === 'capturekit') {
    activeTransport = 'none';
    lastMeta = null;
  }
}

function shouldRestartCapture(err: string): boolean {
  if (/permission denied/i.test(err)) return false;

  const now = Date.now();
  captureRestartTimes = captureRestartTimes.filter((t) => now - t < CAPTURE_RESTART_WINDOW_MS);
  if (captureRestartTimes.length >= CAPTURE_RESTART_LIMIT) {
    console.warn('[bridge] capture restart limit reached; falling back to screenshots');
    return false;
  }
  captureRestartTimes.push(now);
  return true;
}

function scheduleCaptureRestart(reason: string) {
  if (captureRestartTimer) return;
  console.log(`[bridge] restarting ScreenCaptureKit after stream stop: ${reason}`);
  captureRestartTimer = setTimeout(() => {
    captureRestartTimer = null;
    if (!caps.booted || activeTransport !== 'none') return;
    if (!startCaptureKit()) startScreenshots();
  }, CAPTURE_RESTART_DELAY_MS);
}

function startScreenshots() {
  if (!caps.simctl || !caps.booted || screenshotLoop) return;
  console.log(`[bridge] starting ${FRAME_FORMAT} screenshot loop @ ${FRAME_MS}ms for ${caps.udid ?? 'booted'}`);
  const loop = startScreenshotLoop(
    FRAME_MS,
    (buf) => broadcastBinary(BIN_TAG_IMAGE, buf),
    FRAME_FORMAT,
    caps.udid,
  );
  screenshotLoop = loop;
  pulseFrames = loop.pulse;
  activeTransport = 'screenshot';
  lastMeta = {
    type: 'frame:meta',
    width: 0, height: 0,
    fps: Math.round(1000 / FRAME_MS),
    source: 'screenshot',
  };
  broadcastJson(lastMeta);
}

function stopScreenshots() {
  screenshotLoop?.stop();
  screenshotLoop = null;
  if (activeTransport === 'screenshot') {
    activeTransport = 'none';
    lastMeta = null;
  }
}

// ---------- HTTP + WebSocket server ----------

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        ok: true,
        caps,
        videoTransport: videoTransport(),
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
      `sim-grab bridge\n\nWebSocket: ws://localhost:${PORT}/ws\nHealth:    http://localhost:${PORT}/health\n`,
  );
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.on('close', () => { sockets.delete(ws); });
  ws.on('message', (raw) => {
    void handleMessage(ws, raw);
  });
  void sendHello(ws);
});

async function sendHello(ws: WS) {
  // Re-detect on every new client so the user never has to restart
  // the bridge after installing idb, booting a sim, etc.
  caps = await detectCapabilities(selectedUdid);
  selectedUdid = caps.udid;
  ensureVideoRunning();
  send(ws, hello());
  if (lastMeta) send(ws, lastMeta);
  if (caps.idb && caps.booted) {
    const snap = await captureSnapshot(caps.deviceId, caps.udid);
    if (snap) send(ws, { type: 'snapshot', data: snap });
  }
}

async function handleMessage(ws: WS, raw: RawData) {
  const text = typeof raw === 'string' ? raw : raw.toString();
  let msg: ClientMsg;
  try { msg = JSON.parse(text) as ClientMsg; } catch { return; }
  try {
    switch (msg.type) {
      case 'video:transport':
        switchTransport(msg.transport);
        break;
      case 'device:select':
        selectedUdid = msg.udid;
        caps = await detectCapabilities(selectedUdid);
        selectedUdid = caps.udid;
        switchTransport(activeTransport === 'capturekit' ? 'capturekit' : 'screenshot');
        ensureVideoRunning();
        broadcastJson(hello());
        void refreshAll();
        break;
      case 'inspect:refresh': {
        if (!caps.booted) throw new Error('no booted simulator');
        const snap = await captureSnapshot(caps.deviceId, caps.udid);
        if (snap) send(ws, { type: 'snapshot', data: snap });
        break;
      }
      case 'inspect:point': {
        if (!caps.booted) throw new Error('no booted simulator');
        if (!caps.idb) throw new Error('idb not installed');
        const node = await describePoint(msg.x, msg.y, caps.udid);
        send(ws, { type: 'inspect:point', requestId: msg.requestId, x: msg.x, y: msg.y, node });
        break;
      }
      case 'hid:tap':
        if (!caps.booted) throw new Error('no booted simulator');
        if (!caps.idb) throw new Error('idb not installed');
        await idbTap(msg.x, msg.y, caps.udid);
        pulseFrames();
        void refreshAll();
        break;
      case 'hid:swipe':
        if (!caps.booted) throw new Error('no booted simulator');
        if (!caps.idb) throw new Error('idb not installed');
        await idbSwipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs, caps.udid);
        pulseFrames();
        void refreshAll();
        break;
      case 'hid:text':
        if (!caps.booted) throw new Error('no booted simulator');
        if (!caps.idb) throw new Error('idb not installed');
        await idbText(msg.text, caps.udid);
        pulseFrames();
        void refreshAll();
        break;
      case 'hid:key':
        if (!caps.booted) throw new Error('no booted simulator');
        if (!caps.idb) throw new Error('idb not installed');
        await idbKey(msg.key, caps.udid);
        pulseFrames();
        void refreshAll();
        break;
    }
  } catch (e) {
    send(ws, { type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

process.on('SIGINT',  () => { stopCapture(); stopScreenshots(); wss.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { stopCapture(); stopScreenshots(); wss.close(); server.close(); process.exit(0); });

await new Promise<void>((resolveListen) => {
  server.listen(PORT, '127.0.0.1', resolveListen);
});

console.log(`[bridge] listening on http://localhost:${PORT} (ws /ws)`);

// Start capture AFTER the server is listening so clients can connect
// and we can fall back cleanly if capture never produces frames.
if (canUseCaptureKit()) {
  const started = startCaptureKit();
  if (!started) startScreenshots();
} else if (caps.simctl && caps.booted) {
  startScreenshots();
}
