# gif_creator — Revised Architecture Design

**Date:** 2026-03-12
**Spec reference:** Specs/017-gif-creator.md
**Status:** Approved for implementation planning

---

## Context

`gif_creator` is the next feature in Phase 6 (Monitoring & Advanced Tools → v0.4.0). It records
animated GIFs of browser automation sessions by capturing a screenshot after each `computer`
action and encoding the frame sequence into a deliverable GIF.

This document describes the **revised architecture** that supersedes several assumptions in the
written spec (Specs/017-gif-creator.md). The key revision: all frame capture and GIF encoding
moves to the native layer. The extension side is a thin command coordinator.

---

## Revised vs. Written Spec

| Written Spec Assumption | Revised Decision | Reason |
|------------------------|-----------------|--------|
| `globalThis.gifRecorder` JS inter-module contract | **Removed** | Not needed; capture is native-side |
| `computer.js` checks `gifRecorder.isRecording()` | **Removed** | ToolRouter post-action hook replaces this |
| Frames persisted to App Group container files | **In-memory GifService** (same pattern as ScreenshotService) | Native app does not suspend; file I/O is unnecessary complexity |
| gif.js Web Worker library in extension | **Removed** | Native ImageIO is more reliable and already used by ScreenshotService |
| `browser.storage.session` for recording state | **Removed** | Recording state lives in `GifService.swift` in-memory |
| `globalThis.resolveTabGroup` new export needed | **Retained** | `gif-creator.js` still needs tabGroupId to scope native messages |

---

## Component Responsibilities

### 1. `gif-creator.js` (extension background)

Thin MCP tool handler. Validates args, resolves `tabId → tabGroupId`, sends native messages,
delivers the exported GIF to the user. Contains **no frame capture logic**.

Registers the `"gif_creator"` tool via `globalThis.registerTool`.

**Native messages sent:**

| Action | Message type | Payload |
|--------|-------------|---------|
| `start_recording` | `"gif_start"` | `{ tabGroupId }` |
| `stop_recording` | `"gif_stop"` | `{ tabGroupId }` |
| `export` | `"gif_export"` | `{ tabGroupId, download, coordinate?, filename?, options? }` |
| `clear` | `"gif_clear"` | `{ tabGroupId }` |

**GIF delivery after `export`:**

- `download: true` → extension receives base64 GIF, creates an `<a download>` element in the
  active tab via `executeScript`, clicks it, removes it.
- `coordinate: [x, y]` → extension receives base64 GIF, injects it as a `File` object via
  `DataTransfer` and dispatches `dragenter → dragover → drop` at the coordinate using
  `executeScript`. Same DataTransfer pattern as Spec 018 (`upload_image`).

### 2. `GifService.swift` (new native service)

Owns all GIF-related state and logic. Follows `ScreenshotService` patterns (NSLock, in-memory
store, ring buffer eviction).

```swift
class GifService {

    struct GifFrame {
        let imageData: Data       // PNG-encoded, from ScreenshotService
        let actionType: String    // e.g. "left_click", "scroll", "type"
        let coordinate: [Int]?    // action coordinate if present
        let timestamp: Date
        let viewportWidth: Int
        let viewportHeight: Int
    }

    struct GifOptions {
        var showClicks: Bool    = true
        var showActions: Bool   = true
        var showProgress: Bool  = true
        var showWatermark: Bool = true
        var filename: String    = "recording-<timestamp>.gif"
    }

    // Recording lifecycle
    func startRecording(tabGroupId: Int) -> String
    func stopRecording(tabGroupId: Int) -> String
    func isRecording(tabGroupId: Int) -> Bool

    // Frame management (called by ToolRouter post-action hook)
    func addFrame(_ frame: GifFrame, tabGroupId: Int)   // enforces 50-frame ring buffer

    // Export
    func exportGIF(tabGroupId: Int, options: GifOptions) -> Result<Data, Error>

    // Housekeeping
    func clearFrames(tabGroupId: Int) -> String
    func frameCount(tabGroupId: Int) -> Int   // for "Stopped. Captured N frames." message
}
```

**GIF encoding** uses ImageIO:
- `CGImageDestinationCreateWithData(mutableData, kUTTypeGIF, frameCount, nil)`
- One `CGImageDestinationAddImage(dest, cgImage, frameProperties)` per frame, where
  `frameProperties` sets `kCGImagePropertyGIFDelayTime` based on action type (per Spec 017
  timing table: click=1.5s, scroll/type/navigate=0.8s, screenshot=0.3s)
- `CGImageDestinationFinalize(dest)` → returns `Data`

**Visual overlays** applied to each frame before encoding:
- `showClicks`: red circle + ripple ring at click coordinate (via `CGContext` arc drawing)
- `showActions`: filled rect label bar at bottom with action text
- `showProgress`: thin progress bar at top (frame N of total)
- `showWatermark`: "Recorded with Claude" text in bottom-right corner

All overlay rendering uses `CGContext` drawing into a copy of the frame's bitmap.

### 3. `ToolRouter.swift` (post-action hook)

After routing any `computer` action (action type ≠ `"wait"`) and receiving a success response
from the extension, ToolRouter checks `GifService.isRecording(tabGroupId)`. If true, it fires
a screenshot capture asynchronously (fire-and-forget — does not block the MCP response):

```swift
// Called after computer action succeeds, before returning response to MCP client
func maybeCapturGifFrame(action: String, coordinate: [Int]?, tabId: Int, tabGroupId: Int) {
    guard action != "wait", gifService.isRecording(tabGroupId) else { return }
    screenshotService.captureScreenshot(tabId: tabId) { [weak self] result in
        guard let self, case .success(let img) = result else { return }
        // failures silently dropped — recording degrades gracefully
        let frame = GifService.GifFrame(
            imageData: img.data,
            actionType: action,
            coordinate: coordinate,
            timestamp: Date(),
            viewportWidth: img.viewportWidth,
            viewportHeight: img.viewportHeight
        )
        self.gifService.addFrame(frame, tabGroupId: tabGroupId)
    }
}
```

**Zero latency impact** on computer actions from the MCP client's perspective: the response
is sent immediately and frame capture races independently.

### 4. `tabs-manager.js` — new `globalThis.resolveTabGroup` export

Small addition: `gif-creator.js` needs to scope frames to a tab group, not an individual tab.

```js
// Added to tabs-manager.js, exported via globalThis per inter-module contract rules
globalThis.resolveTabGroup = async function(virtualTabId) {
    // Returns the groupId containing the given virtual tab, or throws if not found
};
```

---

## Data Flow

### Recording

```
MCP: gif_creator { action: "start_recording", tabId: 5 }
  gif-creator.js:
    resolveTabGroup(5) → groupId=2
    sendNativeMessage({ type: "gif_start", tabGroupId: 2 })
  GifService.startRecording(2) → "Started recording..."
  ← "Started recording browser actions for this tab group."

MCP: computer { action: "left_click", coordinate: [200, 300], tabId: 5 }
  computer.js: executeScript → success "Clicked at (200, 300)"
  ToolRouter (post-action):
    gifService.isRecording(2) → true
    screenshotService.captureScreenshot(tabId: 5) [async, fire-and-forget]
      → gifService.addFrame({ actionType:"left_click", coordinate:[200,300], ... }, 2)
  ← "Clicked at (200, 300)"   ← response sent immediately, no wait for frame
```

### Export (download)

```
MCP: gif_creator { action: "export", tabId: 5, download: true, filename: "demo.gif" }
  gif-creator.js:
    resolveTabGroup(5) → groupId=2
    sendNativeMessage({ type: "gif_export", tabGroupId: 2, download: true,
                        filename: "demo.gif", options: {...} })
  GifService.exportGIF(2, options):
    1. Retrieve 10 frames for groupId 2
    2. For each frame:
       a. Decode PNG → CGImage
       b. Apply overlays via CGContext
       c. CGImageDestinationAddImage with delay metadata
    3. CGImageDestinationFinalize → Data
    4. Return base64(Data)
  gif-creator.js receives base64 GIF:
    executeScript in active tab:
      const a = document.createElement('a')
      a.href = 'data:image/gif;base64,' + gifData
      a.download = 'demo.gif'
      document.body.appendChild(a); a.click(); a.remove()
  ← "GIF exported and downloaded as demo.gif"
```

### Export (drag-drop)

```
MCP: gif_creator { action: "export", tabId: 5, coordinate: [400, 300] }
  ... same encoding path ...
  gif-creator.js receives base64 GIF:
    executeScript in active tab:
      const bytes = Uint8Array.from(atob(gifData), c => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: "image/gif" })
      const file = new File([blob], filename, { type: "image/gif" })
      const dt = new DataTransfer()
      dt.items.add(file)
      const target = document.elementFromPoint(400, 300)
      target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }))
      target.dispatchEvent(new DragEvent("dragover",  { dataTransfer: dt, bubbles: true }))
      target.dispatchEvent(new DragEvent("drop",      { dataTransfer: dt, bubbles: true }))
  ← "GIF uploaded to page at (400, 300)"
```

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `action` missing | `isError: true`, "action parameter is required" |
| `tabId` missing | `isError: true`, "tabId parameter is required" |
| `tabId` not found | `isError: true`, "Tab `<tabId>` not found" |
| Export with no frames | `isError: true`, "No frames recorded for this tab group" |
| Export without `coordinate` or `download` | `isError: true`, "Provide coordinate for drag-drop or set download: true" |
| Both `coordinate` and `download` | `isError: true`, "Provide coordinate or download, not both" |
| GIF encoding fails | `isError: true`, "GIF encoding failed: `<error>`" |
| Drag-drop at coordinate with no element | `isError: true`, "No element at (`<x>`, `<y>`)" |
| Frame capture failure during recording | Silently skipped — GIF may have fewer frames |
| Already recording on `start_recording` | Returns "Recording is already active..." (not error) |
| Not recording on `stop_recording` | Returns "Recording is not active..." (not error) |

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `ClaudeInSafari Extension/Resources/tools/gif-creator.js` | **Create** — thin tool handler |
| `ClaudeInSafari/Services/GifService.swift` | **Create** — recording state + encoding |
| `ClaudeInSafari/ToolRouter.swift` | **Modify** — add post-action frame capture hook |
| `ClaudeInSafari Extension/Resources/tools/tabs-manager.js` | **Modify** — add `resolveTabGroup` export |
| `ClaudeInSafari Extension/Resources/manifest.json` | **Modify** — add gif-creator.js to background.scripts |
| `ClaudeInSafari Extension/Resources/background.js` | **Modify** — update load-order comment |
| `Tests/JS/gif-creator.test.js` | **Create** — JS unit tests |
| `ClaudeInSafarisTests/GifServiceTests.swift` | **Create** — Swift unit tests |
| `ROADMAP.md` | **Modify** — mark 017 ✅ on completion |

---

## Key Constraints

- `ScreenshotService` requires **Screen Recording permission** and **Safari must be frontmost** —
  frame capture silently fails if either condition is unmet; this is documented behavior
- Frame capture is **fire-and-forget**: the MCP client gets the computer action response
  immediately; a slow or failed screenshot does not propagate an error
- The 50-frame ring buffer matches the Chrome extension's cap
- `export` while recording is active is valid — exports current frames, recording continues
- `GifService` must be injected into `ToolRouter` at app startup (same pattern as `ScreenshotService`)
- The drag-drop delivery path in `gif-creator.js` is intentionally consistent with Spec 018
  (`upload_image`) so the same DataTransfer injection pattern is reused when that tool is built

---

## Test Coverage

### JS (gif-creator.test.js)
- T1–T4: start/stop recording state (idempotent calls)
- T5–T8: export argument validation (no frames, missing delivery mode, both modes)
- T9: clear action
- T10–T11: tabId validation errors
- T12–T13: native message payloads for start/export are correctly formed
- T14: resolveTabGroup called with correct tabId

### Swift (GifServiceTests.swift)
- T1: startRecording / isRecording / stopRecording lifecycle
- T2: addFrame ring buffer eviction at 50 frames
- T3: exportGIF with zero frames returns error
- T4: exportGIF produces valid GIF Data (magic bytes `47 49 46 38`)
- T5: frame delay metadata matches action type timing table
- T6: clearFrames discards buffer and stops recording
- T7: concurrent addFrame calls are thread-safe (NSLock)
- T8: overlays rendered without crash (smoke test)
