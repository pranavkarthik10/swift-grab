// Types shared between the bridge (Bun) and the web inspector (Vite).
// Imported via relative path from both sides — no build step needed.

export type Frame = { x: number; y: number; w: number; h: number };

export type AXNode = {
  id: string;
  type: string;                    // e.g. "Button", "Text", "View"
  role: string;                    // raw AX role, e.g. "AXButton"
  roleDescription: string | null;  // human description, e.g. "Nav bar", "button"
  label: string | null;            // visible AX label — this is the grep key
  identifier: string | null;       // accessibilityIdentifier if set
  value: string | null;
  frame: Frame;                    // in sim-pixel coordinates
  enabled: boolean;
};

export type Snapshot = {
  deviceId: string;
  simSize: { w: number; h: number };
  nodes: AXNode[];                 // flat list; hit-test by frame containment
  capturedAt: number;
  source: 'idb' | 'mock' | 'none';
};

// Client → Bridge
export type ClientMsg =
  | { type: 'inspect:refresh' }
  | { type: 'video:transport'; transport: VideoTransport }
  | { type: 'hid:tap'; x: number; y: number }
  | { type: 'hid:swipe'; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: 'hid:text'; text: string }
  | { type: 'hid:key'; key: 'home' | 'lock' | 'volumeUp' | 'volumeDown' };

// Bridge → Client
// Binary WS messages on the same socket carry JPEG frames. First byte
// is a tag, payload is the frame:
//   0x01 = full image frame (JPEG or PNG, sniff from magic bytes)
// Kept as a tag rather than raw bytes so we have forward room for
// alternative frame formats without rewriting the client.
export const BIN_TAG_IMAGE = 0x01;

export type VideoTransport = 'capturekit' | 'screenshot' | 'none';

export type BridgeMsg =
  | { type: 'hello'; version: string; deviceId: string; capabilities: Capabilities }
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'frame:meta'; width: number; height: number; fps: number; source: VideoTransport }
  | { type: 'error'; message: string };

export type Capabilities = {
  idb: boolean;      // idb installed → AX + taps available
  simctl: boolean;   // simctl installed → screenshot fallback available
  booted: boolean;   // a sim is currently booted
  capturekit: boolean; // ScreenCaptureKit sidecar built and runnable
  videoTransport: VideoTransport;
};
