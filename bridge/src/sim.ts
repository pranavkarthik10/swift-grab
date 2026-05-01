// Thin wrappers around `xcrun simctl` (bundled with Xcode) and `idb`
// (https://fbidb.io). Everything is best-effort: if a tool is missing we
// log once and return null so the bridge can still serve what it has.

import { spawn } from 'node:child_process';
const IDB_CONNECT_TIMEOUT_MS = 3_000;
const IDB_UI_TIMEOUT_MS = 4_000;

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type SimDevice = {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  lastBootedAt: string | null;
};

async function which(cmd: string): Promise<boolean> {
  try {
    const res = await runCommandWithTimeout(['which', cmd], 1_000);
    return res.exitCode === 0;
  } catch { return false; }
}

export type Capabilities = {
  idb: boolean;
  simctl: boolean;
  booted: boolean;
  deviceId: string;
  udid: string | null;
  devices: SimDevice[];
};

export async function detectCapabilities(preferredUdid?: string | null): Promise<Capabilities> {
  const [idb, simctl] = await Promise.all([which('idb'), which('xcrun')]);
  let booted = false;
  let deviceId = 'booted';
  let udid: string | null = null;
  let devices: SimDevice[] = [];
  if (simctl) {
    try {
      const res = await runCommandWithTimeout(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], 3_000);
      const txt = res.stdout;
      if (res.exitCode !== 0) throw new Error(res.stderr || `exit ${res.exitCode}`);
      const json = JSON.parse(txt) as {
        devices: Record<string, Array<{ udid: string; state: string; name: string; lastBootedAt?: string }>>;
      };
      devices = Object.entries(json.devices)
        .flatMap(([runtime, devs]) => devs
          .filter((d) => d.state === 'Booted')
          .map((d) => ({
            udid: d.udid,
            name: d.name,
            state: d.state,
            runtime,
            lastBootedAt: d.lastBootedAt ?? null,
          })))
        .sort((a, b) => (b.lastBootedAt ?? '').localeCompare(a.lastBootedAt ?? ''));
      const selected = devices.find((d) => d.udid === preferredUdid) ?? devices[0] ?? null;
      if (selected) {
        booted = true;
        udid = selected.udid;
        deviceId = `${selected.name} (${selected.udid.slice(0, 8)}…)`;
      }
    } catch { /* ignore */ }
  }
  // idb needs an explicit connect the first time a companion spawns; calling
  // it on an already-connected target is a cheap no-op, so we always do it.
  // BUT: if the idb companion is wedged (seen this several times after
  // killing `idb video-stream`), `idb connect` hangs forever and takes the
  // whole bridge down. Race it against a 3s deadline and move on.
  if (idb && booted && udid) await ensureIdbConnected(udid);
  return { idb, simctl, booted, deviceId, udid, devices };
}

export async function ensureIdbConnected(udid: string | null, force = false): Promise<void> {
  if (!udid) return;
  if (force) {
    await runIdbConnectCommand(['idb', 'disconnect', udid]);
    await killIdbCompanion(udid);
  }
  await runIdbConnectCommand(['idb', 'connect', udid]);
}

async function runIdbConnectCommand(argv: string[]): Promise<void> {
  await runCommandWithTimeout(argv, IDB_CONNECT_TIMEOUT_MS);
}

async function killIdbCompanion(udid: string): Promise<void> {
  try {
    await runCommandWithTimeout(['pkill', '-f', `idb_companion --udid ${udid}`], 1_000);
  } catch {
    // Best-effort cleanup. `pkill` exits non-zero when nothing matched.
  }
}

export type FrameFormat = 'jpeg' | 'png';

/**
 * Capture a screenshot of the booted simulator as raw bytes. JPEG is ~30%
 * faster to encode than PNG on simctl and the byte payload is 5-10x smaller,
 * so it's the default for the stream. PNG stays available for anything
 * that needs lossless (e.g. pixel-diff-based frame invalidation later).
 */
export async function screenshot(format: FrameFormat = 'jpeg', udid?: string | null): Promise<Uint8Array | null> {
  try {
    const target = udid ?? 'booted';
    const res = await runCommandBuffer(['xcrun', 'simctl', 'io', target, 'screenshot', `--type=${format}`, '-']);
    if (res.exitCode !== 0 || res.stdout.byteLength === 0) return null;
    return new Uint8Array(res.stdout);
  } catch { return null; }
}

/**
 * simctl screenshots cap around 4-5 fps because the encode takes ~200ms
 * regardless of how fast we call. The loop runs as tight as it can and
 * only sleeps if a capture finishes quickly. `pulse()` is exposed so
 * HID handlers can request an out-of-band frame immediately after a tap
 * without waiting for the next loop tick.
 */
export function startScreenshotLoop(
  intervalMs: number,
  onFrame: (data: Uint8Array) => void,
  format: FrameFormat = 'jpeg',
  udid?: string | null,
): { stop: () => void; pulse: () => void } {
  let stopped = false;
  let wake: (() => void) | null = null;
  (async () => {
    while (!stopped) {
      const t0 = Date.now();
      const buf = await screenshot(format, udid);
      if (buf) onFrame(buf);
      const dt = Date.now() - t0;
      const wait = Math.max(0, intervalMs - dt);
      if (wait > 0) await new Promise<void>(r => {
        wake = () => { wake = null; r(); };
        setTimeout(() => { if (wake) { wake = null; r(); } }, wait);
      });
    }
  })();
  return {
    stop: () => { stopped = true; },
    pulse: () => { wake?.(); },
  };
}

// ---------- HID (requires idb) ----------

export async function idbTap(x: number, y: number, udid?: string | null): Promise<void> {
  await run(withUdid(['idb', 'ui', 'tap'], udid, [String(Math.round(x)), String(Math.round(y))]), udid);
}

export async function idbSwipe(
  x1: number, y1: number, x2: number, y2: number, durationMs = 200, udid?: string | null,
): Promise<void> {
  await run(withUdid([
    'idb', 'ui', 'swipe',
    '--duration', String(Math.max(0.05, durationMs / 1000)),
  ], udid, [
    String(Math.round(x1)), String(Math.round(y1)),
    String(Math.round(x2)), String(Math.round(y2)),
  ]), udid);
}

export async function idbText(text: string, udid?: string | null): Promise<void> {
  await run(withUdid(['idb', 'ui', 'text'], udid, [text]), udid);
}

export async function idbKey(key: 'home' | 'lock' | 'volumeUp' | 'volumeDown', udid?: string | null): Promise<void> {
  const map = { home: 'HOME', lock: 'LOCK', volumeUp: 'VOLUME_UP', volumeDown: 'VOLUME_DOWN' } as const;
  await run(withUdid(['idb', 'ui', 'button'], udid, [map[key]]), udid);
}

function withUdid(prefix: string[], udid: string | null | undefined, suffix: string[]): string[] {
  return udid ? [...prefix, '--udid', udid, ...suffix] : [...prefix, ...suffix];
}

async function run(argv: string[], udid?: string | null, retried = false): Promise<void> {
  const res = await runCommandWithTimeout(argv, IDB_UI_TIMEOUT_MS);
  if (res.exitCode !== 0 || res.timedOut) {
    const err = res.stderr.trim() || (res.timedOut ? `timed out after ${IDB_UI_TIMEOUT_MS}ms` : `exit ${res.exitCode}`);
    if (!retried && shouldReconnectIdb(err)) {
      await ensureIdbConnected(udid ?? null, true);
      return run(argv, udid, true);
    }
    throw new Error(`${argv[0]} ${argv[1] ?? ''} failed: ${err}`);
  }
}

export async function runCommandWithTimeout(argv: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: err.message, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          exitCode: null,
          stdout: '',
          stderr: `timed out after ${timeoutMs}ms`,
          timedOut: true,
        });
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut: false,
      });
    });
  });
}

async function runCommandBuffer(argv: string[]): Promise<{ exitCode: number | null; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout: Buffer[] = [];
    let settled = false;
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, stdout: Buffer.alloc(0) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, stdout: Buffer.concat(stdout) });
    });
  });
}

function shouldReconnectIdb(err: string): boolean {
  return /Connection refused|Failed to connect to companion|companion.*sock|not connected|not booted|timed out/i.test(err);
}
