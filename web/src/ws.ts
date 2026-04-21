import type { BridgeMsg, ClientMsg, Snapshot } from '../../shared/protocol';

export type BridgeEvents = {
  onSnapshot?: (s: Snapshot) => void;
  onFrame?: (blob: Blob) => void;
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
    } catch (e) {
      this.events.onStatus?.('error');
      this.retry();
      return;
    }
    this.ws.binaryType = 'blob';
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
    if (data instanceof Blob) {
      this.events.onFrame?.(data);
      return;
    }
    if (typeof data !== 'string') return;
    let msg: BridgeMsg;
    try { msg = JSON.parse(data) as BridgeMsg; } catch { return; }
    switch (msg.type) {
      case 'hello': this.events.onHello?.(msg); break;
      case 'snapshot': this.events.onSnapshot?.(msg.data); break;
      case 'error': this.events.onError?.(msg.message); break;
      case 'frame:meta': break; // reserved for future use
    }
  }
}
