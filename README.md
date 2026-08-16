<p align="center">
  <img src="media/icon.png" width="128" alt="Secondary Simulator">
</p>

# Secondary Simulator

[![CI](https://github.com/den0206/secondary-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/den0206/secondary-simulator/actions/workflows/ci.yml)
[![Release](https://github.com/den0206/secondary-simulator/actions/workflows/release.yml/badge.svg)](https://github.com/den0206/secondary-simulator/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

**English** | [日本語](README_JP.md)

A VS Code / Cursor extension that shows iOS Simulators and Android Emulators in the sidebar and lets you drive them in real time.

## 🎯 Overview

Secondary Simulator mirrors your device inside the editor, so you never have to bring the Xcode or Android Studio window forward. The screen arrives over MJPEG streaming, and on the iOS Simulator input is injected directly as HID events for minimal latency.

## ✨ Features

- **📱 Universal device support**: iOS/Android simulators, emulators, and physical devices
- **🖥️ Real-time preview**: high frame rate mirroring over MJPEG streaming
- **👆 Interactive control**: raw Pointer Events are streamed through, so tap, swipe, drag, and pinch are recognized on the device itself
- **⚡ Low latency**: HID injection on the iOS Simulator (`native/simhid-server`), with automatic fallback to WDA
- **🔄 Unified API**: consistent device control through `mobilecli` (JSON-RPC 2.0)
- **💾 Memory friendly**: streams, listeners, and timers are cleaned up to prevent leaks

## 📋 Requirements

- **VS Code / Cursor**: VS Code 1.90.0 or later (Node 20)
- **Node.js**: 20 or later (to run the extension host)
- **macOS**: required for the iOS Simulator and HID injection (Android-only use may work on other platforms, but is untested)
- **mobilecli**: `@mobilenext/mobilecli` ships inside the VSIX (falls back to `npx` if not found)
- **iOS Simulator**: Xcode and the `simctl` command line tools
- **Android Emulator**: Android SDK and the `adb` command line tool

## 🚀 Installation

### Release build (VSIX)

Download `secondary-simulator-X.Y.Z.vsix` from [Releases](https://github.com/den0206/secondary-simulator/releases), then:

```bash
code --install-extension secondary-simulator-X.Y.Z.vsix   # use cursor --install-extension for Cursor
```

You can also use "Install from VSIX…" in the Extensions view, or search for it in Cursor / VSCodium (Open VSX).

### Building from source

```bash
# Install dependencies
npm install

# Build TypeScript and the native sidecar
npm run build

# Run the extension in VS Code
# Press F5 to launch the Extension Development Host
```

## ⚙️ Settings

- **`secondarySimulator.directStream`**: render the stream as a webview-native MJPEG `<img>` (default: false, experimental)
- **`secondarySimulator.streamScale`**: MJPEG scaling factor for iOS (default: 1.0 = original size)
- **`secondarySimulator.streamQuality`**: MJPEG JPEG quality for iOS, 1-100 (default: 80)

There are no gesture threshold settings: tap, swipe, and long press are all recognized on the device side.

## 📖 Usage

1. Open VS Code and activate the extension
2. The "Simulator" view appears in the sidebar
3. Pick a device from the dropdown
4. The device screen is mirrored in real time
5. Interact with the mouse or touchpad:
   - **Click / tap**: single tap
   - **Double click**: double tap
   - **Click & drag**: swipe and drag (follows your pointer)
   - **Press and hold**: long press
   - **Home / Back buttons**: use the controls below the preview

## 🏗️ Project structure

```
secondary-simulator/
├── src/
│   ├── extension.ts                    # Extension entry point
│   ├── simulator/
│   │   └── types.ts                   # Type definitions
│   ├── webview/
│   │   └── SimulatorWebviewProvider.ts # Webview management
│   ├── capture/
│   │   ├── CaptureStrategy.ts         # Capture interface
│   │   ├── MjpegCapture.ts            # MJPEG streaming (canvas path)
│   │   ├── MjpegProxy.ts              # MJPEG proxy (webview <img> path)
│   │   └── WdaSettings.ts             # WDA MJPEG bandwidth settings (iOS)
│   ├── input/
│   │   ├── InputBackend.ts            # Input backend abstraction
│   │   ├── SimhidSidecar.ts           # simhid-server process management (JSON Lines)
│   │   ├── HidSidecarBackend.ts       # Direct HID injection backend
│   │   ├── WdaBackend.ts              # WDA/mobilecli fallback
│   │   └── SimulatorInputController.ts # Backend selection and degradation
│   └── utils/
│       ├── Logger.ts                  # Logging
│       ├── MobileCliClient.ts         # mobilecli client
│       ├── MobileCliServer.ts         # mobilecli server management
│       └── JsonRpcClient.ts           # JSON-RPC 2.0 client
├── native/
│   └── simhid-server.m                # HID injection sidecar (macOS / iOS Simulator)
├── media/
│   ├── icon.svg / icon.png            # Extension icon
│   └── webview/                       # Webview HTML/CSS/JS
├── scripts/
│   └── build-native.sh                # Universal build for simhid-server
├── test/                              # Tests on the Node runtime (no framework)
├── docs/                              # Design and research notes
├── .github/workflows/                 # CI and release
├── out/                               # Compiled output
├── package.json                       # Project manifest
└── tsconfig.json                     # TypeScript config
```

## 🔧 Tech stack

- **Languages**: TypeScript / Objective-C (sidecar)
- **Runtime**: Node.js (VS Code extension host)
- **Key dependency**: `@mobilenext/mobilecli` for device control and streaming
- **Protocols**: JSON-RPC 2.0 (mobilecli) / JSON Lines (sidecar)
- **Streaming**: MJPEG

## 🎨 Architecture

### Capture

1. **MJPEG via canvas (default)** — the extension host receives the `mobilecli` stream, forwards it to the webview, and draws to a canvas
2. **Direct MJPEG (`directStream`, experimental)** — `MjpegProxy` serves the stream so the webview `<img>` receives it directly and Chromium decodes it natively

### Device input

- **Direct HID injection**: on the iOS Simulator, `native/simhid-server` injects HID events (lowest latency)
- **WDA fallback**: Android, physical devices, and any HID init/runtime failure go through `mobilecli`
- **Coordinates**: normalized (0-1) across the whole pipeline; pixel conversion happens inside each backend

### Memory management

- **Resource cleanup**: streams, ImageBitmaps, event listeners, and timers are all released
- **Process management**: the mobilecli server and the sidecar are started, reconnected, and disposed in one place

## 🐛 Troubleshooting

### No devices listed

- Make sure an iOS Simulator or Android Emulator is running
- Make sure `simctl` (iOS) or `adb` (Android) is on your PATH
- Check the extension log to confirm the mobilecli server is running

### Streaming problems

- Check the extension log to confirm the mobilecli server started correctly
- For remote devices, check network connectivity
- If bandwidth is short, lower `streamScale` / `streamQuality`

### Input feels slow or unresponsive

- Check the "Secondary Simulator" output channel to see whether the HID or WDA backend is active
- HID is available **only on the iOS Simulator**; latency rises after falling back to WDA
- Verify the sidecar is present (`native/simhid-server`)

## 📝 Development

```bash
npm run build      # TypeScript + simhid-server (native build is skipped off macOS)
npm run compile    # TypeScript only
npm run typecheck  # Type check only
npm test           # Tests (includes compile)
npm run watch      # Watch mode
npm run package    # Produce vsix/secondary-simulator.vsix
npm run clean      # Remove build output
```

See [CLAUDE.md](CLAUDE.md) for working conventions and architecture notes, and [docs/](docs) for design documents.

## 🚢 Releasing

1. Create a `release/Ver_X.Y.Z` branch from `main` and push it
2. GitHub Actions ([release.yml](.github/workflows/release.yml)) type checks, tests, builds the VSIX, creates a GitHub Release tagged `Ver_X.Y.Z`, and attaches the VSIX
3. If `OVSX_TOKEN` is configured, it also publishes to Open VSX (skipped otherwise)
4. The `package.json` version is synced back to `main` automatically

Notes:

- If `Ver_X.Y.Z` already exists, the rebuild is numbered `Ver_X.Y.Z+1` (published releases are immutable)
- A version older than the latest existing release is rejected
- Release notes come from `docs/release-notes/X.Y.Z.md` if present, otherwise they are generated
- The Open VSX namespace has to be created once by hand: `npx ovsx create-namespace yuuki-sakai -p <token>`

## 📄 License

[MIT](LICENSE.md)

## 🤝 Contributing

Contributions are welcome. Please open pull requests from a `feature/**` or `fix/**` branch so CI runs automatically.

## 📚 References

- [VS Code Extension API](https://code.visualstudio.com/api)
- [mobilecli Documentation](https://github.com/mobile-next/mobilecli)
- [MJPEG Streaming](https://en.wikipedia.org/wiki/Motion_JPEG)
