# sim-grab

`sim-grab` streams the iOS Simulator into the browser, easily accessible from coding agent apps like Cursor, Codex, Claude, and many more. It also exposes the accessibility tree as an inspector, letting you select elements via hover to provide as context for your changes.

Run one command, open a browser tab, mirror the simulator live, and inspect the screen with real accessibility metadata: labels, roles, frames, ancestor chains, and point-level refinement when the accessibility tree is too coarse.

It works with SwiftUI, UIKit, React Native, Flutter, and anything else that exposes accessibility data inside the simulator. It also includes any part of the simulator including iOS, system apps, and more.

![Demo](https://raw.githubusercontent.com/pranavkarthik10/sim-grab/main/demo.png)

## Quick Start

Run without installing:

```bash
npx sim-grab
```

Then open [http://localhost:7879](http://localhost:7879).

For a real simulator session, you need:

- Node.js 18+
- Xcode / `xcrun simctl`
- a booted iOS Simulator
- [`idb`](https://fbidb.io) for accessibility inspection and input injection

Install `idb` with:

```bash
brew install facebook/fb/idb-companion
pipx install fb-idb
```

Without `idb`, `sim-grab` can still stream video frames, but inspection and input control are limited.

## What It Does

- Mirrors a booted iOS Simulator in the browser.
- Lets you inspect on-screen elements through the accessibility tree.
- Refines selections with point-based lookup when the flat tree is ambiguous.
- Copies an agent-ready context block when you select an element.
- Supports pass-through taps, swipes, text input, and hardware-style buttons.
- Mirrors the AX tree into latent DOM nodes so browser-based tools can target simulator elements from the page DOM.
- Falls back to mock mode when no simulator or bridge is connected, so the UI can still be demoed.

## Why It Exists

Most agent tools can read code, but they struggle with a live mobile UI. `sim-grab` closes that gap by giving the browser a live view of the simulator plus a structured model of what is on screen.

That means you can:

- point at a control and get its accessible label and bounds
- hand an agent concrete UI context instead of screenshots alone
- inspect apps you do not own or cannot modify
- drive the simulator from the same surface you inspect

## Modes

### Inspect mode

Use `Inspect` when you want hover highlighting, selection, and the component stack in the sidebar.

- Hover shows the deepest AX node under the cursor.
- Click selects an element, logs a structured payload for agents, and copies an agent-ready context block to the clipboard.
- A point-based AX query runs on selection to improve precision when the flat tree is ambiguous.

### Interaction mode

Turn Inspect off to interact with the simulator.

- Click sends a tap.
- Mouse drag sends a swipe.
- Wheel scrolling sends a coalesced swipe for list navigation.

## Video Transport

`sim-grab` uses two video paths:

- ScreenCaptureKit for smooth live viewing.
- `simctl` screenshots during Inspect mode for tighter AX/frame alignment.

In `Auto` video mode, Inspect uses `simctl`, and Interaction mode returns to a warm ScreenCaptureKit stream when available. If ScreenCaptureKit cannot start, `sim-grab` falls back to `simctl` screenshots.

You can force `CaptureKit` or `simctl` from the UI.

## Keyboard Shortcuts

| Key            | Action                          |
| -------------- | ------------------------------- |
| `I`            | Toggle Inspect mode             |
| `R`            | Refresh the accessibility tree  |
| `H`            | Press Home                      |
| `Esc`          | Clear selection                 |
| `Cmd` / `Ctrl` | Freeze current hover while held |
| `Shift + I`    | Hide or show the sidebar        |

## Configuration

Common runtime variables:

| Var                           | Default | Purpose                                      |
| ----------------------------- | ------- | -------------------------------------------- |
| `PORT`                        | `7878`  | Bridge WebSocket / health port               |
| `SIM_GRAB_WEB_PORT`           | `7879`  | Browser UI port                              |
| `CAPTURE=0`                   | unset   | Disable ScreenCaptureKit                     |
| `CAPTURE_FPS`                 | `50`    | Target ScreenCaptureKit frame rate           |
| `CAPTURE_QUALITY`             | `0.7`   | JPEG quality for ScreenCaptureKit frames     |
| `CAPTURE_MAX_WIDTH`           | `1200`  | Max streamed ScreenCaptureKit frame width    |
| `CAPTURE_RESTART_LIMIT`       | `6`     | CaptureKit restart attempts per window       |
| `CAPTURE_RESTART_WINDOW_MS`   | `30000` | Restart accounting window                    |
| `CAPTURE_RESTART_DELAY_MS`    | `650`   | Delay before restarting CaptureKit           |
| `CAPTURE_WINDOW_ATTEMPTS`     | `40`    | Swift helper window lookup attempts          |
| `CAPTURE_WINDOW_RETRY_MS`     | `100`   | Swift helper window lookup retry delay       |
| `FRAME_MS`                    | `120`   | Screenshot cadence for the `simctl` fallback |
| `FRAME_FORMAT`                | `jpeg`  | Screenshot encoding: `jpeg` or `png`         |

Example:

```bash
PORT=8787 SIM_GRAB_WEB_PORT=8788 npx sim-grab
```

## Local Development

```bash
bun install
bun run dev
```

Or run the two sides separately:

```bash
# Terminal 1
bun run dev:web

# Terminal 2
bun run dev:bridge
```

The published CLI runs on Node and serves built assets from `web/dist`. The development workflow still uses Bun and Vite for fast iteration.

## More

- Troubleshooting and implementation notes: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
