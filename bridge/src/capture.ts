// ScreenCaptureKit bridge.
//
// Spawns `bridge/capture/.build/release/swift-grab-capture` and parses its
// framed stdout stream:
//
//   [4-byte BE length][payload]
//
// Payload is either a JPEG (starts with 0xFF 0xD8 0xFF) or a JSON meta
// blob (starts with '{'). JSON messages describe the stream: initial
// `meta` announces dimensions + fps, `resize` fires if the user rotates
// or resizes the simulator window.
//
// This path is ~6x faster than `xcrun simctl io screenshot` in a loop
// because the capture is a persistent WindowServer XPC stream, not a
// process fork per frame. It's the same mechanism Simulator.app itself
// uses to display the sim, and the same one Blitz (blitzdotdev/blitz-mac)
// uses under the hood.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type CaptureMeta = {
  width: number;
  height: number;
  pointWidth?: number;
  pointHeight?: number;
  fps: number;
};

export type CaptureHandle = {
  stop: () => void;
};

export type CaptureOptions = {
  fps?: number;
  quality?: number;
  maxWidth?: number;
};

// Relative to the bridge package root — works both in dev (`bun run src/…`)
// and when the bridge is bundled somewhere else as long as the capture
// binary is shipped alongside it.
export function captureBinaryPath(): string {
  return resolve(import.meta.dir, '..', 'capture', '.build', 'release', 'swift-grab-capture');
}

export function captureAvailable(): boolean {
  return existsSync(captureBinaryPath());
}

export function startCapture(
  opts: CaptureOptions,
  onFrame: (jpeg: Uint8Array) => void,
  onMeta: (meta: CaptureMeta) => void,
  onError: (msg: string) => void,
): CaptureHandle {
  const bin = captureBinaryPath();
  const env: Record<string, string> = {
    ...process.env,
    CAPTURE_FPS: String(opts.fps ?? 50),
    CAPTURE_QUALITY: String(opts.quality ?? 0.7),
    CAPTURE_MAX_WIDTH: String(opts.maxWidth ?? 1200),
  };

  let stopped = false;
  const proc = Bun.spawn([bin], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

  // Drain stderr for human-readable status. The Swift binary logs things
  // like `capture:ready`, `capture:fps 42.1`, and `capture:permission-denied`
  // — surface the interesting ones, swallow the rest.
  (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('capture:permission-denied')) {
          onError('screen recording permission denied — grant it to your terminal or the bridge process in System Settings → Privacy & Security → Screen Recording');
        } else if (line.startsWith('capture:fatal')) {
          onError(line.replace('capture:fatal ', ''));
        } else if (line) {
          console.log('[capture]', line);
        }
        nl = buf.indexOf('\n');
      }
    }
  })().catch(() => { /* process exited */ });

  // Parse framed stdout. This is a state machine because frames can be
  // arbitrarily split across chunk boundaries from the pipe.
  (async () => {
    const reader = proc.stdout.getReader();
    let acc: Uint8Array = new Uint8Array(0);

    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      // Append chunk.
      const merged = new Uint8Array(acc.length + value.length);
      merged.set(acc);
      merged.set(value, acc.length);
      acc = merged;

      // Consume as many complete frames as we can. Avoid copying the
      // JPEG payload — pass a subarray into the callback and slice the
      // leftover in place.
      let pos = 0;
      while (pos + 4 <= acc.length) {
        const len =
          (acc[pos]! << 24) |
          (acc[pos + 1]! << 16) |
          (acc[pos + 2]! << 8) |
          acc[pos + 3]!;
        const total = 4 + (len >>> 0);
        if (pos + total > acc.length) break;
        const payload = acc.subarray(pos + 4, pos + total);
        // Sniff: JSON meta starts with '{', JPEG starts with FF D8 FF.
        if (payload[0] === 0x7b /* '{' */) {
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload)) as
              | { type: 'meta' | 'resize'; width: number; height: number; fps?: number; pointWidth?: number; pointHeight?: number };
            onMeta({
              width: msg.width,
              height: msg.height,
              pointWidth: msg.pointWidth,
              pointHeight: msg.pointHeight,
              fps: msg.fps ?? 0,
            });
          } catch {
            /* ignore malformed meta */
          }
        } else if (payload[0] === 0xff && payload[1] === 0xd8 && payload[2] === 0xff) {
          // Copy so the consumer can retain it past the next read without
          // keeping our accumulator alive.
          const out = new Uint8Array(payload.length);
          out.set(payload);
          onFrame(out);
        }
        pos += total;
      }
      if (pos > 0) acc = acc.slice(pos);
    }
  })().catch((e) => {
    onError(`capture stdout read failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  proc.exited.then((code) => {
    if (stopped) return;
    if (code !== 0) {
      onError(`capture exited with code ${code}`);
    }
  });

  return {
    stop: () => {
      stopped = true;
      try {
        proc.kill('SIGTERM');
      } catch { /* already gone */ }
    },
  };
}
