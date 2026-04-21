import type { AXNode, Snapshot } from '../../shared/protocol';

// An iPhone-sized fake screen with a layout similar to the Sim Preview
// reference: counter, greeting form, toggle, nested boxes, scroll test.
// Coordinates are in "sim points" (390 × 844 — iPhone logical size).

const SIM_W = 390;
const SIM_H = 844;

const nodes: AXNode[] = [
  node('root', 'View', null, 0, 0, SIM_W, SIM_H),

  node('hdr', 'View', null, 0, 0, SIM_W, 120),
  node('title', 'Text', 'Sim Preview Demo', 20, 64, 280, 32, 'AXStaticText'),
  node('subtitle', 'Text', 'Click elements in the browser to inspect them.', 20, 100, 340, 18, 'AXStaticText'),

  node('sec-counter', 'Section', null, 16, 140, SIM_W - 32, 110),
  node('counter-label', 'Text', 'COUNTER', 32, 152, 120, 16, 'AXStaticText'),
  node('btn-dec', 'Button', 'Decrement', 36, 182, 56, 56, 'AXButton'),
  node('counter-value', 'Text', '0', 180, 192, 36, 36, 'AXStaticText'),
  node('btn-inc', 'Button', 'Increment', SIM_W - 92, 182, 56, 56, 'AXButton'),

  node('sec-form', 'Section', null, 16, 264, SIM_W - 32, 140),
  node('form-label', 'Text', 'GREETING FORM', 32, 276, 160, 16, 'AXStaticText'),
  node('name-field', 'TextField', 'Your name', 32, 308, SIM_W - 64, 40, 'AXTextField'),
  node('btn-hi', 'Button', 'Say hi', 32, 356, SIM_W - 64, 36, 'AXButton'),

  node('sec-toggle', 'Section', null, 16, 418, SIM_W - 32, 80),
  node('toggle-label', 'Text', 'TOGGLE', 32, 430, 80, 16, 'AXStaticText'),
  node('toggle-desc', 'Text', 'Dark ritual mode', 32, 454, 200, 22, 'AXStaticText'),
  node('toggle', 'Switch', 'Dark ritual mode', SIM_W - 80, 450, 48, 30, 'AXSwitch'),

  node('sec-nested', 'Section', null, 16, 512, SIM_W - 32, 180),
  node('nested-label', 'Text', 'NESTED BOXES', 32, 524, 140, 16, 'AXStaticText'),
  node('outer', 'View', null, 40, 550, SIM_W - 80, 128),
  node('inner', 'View', 'inner', 150, 580, 90, 68, 'AXButton'),

  node('sec-scroll', 'Section', null, 16, 706, SIM_W - 32, 130),
  node('scroll-label', 'Text', 'SCROLL TEST', 32, 718, 140, 16, 'AXStaticText'),
  node('row1', 'Text', 'Row #1', 32, 746, SIM_W - 64, 28, 'AXStaticText'),
  node('row2', 'Text', 'Row #2', 32, 778, SIM_W - 64, 28, 'AXStaticText'),
  node('row3', 'Text', 'Row #3', 32, 810, SIM_W - 64, 28, 'AXStaticText'),
];

function node(
  id: string,
  type: string,
  label: string | null,
  x: number, y: number, w: number, h: number,
  role = 'AXGroup',
): AXNode {
  return {
    id,
    type,
    role,
    label,
    identifier: null,
    value: null,
    frame: { x, y, w, h },
    enabled: true,
  };
}

export const mockSnapshot: Snapshot = {
  deviceId: 'mock-iphone-15',
  simSize: { w: SIM_W, h: SIM_H },
  nodes,
  capturedAt: Date.now(),
  source: 'mock',
};

// A rendered SVG of the mock screen, inlined as a data URL. Matches the
// coordinates above exactly so hover highlighting lines up.
export const mockFrameDataUrl: string = (() => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIM_W} ${SIM_H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0c0f18"/>
      <stop offset="100%" stop-color="#05070c"/>
    </linearGradient>
    <linearGradient id="violet" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7a6cff"/>
      <stop offset="100%" stop-color="#4d3dfc"/>
    </linearGradient>
  </defs>
  <rect width="${SIM_W}" height="${SIM_H}" fill="url(#bg)"/>

  <!-- status bar + header -->
  <text x="28" y="36" fill="#e6e8ef" font-family="-apple-system,system-ui" font-size="14" font-weight="600">21:03</text>
  <rect x="155" y="16" width="80" height="26" rx="13" fill="#000"/>
  <text x="20" y="92" fill="#f3f5fa" font-family="-apple-system,system-ui" font-size="26" font-weight="700">Sim Preview Demo</text>
  <text x="20" y="114" fill="#9aa3b8" font-family="-apple-system,system-ui" font-size="12">Click elements in the browser to inspect them.</text>

  <!-- counter -->
  <rect x="16" y="140" width="${SIM_W - 32}" height="110" rx="14" fill="#10141d" stroke="#1a2030"/>
  <text x="32" y="164" fill="#7d8699" font-family="-apple-system,system-ui" font-size="10" letter-spacing="1.5" font-weight="600">COUNTER</text>
  <circle cx="64" cy="210" r="22" fill="#1a2030"/>
  <rect x="56" y="208" width="16" height="3" rx="1.5" fill="#e6e8ef"/>
  <text x="198" y="222" fill="#e6e8ef" font-family="-apple-system,system-ui" font-size="28" font-weight="700" text-anchor="middle">0</text>
  <circle cx="${SIM_W - 64}" cy="210" r="22" fill="#1a2030"/>
  <rect x="${SIM_W - 72}" y="208" width="16" height="3" rx="1.5" fill="#e6e8ef"/>
  <rect x="${SIM_W - 65}" y="200" width="3" height="17" rx="1.5" fill="#e6e8ef"/>

  <!-- form -->
  <rect x="16" y="264" width="${SIM_W - 32}" height="140" rx="14" fill="#10141d" stroke="#1a2030"/>
  <text x="32" y="288" fill="#7d8699" font-family="-apple-system,system-ui" font-size="10" letter-spacing="1.5" font-weight="600">GREETING FORM</text>
  <rect x="32" y="308" width="${SIM_W - 64}" height="40" rx="10" fill="#181d28"/>
  <text x="44" y="333" fill="#5b6478" font-family="-apple-system,system-ui" font-size="13">Your name</text>
  <text x="${SIM_W / 2}" y="380" fill="#7cc4ff" font-family="-apple-system,system-ui" font-size="15" font-weight="600" text-anchor="middle">Say hi</text>

  <!-- toggle -->
  <rect x="16" y="418" width="${SIM_W - 32}" height="80" rx="14" fill="#17192a" stroke="#232745"/>
  <text x="32" y="442" fill="#7d8699" font-family="-apple-system,system-ui" font-size="10" letter-spacing="1.5" font-weight="600">TOGGLE</text>
  <text x="32" y="472" fill="#e6e8ef" font-family="-apple-system,system-ui" font-size="14">Dark ritual mode</text>
  <rect x="${SIM_W - 80}" y="450" width="48" height="30" rx="15" fill="#2a2e45"/>
  <circle cx="${SIM_W - 47}" cy="465" r="12" fill="#cbd0e5"/>

  <!-- nested -->
  <rect x="16" y="512" width="${SIM_W - 32}" height="180" rx="14" fill="#10141d" stroke="#1a2030"/>
  <text x="32" y="536" fill="#7d8699" font-family="-apple-system,system-ui" font-size="10" letter-spacing="1.5" font-weight="600">NESTED BOXES</text>
  <rect x="40" y="550" width="${SIM_W - 80}" height="128" rx="10" fill="url(#violet)"/>
  <rect x="150" y="580" width="90" height="68" rx="10" fill="#a8bcff"/>
  <text x="195" y="620" fill="#2a2a4a" font-family="-apple-system,system-ui" font-size="12" font-weight="600" text-anchor="middle">inner</text>

  <!-- scroll -->
  <rect x="16" y="706" width="${SIM_W - 32}" height="130" rx="14" fill="#10141d" stroke="#1a2030"/>
  <text x="32" y="730" fill="#7d8699" font-family="-apple-system,system-ui" font-size="10" letter-spacing="1.5" font-weight="600">SCROLL TEST</text>
  <rect x="32" y="746" width="${SIM_W - 64}" height="28" rx="6" fill="#181d28"/>
  <text x="44" y="765" fill="#c6d0e5" font-family="-apple-system,system-ui" font-size="12">Row #1</text>
  <rect x="32" y="778" width="${SIM_W - 64}" height="28" rx="6" fill="#181d28"/>
  <text x="44" y="797" fill="#c6d0e5" font-family="-apple-system,system-ui" font-size="12">Row #2</text>
  <rect x="32" y="810" width="${SIM_W - 64}" height="28" rx="6" fill="#181d28"/>
  <text x="44" y="829" fill="#c6d0e5" font-family="-apple-system,system-ui" font-size="12">Row #3</text>
</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
})();
