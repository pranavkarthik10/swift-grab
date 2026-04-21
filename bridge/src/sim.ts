// Thin wrappers around `xcrun simctl` (bundled with Xcode) and `idb`
// (https://fbidb.io). Everything is best-effort: if a tool is missing we
// log once and return null so the bridge can still serve what it has.

const enc = new TextEncoder();

async function which(cmd: string): Promise<boolean> {
  try {
    const p = Bun.spawn(['which', cmd], { stdout: 'pipe', stderr: 'ignore' });
    await p.exited;
    return p.exitCode === 0;
  } catch { return false; }
}

export type Capabilities = {
  idb: boolean;
  simctl: boolean;
  booted: boolean;
  deviceId: string;
  udid: string | null;
};

export async function detectCapabilities(): Promise<Capabilities> {
  const [idb, simctl] = await Promise.all([which('idb'), which('xcrun')]);
  let booted = false;
  let deviceId = 'booted';
  let udid: string | null = null;
  if (simctl) {
    try {
      const p = Bun.spawn(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'], {
        stdout: 'pipe', stderr: 'ignore',
      });
      const txt = await new Response(p.stdout).text();
      await p.exited;
      const json = JSON.parse(txt) as { devices: Record<string, Array<{ udid: string; state: string; name: string }>> };
      for (const devs of Object.values(json.devices)) {
        const b = devs.find(d => d.state === 'Booted');
        if (b) {
          booted = true;
          udid = b.udid;
          deviceId = `${b.name} (${b.udid.slice(0, 8)}…)`;
          break;
        }
      }
    } catch { /* ignore */ }
  }
  // idb needs an explicit connect the first time a companion spawns; calling
  // it on an already-connected target is a cheap no-op, so we always do it.
  // BUT: if the idb companion is wedged (seen this several times after
  // killing `idb video-stream`), `idb connect` hangs forever and takes the
  // whole bridge down. Race it against a 3s deadline and move on.
  if (idb && booted && udid) {
    const p = Bun.spawn(['idb', 'connect', udid], { stdout: 'pipe', stderr: 'pipe' });
    const deadline = new Promise<void>((res) => setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
      res();
    }, 3000));
    await Promise.race([p.exited.then(() => {}), deadline]);
  }
  return { idb, simctl, booted, deviceId, udid };
}

export type FrameFormat = 'jpeg' | 'png';

/**
 * Capture a screenshot of the booted simulator as raw bytes. JPEG is ~30%
 * faster to encode than PNG on simctl and the byte payload is 5-10x smaller,
 * so it's the default for the stream. PNG stays available for anything
 * that needs lossless (e.g. pixel-diff-based frame invalidation later).
 */
export async function screenshot(format: FrameFormat = 'jpeg'): Promise<Uint8Array | null> {
  try {
    const p = Bun.spawn(['xcrun', 'simctl', 'io', 'booted', 'screenshot', `--type=${format}`, '-'], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const buf = await new Response(p.stdout).arrayBuffer();
    await p.exited;
    if (p.exitCode !== 0 || buf.byteLength === 0) return null;
    return new Uint8Array(buf);
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
): { stop: () => void; pulse: () => void } {
  let stopped = false;
  let wake: (() => void) | null = null;
  (async () => {
    while (!stopped) {
      const t0 = Date.now();
      const buf = await screenshot(format);
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

export async function idbTap(x: number, y: number): Promise<void> {
  await run(['idb', 'ui', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

export async function idbSwipe(
  x1: number, y1: number, x2: number, y2: number, durationMs = 200,
): Promise<void> {
  await run([
    'idb', 'ui', 'swipe',
    '--duration', String(Math.max(0.05, durationMs / 1000)),
    String(Math.round(x1)), String(Math.round(y1)),
    String(Math.round(x2)), String(Math.round(y2)),
  ]);
}

export async function idbText(text: string): Promise<void> {
  await run(['idb', 'ui', 'text', text]);
}

export async function idbKey(key: 'home' | 'lock' | 'volumeUp' | 'volumeDown'): Promise<void> {
  const map = { home: 'HOME', lock: 'LOCK', volumeUp: 'VOLUME_UP', volumeDown: 'VOLUME_DOWN' } as const;
  await run(['idb', 'ui', 'button', map[key]]);
}

async function run(argv: string[]): Promise<void> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  await p.exited;
  if (p.exitCode !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(`${argv[0]} ${argv[1] ?? ''} failed: ${err.trim() || `exit ${p.exitCode}`}`);
  }
}

// silence the TS unused warning from `enc` — reserved for future ws helpers
void enc;
