import type { AXNode, Frame } from '../../shared/protocol';
import { bestLabel } from './hittest';

type El<T extends HTMLElement = HTMLElement> = T;

type VideoSource = 'capturekit' | 'screenshot' | 'none';

export class InspectorOverlay {
  private screen: El;
  private frameImg: HTMLImageElement;
  private overlay: El;
  private box: El;
  private label: El;
  private selection: El;
  private simW = 1;
  private simH = 1;
  private frameW = 0;
  private frameH = 0;
  private source: VideoSource = 'none';
  // Cropping in source pixels: the phone screen rect inside the captured frame.
  private content = { x: 0, y: 0, w: 0, h: 0 };
  // Only affects box drawing (NOT hit testing / input coords).
  private legacyBoxMapping = false;

  constructor(opts: {
    screen: El; frameImg: HTMLImageElement; overlay: El; box: El; label: El; selection: El;
  }) {
    this.screen = opts.screen;
    this.frameImg = opts.frameImg;
    this.overlay = opts.overlay;
    this.box = opts.box;
    this.label = opts.label;
    this.selection = opts.selection;
  }

  setSimSize(w: number, h: number) {
    this.simW = w || 1;
    this.simH = h || 1;
    this.recomputeContentRect();
  }

  setFrameMeta(naturalW: number, naturalH: number, source: VideoSource) {
    this.frameW = naturalW || 0;
    this.frameH = naturalH || 0;
    this.source = source;
    this.recomputeContentRect();
  }

  // When true, draw boxes as if the whole frame is the device screen.
  // This matches the "old" CaptureKit behavior some users prefer visually,
  // while keeping input mapping accurate via `content`.
  setLegacyBoxMapping(on: boolean) {
    this.legacyBoxMapping = on;
  }

  /** Map a mouse event to sim-pixel coordinates, or null if outside. */
  hitPoint(e: MouseEvent): { x: number; y: number } | null {
    return this.hitPointClient(e.clientX, e.clientY);
  }

  /** Map viewport client coords to sim-pixel coordinates, or null if outside. */
  hitPointClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const imgRect = this.frameImg.getBoundingClientRect();
    if (
      clientX < imgRect.left || clientX > imgRect.right ||
      clientY < imgRect.top  || clientY > imgRect.bottom
    ) return null;

    // Map client coords into source pixel coords.
    const nx = (clientX - imgRect.left) / imgRect.width;
    const ny = (clientY - imgRect.top) / imgRect.height;
    const sx = nx * (this.frameW || 1);
    const sy = ny * (this.frameH || 1);

    // Then map into sim coords, but only within the content rect.
    const c = this.content;
    if (sx < c.x || sx > c.x + c.w || sy < c.y || sy > c.y + c.h) return null;
    const px = (sx - c.x) / (c.w || 1);
    const py = (sy - c.y) / (c.h || 1);
    return { x: px * this.simW, y: py * this.simH };
  }

  showHover(node: AXNode | null) {
    if (!node) {
      this.overlay.classList.add('hidden');
      return;
    }
    this.overlay.classList.remove('hidden');
    const r = this.toClientRect(node.frame);
    this.box.style.left = `${r.x}px`;
    this.box.style.top = `${r.y}px`;
    this.box.style.width = `${r.w}px`;
    this.box.style.height = `${r.h}px`;

    const bl = bestLabel(node);
    const labelBit = bl.text ? ` ${bl.kind === 'label' ? `“${bl.text}”` : bl.text}` : '';
    this.label.textContent = `<${node.type} />${labelBit} · ${Math.round(node.frame.w)}×${Math.round(node.frame.h)}`;
    // place label just under the box, clamped so it doesn't fall off-screen
    const labelY = Math.min(r.y + r.h + 6, this.screen.clientHeight - 18);
    this.label.style.left = `${Math.max(0, Math.min(r.x, this.screen.clientWidth - 10))}px`;
    this.label.style.top = `${Math.max(0, labelY)}px`;
  }

  showSelection(node: AXNode | null) {
    if (!node) {
      this.selection.classList.add('hidden');
      return;
    }
    this.selection.classList.remove('hidden');
    const r = this.toClientRect(node.frame);
    this.selection.style.left = `${r.x}px`;
    this.selection.style.top = `${r.y}px`;
    this.selection.style.width = `${r.w}px`;
    this.selection.style.height = `${r.h}px`;
  }

  private toClientRect(f: Frame) {
    const imgRect = this.frameImg.getBoundingClientRect();
    const base = this.legacyBoxMapping
      ? { x: 0, y: 0, w: (this.frameW || 1), h: (this.frameH || 1) }
      : this.content;
    const sx = base.x + (f.x / this.simW) * base.w;
    const sy = base.y + (f.y / this.simH) * base.h;
    const sw = (f.w / this.simW) * base.w;
    const sh = (f.h / this.simH) * base.h;

    const x = (sx / (this.frameW || 1)) * imgRect.width;
    const y = (sy / (this.frameH || 1)) * imgRect.height;
    const w = (sw / (this.frameW || 1)) * imgRect.width;
    const h = (sh / (this.frameH || 1)) * imgRect.height;
    return { x, y, w, h };
  }

  private recomputeContentRect() {
    const fw = this.frameW || this.frameImg.naturalWidth || 0;
    const fh = this.frameH || this.frameImg.naturalHeight || 0;
    if (fw <= 0 || fh <= 0) {
      this.content = { x: 0, y: 0, w: 1, h: 1 };
      return;
    }

    // For simctl screenshots, the frame *is* the device screen.
    if (this.source !== 'capturekit') {
      this.content = { x: 0, y: 0, w: fw, h: fh };
      return;
    }

    // For ScreenCaptureKit, the captured frame includes Simulator chrome
    // (titlebar + bezel). Approximate the phone-screen region by:
    // - Cropping a small top band (titlebar)
    // - Fitting the sim aspect ratio inside the remaining area, centered
    const aspect = this.simW / this.simH;
    const topCrop = Math.round(fh * 0.085); // empirically good on Simulator.app
    const avail = { x: 0, y: topCrop, w: fw, h: Math.max(1, fh - topCrop) };

    let w = avail.w;
    let h = Math.round(w / aspect);
    if (h > avail.h) {
      h = avail.h;
      w = Math.round(h * aspect);
    }
    const x = Math.round(avail.x + (avail.w - w) / 2);
    const y = Math.round(avail.y + (avail.h - h) / 2);
    this.content = { x, y, w, h };
  }
}
