# swift-grab

Browser-based inspector for the iOS Simulator.

Stream a running simulator into a web page and hover any element to see
the deepest accessibility node under the cursor — type, label, frame,
ancestor chain. Built to give coding agents (Cursor, Codex, Claude) rich
context about what the user just tapped, without requiring source maps
or any code changes to the target app.

Works on **any** app running in the simulator: SwiftUI, UIKit, React
Native, Flutter, or something you don't even own. The inspector reads the
accessibility tree, which every app publishes for free.

## Layout

```
swift-grab/
├── shared/protocol.ts   # WS message types + AXNode shape
├── web/                 # Vite + TS frontend (inspector UI)
└── bridge/              # Bun WS server wrapping simctl + idb
```

## Quickstart

```bash
bun install

# Terminal 1 — web UI (works standalone with mock data)
bun run dev:web
# open http://localhost:5173

# Terminal 2 — bridge (optional; needs a booted simulator)
bun run dev:bridge
```

The web UI starts in **mock mode** if no bridge is reachable, so you can
play with the inspector UI without any simulator at all.

## Real-sim requirements

- A booted iOS simulator (`xcrun simctl boot <udid>` or open Simulator.app)
- `xcrun simctl` — ships with Xcode, used for framebuffer screenshots
- [`idb`](https://fbidb.io) — needed for AX tree and tap injection:

  ```bash
  brew install facebook/fb/idb-companion
  pipx install fb-idb
  ```

  The bridge will auto-run `idb connect <udid>` against the booted sim on
  startup, so you don't need to connect manually.

Without `idb` the bridge will still stream frames, but hover-inspect and
tap-injection won't work (use mock mode to try the UI).

## Protocol

Control plane is JSON over a single WebSocket at `ws://localhost:7878/ws`.
Binary WS messages on the same socket carry PNG frames. See
`shared/protocol.ts` for the full message set.

## Keyboard

| Key        | Action                                                      |
|------------|-------------------------------------------------------------|
| `I`        | Toggle inspect mode (hover highlights vs. pass-through tap) |
| `Esc`      | Clear selection                                             |
| `Cmd/Ctrl` | Freeze the current hover (drag to sidebar without losing it)|

## What's next

- Swap `simctl io screenshot` loop for direct `SimulatorKit` IOSurface
  stream → VideoToolbox H.264 → MSE in the browser (60 fps vs ~5 fps)
- Sim-only mode (no sidebar) for a clean recording/demo view
- Expose AX elements as real DOM nodes so Cursor's built-in browser
  element selector can pick them natively
