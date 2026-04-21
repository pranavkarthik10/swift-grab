import type { ServerWebSocket } from 'bun';
import type { BridgeMsg, ClientMsg } from '../../shared/protocol';
import { captureSnapshot } from './ax';
import {
  detectCapabilities,
  idbKey,
  idbSwipe,
  idbTap,
  idbText,
  startScreenshotLoop,
} from './sim';

const PORT = Number(process.env.PORT ?? 7878);
const FRAME_MS = Number(process.env.FRAME_MS ?? 200); // ~5 fps default

let caps = await detectCapabilities();
logCaps(caps);

function logCaps(c: typeof caps) {
  console.log('[bridge] capabilities:', c);
  if (!c.simctl) console.warn('[bridge] xcrun not found — no frames will be produced');
  if (!c.idb)    console.warn('[bridge] idb not found — no AX tree / taps. install: brew install facebook/fb/idb-companion && pipx install fb-idb');
  if (!c.booted) console.warn('[bridge] no booted simulator — boot one with `xcrun simctl boot <udid>`');
}

type WS = ServerWebSocket<unknown>;
const sockets = new Set<WS>();

function send(ws: WS, msg: BridgeMsg) {
  ws.send(JSON.stringify(msg));
}
function broadcast(data: Uint8Array | string) {
  for (const ws of sockets) {
    try { ws.send(data); } catch { /* dropped */ }
  }
}

async function refreshAll() {
  if (!caps.idb) return;
  const snap = await captureSnapshot(caps.deviceId);
  if (!snap) return;
  const payload = JSON.stringify({ type: 'snapshot', data: snap } satisfies BridgeMsg);
  broadcast(payload);
}

// Frame loop (screenshot-based for v1 — swap for SimulatorKit later).
if (caps.simctl) {
  startScreenshotLoop(FRAME_MS, (png) => {
    // Bun's ws.send accepts Uint8Array directly as a binary frame.
    broadcast(png);
  });
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const ok = server.upgrade(req, {});
      if (ok) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true, caps });
    }
    return new Response(
      `sim-bridge v0.1\n\nWebSocket: ws://localhost:${PORT}/ws\nHealth:    http://localhost:${PORT}/health\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
  websocket: {
    async open(ws) {
      sockets.add(ws);
      // Re-detect on every new client so the user never has to restart the
      // bridge after installing idb, booting a sim, etc.
      caps = await detectCapabilities();
      send(ws, {
        type: 'hello',
        version: '0.1.0',
        deviceId: caps.deviceId,
        capabilities: { idb: caps.idb, simctl: caps.simctl, booted: caps.booted },
      });
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
          case 'inspect:refresh': {
            const snap = await captureSnapshot(caps.deviceId);
            if (snap) send(ws, { type: 'snapshot', data: snap });
            break;
          }
          case 'hid:tap':
            if (!caps.idb) throw new Error('idb not installed');
            await idbTap(msg.x, msg.y);
            await refreshAll();
            break;
          case 'hid:swipe':
            if (!caps.idb) throw new Error('idb not installed');
            await idbSwipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs);
            await refreshAll();
            break;
          case 'hid:text':
            if (!caps.idb) throw new Error('idb not installed');
            await idbText(msg.text);
            await refreshAll();
            break;
          case 'hid:key':
            if (!caps.idb) throw new Error('idb not installed');
            await idbKey(msg.key);
            await refreshAll();
            break;
        }
      } catch (e) {
        send(ws, { type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
  },
});

console.log(`[bridge] listening on http://localhost:${server.port} (ws /ws)`);
