# Changelog

Written in English so the public extension pages (Open VSX / Marketplace) read the same
for everyone. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

`[Unreleased]` holds changes for the next release. At release time (pushing
`release/Ver_X.Y.Z`) `scripts/release-changelog.js` moves them under a version heading,
so **there is no need to move entries by hand**.

## [Unreleased]

### Added

- Screen recording (`Secondary Simulator: Record Screen` and the Rec button in the sidebar).
  The destination is picked up front and written by mobilecli directly, so the extension
  keeps no temporary files. Recording always stops after 10 minutes, on disconnect, or on
  disposal, so a forgotten recording cannot grow without bound. It also stops when the
  sidebar is hidden. A short sound plays on start, stop, and when a screenshot is saved
- `secondarySimulator.saveLocation` / `saveDirectory` — the folder the save dialog opens in
  for screenshots and recordings (defaults to the desktop; workspace, home, or a custom path)
- Clipboard paste. Pressing Cmd/Ctrl+V over the screen sends the text in one go instead of
  character by character (for entering URLs and email addresses)
- Arrow keys. The HID usage codes were already there, but the webview dropped the events
  because they do not match `e.key.length === 1`. Android has no character for them, so
  they are sent as `KEYCODE_DPAD_*`
- `secondarySimulator.showDeviceFrame` — whether to draw the device bezel. Turn it off to
  use the full width of a narrow sidebar
- `secondarySimulator.showResourceStats` — whether the footer shows memory and extension
  directory size (off by default). The video rate and input path are always shown

### Changed

- The device list is grouped into iOS and Android. Running devices no longer repeat their state
- Picking a stopped device from the sidebar list now boots it. Previously it ended with
  "not running", which was the only place the result differed from the command palette

### Fixed

- Errors can be recovered from in place (Retry / Show Logs). Previously the overlay only
  showed text on a black screen with no indication of what to do next
- Characters typed to filter the device `<select>` are no longer forwarded to the device

## [0.2.0] — 2026-08-18

### Added

- Localized UI. English is the default; Japanese (`ja`) and Simplified Chinese (`zh-cn`)
  are bundled. The display language follows VS Code / Cursor. Command names and setting
  descriptions come from `package.nls*.json`; runtime messages come from
  `l10n/bundle.l10n.*.json`. The sidebar receives strings already translated from the
  extension host, so nothing flashes in English first. Log output is developer-facing
  diagnostics and is not translated
- Sidecar capture now follows the display width and interaction: a narrow sidebar lowers
  the width, and the frame rate rises up to 2x while a finger is down. Added stall
  detection for static screens and descriptor re-acquisition
- The sidecar can serve frames directly on 127.0.0.1, so `directStream` also works with
  sidecar capture
- `secondarySimulator.captureMode` — capture on display change notifications, or pin to polling
- The footer shows received fps, painted fps, and bandwidth (painted only while direct streaming)

### Changed

- Dropped canvas + ImageBitmap. Frames are shown as a data URL on an `<img>` or as a
  direct MJPEG stream
- Hiding the view or reconnecting to the same device no longer recreates the sidecar; only
  the display stops (released after 2 minutes idle)

### Fixed

- Closing the display removes the `src` attribute (`src=""` makes the browser fetch the
  page's own URL)
- Bounded the concurrent connections and header read time of the direct stream
- Settings that change the path (capture source, transport) now recreate the capture
- The direct-stream fps readout no longer shows a misleading number when painted frames
  cannot be counted

## [0.1.1] — 2026-08-18

### Added

- `secondarySimulator.logLevel` — how much detail is written to the output channel
  (default info). VS Code keeps the whole channel in memory with no way to cap the line
  count, so the only lever is writing less
- The status bar shows the connected device and the input path (HID / WDA). The same label
  appears at the bottom of the sidebar (the `status` message used to be dropped by the webview)
- Modifier key combinations (`Cmd+A`, `Cmd+C`, …) can be sent. The webview was dropping
  `Shift` / `Control` / `Alt` / `Meta`, so they never arrived. HID path only
- Picking a stopped device in `Secondary Simulator: Select Device` now boots it and connects
  (`device.boot`). It used to end with "not running"
- `Secondary Simulator: Open URL on Device` — open a deep link or URL on the connected
  device (`device.url`)

### Fixed

- Fixed Android drag and scroll being unusable. On Android each mobilecli
  `device.io.gesture` action expands into one `adb shell input ... motionevent` and
  `duration` is ignored, so buffering the path and sending it at once replayed it over tens
  of seconds after the finger was lifted, and flicks (inertial scrolling) never worked.
  Switched to an Android-specific backend that keeps sending only the latest point while
  the finger is down (taps, long presses, and long-press drags still work). When available
  it keeps an `adb shell` session open and streams motionevents into it, falling back to
  the mobilecli path otherwise
- Fixed auto-connect attaching to a different running device while waiting for a stopped
  device to boot

### Changed

- `npm test` is now `node --test test/*.test.js`. Listing files one by one in `package.json`
  meant a new test could pass silently by never being registered
- Added a Linux type check / test job to CI, so breakage is still caught when macOS runners
  are exhausted

## [0.1.0] — 2026-08-17

### Added

- `Secondary Simulator: Clear Logs` — empty the output channel (VS Code holds the whole
  channel in memory and offers no line limit)
- `simhid-server --check` — verifies only that the private HID APIs (CoreSimulator /
  SimulatorKit) still resolve. Runs on every push and a weekly cron so an Xcode update that
  breaks them is caught before users hit it
- `THIRD-PARTY-NOTICES.md` — the full license text and source location for the bundled
  `@mobilenext/mobilecli` 0.1.64 (AGPL-3.0), included in the VSIX
- An AGPL notice for mobilecli in the License section of README / README_JP

### Changed

- Moved the screenshot action from the view title icon to a Shot button under the preview
  (the `Save Screenshot` command remains)
- Renamed the footer's "storage" figure to "extension directory", since that is all it measured
- Added a demo GIF to the README (not bundled in the VSIX)

## [0.0.1] — 2026-08-17

First release.

### Added

- Direct HID injection into the iOS Simulator (`native/simhid-server`) with a WDA fallback
- Capture the iOS Simulator screen straight from the framebuffer through the sidecar
  (`secondarySimulator.captureSource`). WDA screenshots only draw the application window,
  so the software keyboard and status bar were missing
- `secondarySimulator.keyInput` — route iOS keyboard input through HID or WDA. HID keys are
  treated as a hardware keyboard, so iOS does not show the software keyboard
- Direct MJPEG stream display (`secondarySimulator.directStream`) and bandwidth settings
- Raw Pointer Events forwarding, so drags and pinches follow the finger
- Automatic connection to a running device (`secondarySimulator.autoConnect`, turned off by Disconnect)
- Sidebar UI: toolbar, device bezel, waiting spinner, connection lamp, Refresh,
  Trail / Auto toggles, and resource chips
- `Secondary Simulator: Save Screenshot` — save the connected device's screen
- `Secondary Simulator: Select Device` as a QuickPick (it used to only focus the view)
- `Secondary Simulator: Show Logs` — open the output channel
- `docs/project-review.md` — the record of a full review and the proposals left open
- CI (type check, tests, VSIX packaging) and release automation

### Fixed

- Fixed the MJPEG multipart parser confusing byte offsets with character offsets
  (corrupted and dropped frames)
- Fixed `Content-Length` not being reset per part, so the previous value was reused
- Fixed keybindings never firing: the `when` clause used `view ==`, which does not match,
  so Cmd+Shift+R / H / B were dead
- Fixed the port scan repeating on every connection when an existing mobilecli server was reused
- Fixed `MjpegProxy.dispose()` leaving connections and the port open
- Required a token on the direct stream so other processes on the same machine cannot watch the screen
- Made reconnection use exponential backoff so repeated failures do not inflate the output channel
- Detected streams that stall while still connected and re-established them
- Fixed the WDA path's gesture buffer growing without bound (3,601 points and a 190KB RPC
  after a 60 second drag)
- Fixed the sidecar's stdout buffer having no limit
- Fixed the provider holding on to a closed WebviewView
- Fixed mobilecli / simhid-server surviving as orphans when they ignore SIGTERM
- Fixed the webview holding on to pointer IDs it never saw released
- Stopped rewriting the overlay DOM on every frame

### Changed

- Frames are passed to the webview as base64 strings (the previous form varied by environment)
- Removed the unused input API (`tap` / `swipe` / `gesture`, …) and the `ScreenInfo` type
- Stopped emitting `.d.ts` files (they were being bundled into the VSIX)

[Unreleased]: https://github.com/den0206/secondary-simulator/compare/Ver_0.2.0...HEAD
[0.2.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.1.1...Ver_0.2.0
[0.1.1]: https://github.com/den0206/secondary-simulator/compare/Ver_0.1.0...Ver_0.1.1
[0.1.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.0.1...Ver_0.1.0
[0.0.1]: https://github.com/den0206/secondary-simulator/releases/tag/Ver_0.0.1
