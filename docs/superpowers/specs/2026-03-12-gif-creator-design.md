# gif_creator — Revised Architecture Design (v2)

**Date:** 2026-03-12
**Spec reference:** Specs/017-gif-creator.md
**Status:** Approved for implementation planning

---

## Context

`gif_creator` is the next feature in Phase 6 (Monitoring & Advanced Tools → v0.4.0). It records
animated GIFs of browser automation sessions by capturing a screenshot after each `computer`
action and encoding the frame sequence into a deliverable GIF.

---

## Key Design Decisions

### gif_creator is a native tool

`gif_creator` is handled **entirely by `ToolRouter`**, like `screenshot` and `resize_window`.
It is **not** forwarded to the extension. No `gif-creator.js` is needed.

This eliminates three architectural blockers identified in review:
1. tabGroupId never reaches ToolRouter (resolved: use tabId as scope key)
2. GifService can't be shared between ToolRouter and SafariWebExtensionHandler
   (resolved: GifService lives only in ToolRouter, same process)
3. SafariWebExtensionHandler needs no changes (resolved: no new message types)

### Scope key: tabId, not tabGroupId

GifService uses `tabId` as the frame buffer scope key. In practice, automation sessions
operate on one tab at a time. This avoids cross-process tabGroupId resolution entirely.
`resolveTabGroup` is not needed; no changes to `tabs-manager.js`.

### GIF delivery: Desktop file + MCP image response

After encoding, ToolRouter:
1. Writes the GIF to `~/Desktop/recording-<timestamp>.gif` (or the filename from args)
2. Returns the GIF as a `{ type: "image", data: base64, mimeType: "image/gif" }` content
   block in the MCP response alongside a text block with the file path

This gives Claude visibility into the recording AND leaves a file the user can share or
attach to external systems, with no Safari-frontmost requirement.

**In-browser delivery** (injecting GIF via drag-drop DataTransfer into a page element) is
deferred to a future ROADMAP item. It shares the DataTransfer injection pattern with
`upload_image` (Spec 018) and will be built after that tool is validated in Safari.

---

## Revised vs. Written Spec

| Written Spec Assumption | Revised Decision | Reason |
|------------------------|-----------------|--------|
| `gif-creator.js` extension tool handler | **Removed** — no JS needed | gif_creator is native |
| `globalThis.gifRecorder` JS inter-module contract | **Removed** | Native post-action hook replaces this |
| `computer.js` checks `gifRecorder.isRecording()` | **Removed** | ToolRouter handles post-action hook |
| Frames persisted to App Group container files | **In-memory GifService** | Native app does not suspend |
| gif.js Web Worker library in extension | **Removed** | Native ImageIO is more reliable |
| `browser.storage.session` for recording state | **Removed** | State lives in GifService in-memory |
| `globalThis.resolveTabGroup` export needed | **Removed** | tabId used as scope key |
| Export via `<a download>` in extension | **Removed** | Desktop file write (no frontmost req.) |
| Export via drag-drop DataTransfer injection | **Deferred to ROADMAP** | Depends on upload_image (Spec 018) |
| Scope by tab group | **Scope by tabId** | Simpler; same practical effect |
| `kUTTypeGIF` UTI constant | **`"com.compuserve.gif"` string literal** | kUTTypeGIF deprecated macOS 12+ |

---

## Component Responsibilities

### 1. `GifService.swift` (new native service)

Owns all GIF state and encoding. Instantiated inline in `ToolRouter` (same pattern as
`ScreenshotService`). Thread-safe via NSLock.

```swift
class GifService {

    struct GifFrame {
        let sequenceNumber: Int       // monotonic; assigned at dispatch time for ordering
        let imageData: Data           // PNG-encoded, from ScreenshotService
        let actionType: String        // e.g. "left_click", "scroll", "type", "screenshot"
        let coordinate: [Int]?        // parsed via compactMap/NSNumber (same as zoom region)
        let timestamp: Date
        let viewportWidth: Int
        let viewportHeight: Int
    }

    struct GifOptions {
        var showClicks: Bool    = true
        var showActions: Bool   = true
        var showProgress: Bool  = true
        var showWatermark: Bool = true
    }

    // Recording lifecycle
    func startRecording(tabId: Int) -> String
    func stopRecording(tabId: Int) -> String
    func isRecording(tabId: Int) -> Bool
    func frameCount(tabId: Int) -> Int          // for "Stopped. Captured N frames." message

    // Frame management — called by ToolRouter post-action hook
    // Enforces 50-frame ring buffer. Frames stored in insertion order by sequenceNumber.
    func addFrame(_ frame: GifFrame, tabId: Int)

    // Atomically increments and returns the global sequence counter.
    // MUST be called before the async screenshot callback to preserve dispatch-time ordering.
    // Thread-safe (under NSLock).
    func nextSequenceNumber() -> Int

    // Export — snapshot semantics: copies frame array under NSLock, releases lock,
    // then encodes on the snapshot. Concurrent addFrame calls during encoding are safe.
    func exportGIF(tabId: Int, options: GifOptions, filename: String) -> Result<Data, Error>

    // Housekeeping
    func clearFrames(tabId: Int) -> String
}
```

#### GIF encoding

Uses ImageIO with `"com.compuserve.gif"` UTI:

```swift
let dest = CGImageDestinationCreateWithData(mutableData, "com.compuserve.gif" as CFString,
                                            frames.count, nil)
// For each frame:
//   1. Decode PNG → CGImage
//   2. Apply overlays via CGContext (copy to bitmap context, draw on top)
//   3. CGImageDestinationAddImage(dest, overlaidImage, frameProperties)
//      where frameProperties sets kCGImagePropertyGIFDelayTime per action type
CGImageDestinationFinalize(dest)
```

#### Frame timing (kCGImagePropertyGIFDelayTime)

Values are in **seconds** as passed to `kCGImagePropertyGIFDelayTime` (ImageIO accepts seconds
as a `CFNumber`; distinct from raw GIF89a format which uses centiseconds).

| Action type | Delay (s) |
|-------------|-----------|
| `screenshot`, `zoom` | 0.3 |
| `scroll`, `scroll_to`, `navigate` | 0.8 |
| `type`, `key` | 0.8 |
| `hover` | 0.8 |
| `left_click`, `right_click`, `double_click`, `triple_click` | 1.5 |
| `left_click_drag` | 1.5 |
| (default) | 0.8 |

#### Visual overlays (CGContext drawing on each frame)

- `showClicks`: red filled circle (radius 12pt) + outer ring (radius 20pt, 2pt stroke) at coordinate
- `showActions`: filled rounded-rect label at bottom showing action text (e.g. "Clicked at (200, 300)")
- `showProgress`: 3pt-tall filled rect at top, width = (frameIndex / totalFrames) × imageWidth
- `showWatermark`: "Recorded with Claude" in bottom-right corner, 11pt system font, 60% white

#### Thread safety

All mutable state (recording set, frame buffers, sequence counter) is protected by a single
`NSLock`. `exportGIF` acquires the lock to copy the frame array, releases it immediately, then
encodes from the snapshot — never holds the lock during encoding.

#### Frame ordering

`sequenceNumber` is assigned atomically (under lock) in `addFrame`. Since screenshot callbacks
arrive on `DispatchQueue.global()` and may be out of order for rapid successive actions,
`exportGIF` sorts frames by `sequenceNumber` before encoding.

---

### 2. `ToolRouter.swift` (modified)

#### gif_creator native dispatch (new branch in handleToolCall)

```swift
} else if toolName == "gif_creator" {
    handleGifCreator(arguments: arguments, id: id, clientId: clientId)
}
```

#### handleGifCreator

Dispatched to a background queue (encoding can take 100ms–2s).

```swift
private func handleGifCreator(arguments: [String: Any], id: Any?, clientId: String) {
    guard let action = arguments["action"] as? String else {
        sendError(id: id, code: -32000, message: "action parameter is required", to: clientId)
        return
    }
    let tabId = (arguments["tabId"] as? Int) ?? -1  // -1 = "any tab" sentinel (no valid Safari tab ID is negative)

    switch action {
    case "start_recording":
        let msg = gifService.startRecording(tabId: tabId)
        sendResult(id: id, result: ["content": [["type": "text", "text": msg]]], to: clientId)

    case "stop_recording":
        let msg = gifService.stopRecording(tabId: tabId)
        sendResult(id: id, result: ["content": [["type": "text", "text": msg]]], to: clientId)

    case "clear":
        let msg = gifService.clearFrames(tabId: tabId)
        sendResult(id: id, result: ["content": [["type": "text", "text": msg]]], to: clientId)

    case "export":
        handleGifExport(arguments: arguments, tabId: tabId, id: id, clientId: clientId)

    default:
        sendError(id: id, code: -32000,
                  message: "Invalid action: \"\(action)\". Must be start_recording, stop_recording, export, or clear",
                  to: clientId)
    }
}
```

#### handleGifExport

```swift
private func handleGifExport(arguments: [String: Any], tabId: Int, id: Any?, clientId: String) {
    let rawFilename = arguments["filename"] as? String
    let timestamp = Int(Date().timeIntervalSince1970)
    let filename = rawFilename ?? "recording-\(timestamp).gif"

    let options = GifService.GifOptions(
        showClicks:    (arguments["options"] as? [String: Any])?["showClicks"]    as? Bool ?? true,
        showActions:   (arguments["options"] as? [String: Any])?["showActions"]   as? Bool ?? true,
        showProgress:  (arguments["options"] as? [String: Any])?["showProgress"]  as? Bool ?? true,
        showWatermark: (arguments["options"] as? [String: Any])?["showWatermark"] as? Bool ?? true
    )

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let self else { return }
        switch self.gifService.exportGIF(tabId: tabId, options: options, filename: filename) {
        case .failure(let error):
            self.sendError(id: id, code: -32000, message: "GIF encoding failed: \(error.localizedDescription)", to: clientId)
        case .success(let gifData):
            // 1. Write to Desktop
            let desktopURL = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Desktop/\(filename)")
            let writePath: String
            do {
                try gifData.write(to: desktopURL, options: .atomic)
                writePath = desktopURL.path
            } catch {
                writePath = "(file write failed: \(error.localizedDescription))"
            }
            // 2. Return base64 image + path text
            let base64 = gifData.base64EncodedString()
            let content: [[String: Any]] = [
                ["type": "image", "data": base64, "mimeType": "image/gif"],
                ["type": "text", "text": "GIF saved to \(writePath) (\(self.gifService.frameCount(tabId: tabId)) frames)"]
            ]
            self.sendResult(id: id, result: ["content": content], to: clientId)
        }
    }
}
```

#### Post-action frame capture hook

Called **only on success** — from the `.result` branch of `deliverExtensionResponse` (not the
`.error` branch), and from `handleScreenshotAction` only after a successful capture. A failed
computer action (extension returns an error) must NOT produce a GIF frame.

```swift
// In forwardToExtension response handling (computer actions only, action != "wait"):
// Called only from the `.result` (success) branch — never from `.error`.
private func maybeAddGifFrame(tabId: Int, action: String, coordinate: [Int]?) {
    guard gifService.isRecording(tabId: tabId) else { return }
    let seq = gifService.nextSequenceNumber()   // atomic, under lock
    screenshotService.captureScreenshot(tabId: tabId) { [weak self] result in
        guard let self, case .success(let img) = result else { return }
        self.gifService.addFrame(GifService.GifFrame(
            sequenceNumber: seq,
            imageData: img.data,
            actionType: action,
            coordinate: coordinate,
            timestamp: Date(),
            viewportWidth: img.viewportWidth,
            viewportHeight: img.viewportHeight
        ), tabId: tabId)
    }
    // Fire-and-forget: frame capture does not block MCP response
}
```

`screenshot` and `zoom` actions: `handleScreenshotAction` calls `maybeAddGifFrame` after
the native capture succeeds, passing `action: "screenshot"` or `action: "zoom"` with
`coordinate: nil`. Frame delay table uses the 0.3s "screenshot" entry for both.

#### Coordinate parsing

Coordinates extracted from MCP arguments using the existing NSNumber-tolerant pattern:
```swift
let coordinate: [Int]? = { /* same compactMap/NSNumber pattern as zoom region */ }()
```

---

## Data Flow

### Recording lifecycle

```
MCP: gif_creator { action: "start_recording", tabId: 5 }
  ToolRouter.handleGifCreator → gifService.startRecording(5)
  ← "Started recording browser actions for tab 5."

MCP: computer { action: "left_click", coordinate: [200, 300], tabId: 5 }
  ToolRouter → forwardToExtension (computer.js handles it)
  ← extension returns "Clicked at (200, 300)"
  ToolRouter post-action hook (fire-and-forget):
    gifService.isRecording(5) → true
    seq = gifService.nextSequenceNumber()    // e.g. seq=1
    screenshotService.captureScreenshot(5) [async]
      → gifService.addFrame({ seq:1, actionType:"left_click", coordinate:[200,300], ... }, 5)
  ← MCP response sent immediately (no wait for frame)

MCP: computer { action: "screenshot", tabId: 5 }
  ToolRouter → handleScreenshotAction (native)
  → screenshotService.captureScreenshot(5) → success
  → maybeAddGifFrame(tabId:5, action:"screenshot", coordinate:nil) [fire-and-forget]
  ← MCP response with screenshot image sent immediately
```

### Export

```
MCP: gif_creator { action: "export", tabId: 5, filename: "demo.gif" }
  ToolRouter.handleGifExport (on DispatchQueue.global):
    gifService.exportGIF(5, options, "demo.gif"):
      1. Acquire NSLock → snapshot frames array (sorted by sequenceNumber) → release lock
      2. For each frame in snapshot:
         a. PNG → CGImage
         b. Apply overlays via CGContext
         c. CGImageDestinationAddImage with delay metadata
      3. CGImageDestinationFinalize → Data
    Write to ~/Desktop/demo.gif
    Return base64 + path text
  ← MCP response: [image/gif base64, "GIF saved to ~/Desktop/demo.gif (12 frames)"]
```

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `action` missing | `isError: true`, "action parameter is required" |
| `action` invalid | `isError: true`, "Invalid action: \"<x>\". Must be start_recording, stop_recording, export, or clear" |
| Export with no frames | `isError: true`, "No frames recorded for tab <tabId>" |
| GIF encoding fails | `isError: true`, "GIF encoding failed: `<error>`" |
| Desktop write fails | Success with warning: path text says "(file write failed: `<error>`)" — base64 still returned |
| `start_recording` when already recording | Returns "Recording is already active for tab `<tabId>`." (not error) |
| `stop_recording` when not recording | Returns "Recording is not active for tab `<tabId>`." (not error) |
| `export` while recording | Valid — exports current frames, recording continues |
| `tabId` missing | Uses -1 as sentinel (single-tab fallback; no valid Safari tab ID is negative) |

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `ClaudeInSafari/Services/GifService.swift` | **Create** — recording state + frame buffer + GIF encoding |
| `ClaudeInSafari/MCP/ToolRouter.swift` | **Modify** — add `gif_creator` native dispatch, post-action hook, screenshot hook |
| `Tests/Swift/GifServiceTests.swift` | **Create** — Swift unit tests |
| `Tests/Swift/ToolRouterGifHookTests.swift` | **Create** — ToolRouter hook integration tests |
| `ROADMAP.md` | **Modify** — mark 017 ✅ on completion; add in-browser GIF delivery as future item |

**No changes required to:**
- `AppDelegate.swift` — GifService instantiated inline in ToolRouter (same as ScreenshotService)
- `SafariWebExtensionHandler.swift` — no new message types
- `manifest.json` — no new JS files
- `background.js` — no new scripts
- `tabs-manager.js` — resolveTabGroup not needed
- Any extension JS file
- `ClaudeInSafari.entitlements` — app is not sandboxed; Desktop writes work without additional
  entitlements. If App Store sandboxing is added in Phase 7, change write target to
  App Group container or add `com.apple.security.files.downloads.read-write`

---

## Future ROADMAP Item: In-Browser GIF Delivery

After `upload_image` (Spec 018) is implemented and the DataTransfer injection pattern
is validated in Safari, add a third export mode to `gif_creator`:

```
coordinate: [x, y]  →  inject GIF as File + dispatch dragenter/dragover/drop at (x, y)
```

This reuses the same IIFE and DataTransfer pattern from Spec 018. At that point,
`gif_creator export` will support three modes: Desktop save, MCP image response, and
in-browser drag-drop. The first two are delivered in this implementation.

**DataTransfer validation checkpoint:** Before implementing drag-drop delivery, verify
that `new DataTransfer()` is constructible in Safari 16.4+ content scripts. This is a
known Chrome/Safari divergence.

---

## Test Coverage

### GifService (GifServiceTests.swift)

| ID | Test |
|----|------|
| T1 | `startRecording` → `isRecording` true → `stopRecording` → `isRecording` false |
| T2 | `startRecording` twice → returns "already active" message (not error), state unchanged |
| T3 | `stopRecording` when not recording → returns "not active" message |
| T4 | `addFrame` 50 times → `frameCount` == 50; 51st evicts oldest (ring buffer) |
| T5 | `exportGIF` with zero frames → `.failure` with "No frames recorded" |
| T6 | `exportGIF` produces Data with GIF magic bytes (`47 49 46 38`, i.e. "GIF8") |
| T7 | `exportGIF` frame delay matches timing table for each action type |
| T8 | `clearFrames` → `frameCount` == 0, `isRecording` false |
| T9 | Concurrent `addFrame` calls from multiple threads → no crash, frameCount correct |
| T10 | `exportGIF` while `addFrame` runs concurrently → no data race (snapshot semantics) |
| T11 | Frames with out-of-order sequenceNumbers → sorted correctly in export |
| T12 | `exportGIF` with `showClicks: false` → no crash (overlay code path skipped) |

### ToolRouter GIF hook (ToolRouterGifHookTests.swift)

| ID | Test |
|----|------|
| T1 | `gif_creator start_recording` → returns success text, gifService.isRecording true |
| T2 | `gif_creator stop_recording` → returns "Stopped. Captured N frames." |
| T3 | Post-action hook: does NOT fire for `wait` action |
| T4 | Post-action hook: does NOT fire when `isRecording` false |
| T5 | Post-action hook: fires for `left_click` when recording — addFrame called |
| T6 | `handleScreenshotAction` calls `maybeAddGifFrame` when recording |
| T7 | `gif_creator export` returns `image/gif` content block + text block with file path |
| T8 | `gif_creator export` with no frames → `isError: true` |
| T9 | `gif_creator` with invalid action → `isError: true` |
| T10 | Post-action hook: does NOT fire when extension returns error response (`.error` branch) |
