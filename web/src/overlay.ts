import type { AXNode, Frame } from '../../shared/protocol';

type El<T extends HTMLElement = HTMLElement> = T;

export class InspectorOverlay {
  private screen: El;
  private overlay: El;
  private box: El;
  private label: El;
  private selection: El;
  private simW = 1;
  private simH = 1;

  constructor(opts: {
    screen: El; overlay: El; box: El; label: El; selection: El;
  }) {
    this.screen = opts.screen;
    this.overlay = opts.overlay;
    this.box = opts.box;
    this.label = opts.label;
    this.selection = opts.selection;
  }

  setSimSize(w: number, h: number) {
    this.simW = w || 1;
    this.simH = h || 1;
    this.screen.style.aspectRatio = `${w} / ${h}`;
  }

  /** Map a mouse event to sim-pixel coordinates, or null if outside. */
  hitPoint(e: MouseEvent): { x: number; y: number } | null {
    const rect = this.screen.getBoundingClientRect();
    if (
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top  || e.clientY > rect.bottom
    ) return null;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top)  / rect.height;
    return { x: px * this.simW, y: py * this.simH };
  }

  showHover(node: AXNode | null) {
    if (!node) {
      this.overlay.classList.add('hidden');
      return;
    }
    this.overlay.classList.remove('hidden');
    const { x, y, w, h } = this.toPercent(node.frame);
    this.box.style.left = `${x}%`;
    this.box.style.top = `${y}%`;
    this.box.style.width = `${w}%`;
    this.box.style.height = `${h}%`;

    this.label.textContent = `<${node.type} /> ${Math.round(node.frame.w)}×${Math.round(node.frame.h)}`;
    // place label just under the box, clamped so it doesn't fall off-screen
    const labelY = Math.min(y + h, 100 - 4);
    this.label.style.left = `${x}%`;
    this.label.style.top = `${labelY}%`;
  }

  showSelection(node: AXNode | null) {
    if (!node) {
      this.selection.classList.add('hidden');
      return;
    }
    this.selection.classList.remove('hidden');
    const { x, y, w, h } = this.toPercent(node.frame);
    this.selection.style.left = `${x}%`;
    this.selection.style.top = `${y}%`;
    this.selection.style.width = `${w}%`;
    this.selection.style.height = `${h}%`;
  }

  private toPercent(f: Frame) {
    return {
      x: (f.x / this.simW) * 100,
      y: (f.y / this.simH) * 100,
      w: (f.w / this.simW) * 100,
      h: (f.h / this.simH) * 100,
    };
  }
}
