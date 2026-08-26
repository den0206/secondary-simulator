# Changelog

Written in English so the public extension pages (Open VSX / Marketplace) read the same
for everyone. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

`[Unreleased]` holds changes for the next release. At release time (pushing
`release/Ver_X.Y.Z`) `scripts/release-changelog.js` moves them under a version heading,
so **there is no need to move entries by hand**.

## [Unreleased]

## [0.5.0] — 2026-08-26

### Added

- Screen recordings can now capture what you do, not just what the device shows. The device
  recorder (`device.screenrecord`) records the device framebuffer, where taps and the mouse
  pointer are invisible: input is synthesised over HID/adb, so the device never draws a
  finger, and the pointer only exists on the host.
  `secondarySimulator.recordingSource` is now `view` by default: the webview composites the
  frames it is showing together with the mouse cursor and tap markers onto a canvas — plus the
  drag trail when `secondarySimulator.showTouchTrail` is on — encodes that with
  `MediaRecorder`, and streams it to the file you picked. The container is whatever this
  Chromium can encode — MP4 where H.264 recording is available,
  WebM otherwise — and the save dialog offers the matching extension. Picture quality follows
  the stream shown in the sidebar, so set `recordingSource` to `device` when you want the
  device's own full-resolution recording and do not need the cursor

### Changed

- The tap ripple and drag trail are now a setting (`secondarySimulator.showTouchTrail`) instead
  of a button in the sidebar, and they are off by default. The overlay was a webview-only
  preference, so it could not be configured from the Settings UI; the button is gone and the
  setting is the only state

- Recording keeps its memory and storage behaviour explicit. Chunks are written straight to
  the file you chose (no temporary files), and every buffer has a stated limit: the webview
  holds at most 8 chunks that the host has not yet written, encoding is capped at 4 Mbps,
  and a recording stops at 512 MB or 10 minutes, whichever comes first. Because a single
  dropped chunk corrupts the container, a full queue stops the recording instead of
  discarding data, and a recording whose chunks stop arriving (a reloaded or closed webview)
  is closed out rather than left open. While recording, the footer shows how much has been
  written and the effective bitrate

- The finished-file check now recognises both containers: MP4 is still checked for `moov`,
  WebM for at least one cluster. Recordings that were cut short are reported as such instead
  of being announced as saved

- The bundled `mobilecli` moves from 1.0.2 to 1.0.5. It brings upstream fixes for screen
  recording on physical iOS devices — the broadcast picker is re-tapped and searched through
  nested elements while waiting, and the recording timer starts once capture is live rather
  than during the roughly ten seconds of setup — plus a fix for the iOS device lock being
  copied. None of the JSON-RPC methods this extension calls changed

### Fixed

- The device dropdown could end up empty with nothing to select, and pressing Refresh did not
  bring it back. The device list is only sent to the webview when it differs from what was
  sent last, but that record lives in the extension host: when the webview alone was rebuilt
  (a reloaded or crashed renderer, or moving the view to another container) the list looked
  unchanged and was never re-sent, leaving the freshly built dropdown with nothing in it. A
  rebuilt webview now announces itself and gets everything the host only sends once — the
  device list, the current selection, the input-path label, the recording indicator, and the
  direct-stream URL — and Refresh always re-sends the list

- Pasting into the device inserted the previous clipboard entry whenever the text had been
  copied from outside the editor — a browser, another app, a file. Text copied inside VS Code
  pasted correctly, which is what made it look like it worked. The webview read the clipboard
  itself, and a webview is a sandboxed iframe whose `clipboardData` lags the system pasteboard
  for writes it did not see. The clipboard is now read on the extension host with
  `vscode.env.clipboard.readText()`, which asks the OS at the moment of the paste; the webview
  only signals that a paste happened. An empty clipboard is now logged rather than dropped in
  silence

- Typing and pasting sometimes went to the file open in the editor instead of the device.
  Tapping the device screen did not move keyboard focus into the webview: the `pointerdown`
  handler calls `preventDefault()` to suppress image dragging and text selection, and that
  also cancels the focus change the browser performs as part of the default action. Focus
  therefore stayed wherever it was — usually the editor — so `Cmd+V` pasted there. It looked
  intermittent because clicking a button or the device dropdown does move focus, making the
  next paste work. The container now takes focus explicitly on `pointerdown`

## [0.4.0] — 2026-08-24

### Added

- Recording now starts after a three-second countdown shown over the device screen,
  so the moment the save dialog closes no longer ends up as the first frame. The
  extension host drives the count and the webview only draws the number and ticks

### Fixed

- Android screen recordings could not be played back. Every file came out with no `moov`
  atom and an unfinalized `mdat` box, which QuickTime and `ffprobe` both refuse. The cause
  was upstream: mobilecli 0.1.64 sent `SIGINT` to the local `adb` client when stopping a
  recording, but `adb` does not forward signals to the remote shell, so the on-device
  `screenrecord` was never told to finalize the MP4 and the half-written file was pulled
  anyway. The recording was reported as saved regardless. This was unrelated to what
  happened on screen while recording, contrary to how it first looked

- A recording that fails to finalize is no longer reported as saved. Stopping a recording
  now checks the written file for an MP4 `moov` atom before claiming success; when it is
  missing the extension raises a warning with a link to the log instead of the "Recording
  saved" notice, and the webview stays silent rather than playing the chime that signals a
  good save. The check walks the file's top-level boxes and stops after 128 of them, so it
  reads a few hundred bytes regardless of how long the recording is

### Changed

- The bundled mobilecli moved from `@mobilenext/mobilecli` 0.1.64 to `mobilecli` 1.0.2.
  Upstream stopped publishing the scoped package in April 2026 and continued under the
  unscoped name, so the fix above was only reachable by following that move. The RPC
  surface the extension uses is unchanged: all eleven methods it calls still exist, the
  HTTP routes and the screen-capture session response are byte-identical, and 1.0.x only
  adds methods
- Starting a recording now waits up to 90 seconds for mobilecli to confirm it is live,
  rather than 30. mobilecli 1.0.x only answers `device.screenrecord` once recording has
  actually begun, and on a physical iOS device that means waiting for the ReplayKit
  broadcast picker to be tapped. Giving up first left the extension reporting a failed
  start while the device kept recording untracked
- The mobilecli version is now pinned exactly instead of with a caret, and a Dependabot
  configuration keeps it current. Version bumps arrive as pull requests that run CI before
  reaching users, rather than being resolved at install or run time

### Security

- The bundled mobilecli is now covered by **FSL-1.1-ALv2** rather than AGPL-3.0. Upstream
  relicensed at 0.3.75, before the fix landed at 0.3.77, so no AGPL-licensed release
  contains it. FSL is a source-available licence: it permits every use except a *Competing
  Use*, meaning offering substantially similar functionality to others in a commercial
  product or service. This extension is free of charge and runs mobilecli unmodified as a
  separate process. `THIRD-PARTY-NOTICES.md` carries the full licence text and the
  corresponding source revision, and ships inside the VSIX as redistribution requires

## [0.3.1] — 2026-08-22

### Added

- A walkthrough under **Help → Welcome**, which also opens on its own right after installing
  from the Marketplace. The preview lands in the Activity Bar, where it covers the file tree,
  and moving it to the Secondary Side Bar was a step nobody could guess. The walkthrough
  spells it out: right-click the icon in the Activity Bar, then Move To, then Secondary
  Side Bar. Placing the view there from the manifest is not an
  option — the `viewsContainers.secondarySidebar` contribution point only exists in VS Code
  1.106 and later, and Cursor rejects it outright because it reserves that side bar for its
  agent UI, which would drop the view into the Explorer instead

### Security

- The mobilecli RPC server no longer starts with `--cors`. With CORS enabled, any page open
  in a browser on the same machine could call the RPC and read the replies: list devices,
  take screenshots of whatever the simulator shows, drive the device, and write a recording
  to an arbitrary path on the host. The extension never needed it — the extension host calls
  it through Node's `fetch`, which has no origin, and the webview only loads an `<img>`,
  which is not subject to CORS
- Key presses are no longer written to the output channel. What used to be one line per
  keystroke at the default log level meant every password typed into an app under
  development stayed in memory for the session and travelled along with any log attached to
  a bug report. Only the kind of key is logged now, at debug level; the names of special
  keys stay because they are not content
- JSON-RPC errors no longer carry the request parameters. A failing `device.io.text` used to
  put the pasted text into the exception message, which is both logged and shown in the
  webview overlay. The method name and the device id are kept, since that is what diagnosis
  needs
- The scan for a running mobilecli server covers 10 ports instead of 101, which narrows the
  range of unrelated local services that receive a JSON POST
- Labels in the resource footer are escaped before being placed in the webview, so a
  translation bundle containing markup cannot break the layout
- The `npx` fallback for mobilecli now runs with `--ignore-scripts`. It is the one path
  where the extension executes code fetched from the network on the user's machine (it is
  taken on every platform other than macOS, since only the darwin binaries are bundled), so
  it should not also run install hooks. The version stays pinned, as before

### Fixed

- The MJPEG proxy is now shut down when direct streaming is turned off and on disconnect,
  instead of holding its HTTP listener and token until the session ends
- Starting the MJPEG proxy no longer replaces the webview port mapping, which could drop the
  permission granted to the sidecar stream port
- Looking for the bundled mobilecli binary no longer runs it during `activate`. Spawning a
  child process there blocks the extension host, and on macOS the first run of a quarantined
  binary waits on Gatekeeper. Executability is checked with `access` instead

## [0.3.0] — 2026-08-21

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

[Unreleased]: https://github.com/den0206/secondary-simulator/compare/Ver_0.5.0...HEAD
[0.5.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.4.0...Ver_0.5.0
[0.4.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.3.1...Ver_0.4.0
[0.3.1]: https://github.com/den0206/secondary-simulator/compare/Ver_0.3.0...Ver_0.3.1
[0.3.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.2.0...Ver_0.3.0
[0.2.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.1.1...Ver_0.2.0
[0.1.1]: https://github.com/den0206/secondary-simulator/compare/Ver_0.1.0...Ver_0.1.1
[0.1.0]: https://github.com/den0206/secondary-simulator/compare/Ver_0.0.1...Ver_0.1.0
[0.0.1]: https://github.com/den0206/secondary-simulator/releases/tag/Ver_0.0.1
