import type { ServerWebSocket } from 'bun';
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
// CAPTURE=0 → skip ScreenCaptureKit and go straight to simctl screenshots.
// Useful when the user hasn't granted Screen Recording permission yet.
const CAPTURE_DISABLE = process.env.CAPTURE === '0';

let caps = await detectCapabilities();
const hasCaptureBin = captureAvailable();
const captureCap = !CAPTURE_DISABLE && hasCaptureBin && caps.simctl && caps.booted;
logCaps(caps, captureCap, hasCaptureBin);

function logCaps(c: typeof caps, cap: boolean, binPresent: boolean) {
  console.log('[bridge] capabilities:', { ...c, capturekit: cap });
  if (!c.simctl) console.warn('[bridge] xcrun not found — no frames will be produced');
  if (!c.idb)    console.warn('[bridge] idb not found — no AX tree / taps');
  if (!c.booted) console.warn('[bridge] no booted simulator — boot one with `xcrun simctl boot <udid>`');
  if (!binPresent) console.warn('[bridge] capture binary not built — run `cd bridge/capture && swift build -c release`');
}

type WS = ServerWebSocket<unknown>;
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

// ---------- snapshot refresh (async + deduped) ----------

let refreshInFlight: Promise<void> | null = null;
let refreshPending = false;

async function refreshAll(): Promise<void> {
  if (!caps.idb) return;
  if (refreshInFlight) { refreshPending = true; return refreshInFlight; }
  refreshInFlight = (async () => {
    try {
      const snap = await captureSnapshot(caps.deviceId);
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

function startCaptureKit() {
  if (!captureCap) return false;
  console.log(`[bridge] starting ScreenCaptureKit @ ${CAPTURE_FPS}fps q=${CAPTURE_QUALITY} maxW=${CAPTURE_MAX_WIDTH}`);
  const handle = startCapture(
    { fps: CAPTURE_FPS, quality: CAPTURE_QUALITY, maxWidth: CAPTURE_MAX_WIDTH },
    (jpeg) => broadcastBinary(BIN_TAG_IMAGE, jpeg),
    (meta) => {
      activeTransport = 'capturekit';
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
      console.warn('[bridge] capture error:', err);
      capture?.stop();
      capture = null;
      activeTransport = 'none';
      lastMeta = null;
      startScreenshots();
    },
  );
  capture = handle;
  // pulseFrames is a no-op under SCK — frames stream at 50fps already
  pulseFrames = () => {};
  return true;
}

function stopCapture() {
  capture?.stop();
  capture = null;
  if (activeTransport === 'capturekit') {
    activeTransport = 'none';
    lastMeta = null;
  }
}

function startScreenshots() {
  if (!caps.simctl || screenshotLoop) return;
  console.log(`[bridge] starting ${FRAME_FORMAT} screenshot loop @ ${FRAME_MS}ms`);
  const loop = startScreenshotLoop(
    FRAME_MS,
    (buf) => broadcastBinary(BIN_TAG_IMAGE, buf),
    FRAME_FORMAT,
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

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const ok = server.upgrade(req, {});
      if (ok) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        caps,
        videoTransport: videoTransport(),
      });
    }
    return new Response(
      `swift-grab bridge\n\nWebSocket: ws://localhost:${PORT}/ws\nHealth:    http://localhost:${PORT}/health\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
  websocket: {
    async open(ws) {
      sockets.add(ws);
      // Re-detect on every new client so the user never has to restart
      // the bridge after installing idb, booting a sim, etc.
      caps = await detectCapabilities();
      send(ws, {
        type: 'hello',
        version: '0.3.0',
        deviceId: caps.deviceId,
        capabilities: {
          idb: caps.idb,
          simctl: caps.simctl,
          booted: caps.booted,
          capturekit: activeTransport === 'capturekit',
          videoTransport: videoTransport(),
        },
      });
      if (lastMeta) send(ws, lastMeta);
      if (caps.idb) {
        const snap = await captureSnapshot(caps.deviceId);
        if (snap) send(ws, { type: 'snapshot', data: snap });
      }
    },
    close(ws) { sockets.delete(ws); },
    async message(ws, raw) {
      if (typeof raw !== 'string') return;
      let msg: ClientMsg;
      try { msg = JSON.parse(raw) as ClientMsg; } catch { return; }
      try {
        switch (msg.type) {
          case 'video:transport':
            switchTransport(msg.transport);
            break;
          case 'inspect:refresh': {
            const snap = await captureSnapshot(caps.deviceId);
            if (snap) send(ws, { type: 'snapshot', data: snap });
            break;
          }
          case 'inspect:point': {
            if (!caps.idb) throw new Error('idb not installed');
            const node = await describePoint(msg.x, msg.y);
            send(ws, { type: 'inspect:point', requestId: msg.requestId, x: msg.x, y: msg.y, node });
            break;
          }
          case 'hid:tap':
            if (!caps.idb) throw new Error('idb not installed');
            await idbTap(msg.x, msg.y);
            pulseFrames();
            void refreshAll();
            break;
          case 'hid:swipe':
            if (!caps.idb) throw new Error('idb not installed');
            await idbSwipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs);
            pulseFrames();
            void refreshAll();
            break;
          case 'hid:text':
            if (!caps.idb) throw new Error('idb not installed');
            await idbText(msg.text);
            pulseFrames();
            void refreshAll();
            break;
          case 'hid:key':
            if (!caps.idb) throw new Error('idb not installed');
            await idbKey(msg.key);
            pulseFrames();
            void refreshAll();
            break;
        }
      } catch (e) {
        send(ws, { type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
  },
});

process.on('SIGINT',  () => { stopCapture(); stopScreenshots(); process.exit(0); });
process.on('SIGTERM', () => { stopCapture(); stopScreenshots(); process.exit(0); });

console.log(`[bridge] listening on http://localhost:${server.port} (ws /ws)`);

// Start capture AFTER the server is listening so clients can connect
// and we can fall back cleanly if capture never produces frames.
if (captureCap) {
  const started = startCaptureKit();
  if (!started) startScreenshots();
} else if (caps.simctl) {
  startScreenshots();
}
