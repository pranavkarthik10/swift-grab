// Types shared between the bridge (Bun) and the web inspector (Vite).
// Imported via relative path from both sides — no build step needed.

export type Frame = { x: number; y: number; w: number; h: number };

export type AXNode = {
  id: string;
  type: string;                    // e.g. "Button", "Text", "View"
  role: string;                    // raw AX role, e.g. "AXButton"
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
  | { type: 'hid:tap'; x: number; y: number }
  | { type: 'hid:swipe'; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: 'hid:text'; text: string }
  | { type: 'hid:key'; key: 'home' | 'lock' | 'volumeUp' | 'volumeDown' };

// Bridge → Client
// (binary WS messages on the same socket carry image frames — PNG by default)
export type BridgeMsg =
  | { type: 'hello'; version: string; deviceId: string; capabilities: Capabilities }
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'frame:meta'; width: number; height: number; mime: 'image/png' | 'image/jpeg' }
  | { type: 'error'; message: string };

export type Capabilities = {
  idb: boolean;      // idb installed → AX + taps available
  simctl: boolean;   // simctl installed → frames available
  booted: boolean;   // a sim is currently booted
};
