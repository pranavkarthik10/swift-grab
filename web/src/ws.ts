import {
  type BridgeMsg,
  type ClientMsg,
  type Snapshot,
  BIN_TAG_IMAGE,
} from '../../shared/protocol';

export type FrameMeta = Extract<BridgeMsg, { type: 'frame:meta' }>;

export type BridgeEvents = {
  onSnapshot?: (s: Snapshot) => void;
  onPointInspect?: (msg: Extract<BridgeMsg, { type: 'inspect:point' }>) => void;
  onFrame?: (blob: Blob) => void;
  onFrameMeta?: (meta: FrameMeta) => void;
  onHello?: (msg: Extract<BridgeMsg, { type: 'hello' }>) => void;
  onStatus?: (s: 'connecting' | 'live' | 'error' | 'closed') => void;
  onError?: (msg: string) => void;
};

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private events: BridgeEvents;
  private reconnectMs = 1500;
  private stopped = false;

  constructor(url: string, events: BridgeEvents) {
    this.url = url;
    this.events = events;
  }

  connect() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private open() {
    this.events.onStatus?.('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.events.onStatus?.('error');
      this.retry();
      return;
    }
    // ArrayBuffer (not Blob) — avoids an async Blob.arrayBuffer() hop
    // per frame, which matters at 50fps.
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.events.onStatus?.('live');
    this.ws.onclose = () => {
      this.events.onStatus?.('closed');
      this.retry();
    };
    this.ws.onerror = () => this.events.onStatus?.('error');
    this.ws.onmessage = (e) => this.handleMessage(e.data);
  }

  private retry() {
    if (this.stopped) return;
    setTimeout(() => this.open(), this.reconnectMs);
  }

  private handleMessage(data: unknown) {
    if (data instanceof ArrayBuffer) {
      this.handleBinary(new Uint8Array(data));
      return;
    }
    if (data instanceof Blob) {
      // Defensive: older harness code might still set binaryType=blob.
      this.events.onFrame?.(data);
      return;
    }
    if (typeof data !== 'string') return;
    let msg: BridgeMsg;
    try { msg = JSON.parse(data) as BridgeMsg; } catch { return; }
    switch (msg.type) {
      case 'hello': this.events.onHello?.(msg); break;
      case 'snapshot': this.events.onSnapshot?.(msg.data); break;
      case 'inspect:point': this.events.onPointInspect?.(msg); break;
      case 'frame:meta': this.events.onFrameMeta?.(msg); break;
      case 'error': this.events.onError?.(msg.message); break;
    }
  }

  private handleBinary(u8: Uint8Array) {
    if (u8.length < 2) return;
    const tag = u8[0];
    const payload = u8.subarray(1);
    if (tag === BIN_TAG_IMAGE) {
      const copy = new Uint8Array(payload.length);
      copy.set(payload);
      this.events.onFrame?.(new Blob([copy], { type: sniffMime(payload) }));
    }
  }
}

function sniffMime(u8: Uint8Array): string {
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  return 'application/octet-stream';
}
