# Spec 011 — computer (Screenshot)

## Overview

The `screenshot` and `zoom` actions of the `computer` tool capture visual snapshots of the
Safari window. Unlike Chrome (which uses `chrome.tabs.captureVisibleTab`), Safari uses
**ScreenCaptureKit** in the native Swift app because Safari's `browser.tabs.captureVisibleTab`
is unreliable and often returns blank or stale images.

This spec covers the native-side implementation in `ScreenshotService.swift` and the
`ToolRouter` integration. The extension JavaScript (`computer.js`) delegates these actions
to the native app.

## Scope

- Native: `ClaudeInSafari/Services/ScreenshotService.swift`
- Router: `ClaudeInSafari/MCP/ToolRouter.swift` (intercepts `action: "screenshot"` / `"zoom"`)
- Extension: `ClaudeInSafari Extension/Resources/tools/computer.js` (delegates to native)
- Tool name: `"computer"` (actions `"screenshot"` and `"zoom"` only)

## Tool Arguments

### screenshot

```ts
{
  action: "screenshot";
  tabId?: number;  // Virtual tab ID. Defaults to active tab.
}
```

### zoom

```ts
{
  action: "zoom";
  region: [number, number, number, number];  // [x0, y0, x1, y1] viewport pixels
  tabId?: number;
}
```

## Return Value

```ts
// screenshot
{
  content: [
    {
      type: "image",
      data: string,      // Base64-encoded PNG
      mediaType: "image/png"
    },
    {
      type: "text",
      text: "Screenshot captured (imageId: <uuid>). Use this imageId with upload_image."
    }
  ]
}

// zoom
{
  content: [
    {
      type: "image",
      data: string,      // Base64-encoded PNG of the cropped+scaled region
      mediaType: "image/png"
    },
    {
      type: "text",
      text: "Zoomed region [x0, y0, x1, y1] (imageId: <uuid>)."
    }
  ]
}
```

The `imageId` is included in a text content block so that `upload_image` (Spec 018)
callers can reference the captured image later.

## Image Storage

Each captured screenshot is stored in-memory in `ScreenshotService` with a UUID identifier
(`imageId`). This allows `upload_image` (Spec 018) and `gif_creator` (Spec 017) to
reference previously captured screenshots.

```swift
struct CapturedImage {
    let imageId: String       // UUID
    let data: Data            // PNG data
    let timestamp: Date
    let viewportWidth: Int
    let viewportHeight: Int
}
```

- Maximum stored images: **50**. When exceeded, the oldest image is evicted.
- The `capturedImages` dictionary must be protected by a serial `DispatchQueue` or
  `NSLock`, since `ScreenshotService` is accessed from `ToolRouter`'s GCD dispatch queue.
  Follow the `pendingRequestsLock` pattern in `ToolRouter.swift`.

## ScreenCaptureKit Implementation

### Safari Window Discovery

1. Use `SCShareableContent.getWithCompletionHandler` to enumerate on-screen windows.
2. Filter for windows owned by Safari (`bundleIdentifier == "com.apple.Safari"`).
3. If `tabId` maps to a specific Safari window, capture that window.
4. If no specific window: capture the frontmost Safari window.

### Capture Pipeline

```
SCShareableContent → SCWindow (Safari) → SCContentFilter → SCScreenshotManager.captureImage
    → CGImage → crop to content area → scale for MCP → PNG Data → Base64
```

1. Create `SCContentFilter` for the target Safari window.
2. Configure `SCStreamConfiguration`:
   - `width` / `height`: match the window's content area (exclude title bar, toolbar).
   - `scaleFactor`: use the display's native scale (2x for Retina).
   - `pixelFormat`: kCVPixelFormatType_32BGRA.
3. Use `SCScreenshotManager.captureImage(contentFilter:configuration:)` (macOS 14+)
   or fall back to `SCStream` single-frame capture (macOS 13).
4. Crop the resulting `CGImage` to exclude Safari's toolbar/address bar.
5. Scale to a reasonable MCP output size (max 1280px wide, preserving aspect ratio).
6. Encode as PNG.

### Toolbar Cropping

Safari's toolbar height varies depending on:
- Tab bar visibility (compact vs separate tab bar)
- Favorites bar visibility
- Whether the address bar is at the top or bottom (Safari 17+)

**Strategy:** Use Accessibility API (`AXUIElement`) to query Safari's web content area
frame. This is the primary approach and must be attempted first. Fall back to a heuristic
offset of 74px from the window top only if the AX query fails (permission denied, AX
unavailable). The heuristic is approximate and will over/under-crop by up to 14px.

### Response Delivery Path

Since `screenshot` and `zoom` are native-handled (not forwarded to the extension),
`ToolRouter.swift` must call `sendResult(id:result:to:)` directly after
`ScreenshotService` returns, bypassing the file-polling path used for extension-handled
tools. The result dictionary must include the `content` array with both the image block
and the text block containing the `imageId`.

### ScreenshotService Internal Timeout

`SCScreenshotManager.captureImage` is asynchronous. If ScreenCaptureKit hangs (e.g.,
permission revoked mid-session), the 30-second `ToolRouter` poll deadline would eventually
fire, but the SCKit completion handler may never be called. `ScreenshotService` must
implement a 10-second internal timeout using `DispatchQueue.asyncAfter` that cancels the
in-flight capture and returns an error.

### Pre-Flight Permission Check

At app startup, call `CGPreflightScreenCaptureAccess()` to check Screen Recording
permission and store the result. This allows the first screenshot call to return an
immediately actionable error rather than timing out if SCKit doesn't fail fast.

### zoom Action

1. Capture a full screenshot (same pipeline as above).
2. Validate the `region` rectangle: `x0 < x1` and `y0 < y1` (not inverted). Coordinates
   are relative to the web content area (after toolbar cropping), not the full window.
3. Crop to the `region` rectangle `[x0, y0, x1, y1]`.
4. Scale the cropped region to fill the standard output dimensions (1280px wide).
5. This provides a "magnified" view of a specific page area.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Screen Recording permission not granted | `isError: true`, "Screen Recording permission required. Grant access in System Settings > Privacy & Security > Screen Recording." |
| No Safari window found | `isError: true`, "No Safari window found" |
| ScreenCaptureKit unavailable (macOS < 13) | `isError: true`, "Screenshots require macOS 13.0 or later" |
| `region` invalid or out of bounds (zoom) | `isError: true`, "Invalid region: coordinates out of bounds" |
| `region` missing for zoom action | `isError: true`, "region parameter is required for zoom action" |
| Capture fails (transient) | `isError: true`, "Screenshot capture failed: `<SCError>`" |
| Tab not found | `isError: true`, "Tab not found: `<tabId>`" |

## Safari Considerations

### ⚠ Screen Recording Permission Required

ScreenCaptureKit requires the user to grant **Screen Recording** permission in
System Settings > Privacy & Security > Screen Recording. This is a one-time system prompt
on first use, but the user must explicitly toggle the switch and may need to restart the app.

**Impact:** First-time setup is more complex than Chrome, which only needs the `activeTab`
extension permission for `captureVisibleTab`. Users may be confused by the system-level
permission request.

**Mitigation:** The native app's setup wizard (Phase 7) should detect missing permission
and guide the user through granting it. The error message should include specific
instructions.

### ✅ Safari Enhancement: Background Window Capture

Unlike Chrome's `captureVisibleTab` (which only captures what's on screen),
ScreenCaptureKit can capture a Safari window **even when it is behind other windows** or
partially obscured. This means screenshots work when:
- Safari is not the frontmost app
- The Safari window is partially covered by Terminal or other apps
- The user is watching Claude Code output in Terminal while automation runs

This is a significant advantage over Chrome for the common workflow of watching CLI output
while Claude automates the browser.

### ✅ Safari Enhancement: Retina Resolution

ScreenCaptureKit captures at the display's native scale factor. On Retina displays (2x),
this produces 2× resolution screenshots. The output is scaled down to 1280px wide for MCP
transport, but the source data is sharper than Chrome's 1× `captureVisibleTab` output.

### macOS Version Compatibility

| macOS Version | API Available | Notes |
|---------------|---------------|-------|
| 13 (Ventura) | `SCStream` single-frame | Works but slightly slower |
| 14 (Sonoma)+ | `SCScreenshotManager` | Preferred — single-call API |

The deployment target is macOS 13.0 (STRUCTURE.md). Both paths must be implemented.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Screenshot capture | `captureVisibleTab` | ScreenCaptureKit | Different mechanism, same result |
| Works when browser in background | ❌ | ✅ | Safari is better |
| Retina resolution | ❌ (1×) | ✅ (2×) | Safari is better |
| Zoom (region crop + scale) | ✅ | ✅ | Parity |
| No extra permissions needed | ✅ | ❌ | Screen Recording required |
| Image ID for later reference | ✅ | ✅ | Parity |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | `action: "screenshot"` with Safari open | Returns base64 PNG image |
| T2 | `action: "screenshot"` with Safari behind another window | Still captures correctly |
| T3 | `action: "zoom", region: [0, 0, 640, 480]` | Returns cropped+scaled PNG |
| T4 | `action: "zoom"` without `region` | `isError: true` |
| T5 | `action: "zoom", region: [0, 0, 99999, 99999]` | `isError: true`, out of bounds |
| T6 | Screenshot without Screen Recording permission | `isError: true` with permission instructions |
| T7 | No Safari window open | `isError: true` |
| T8 | Screenshot stores imageId for later use | `imageId` in stored `CapturedImage` |
| T9 | 51st screenshot evicts oldest from storage | Only 50 stored |
| T10 | `action: "screenshot"` on macOS 13 | Uses SCStream fallback |
| T11 | `action: "screenshot"` on macOS 14+ | Uses SCScreenshotManager |
| T12 | `action: "zoom", region: [0, 0, 10, 10]` (minimum) | Returns small PNG |
| T13 | `action: "zoom", region: [500, 500, 100, 100]` (inverted) | `isError: true` |
| T14 | ScreenshotService timeout (SCKit hangs) | Returns error within 10s |
| T15 | Multiple Safari windows, specific `tabId` | Correct window captured |
| T16 | Screen Recording revoked between calls | Error on second call |
| T17 | `imageId` retrievable by `upload_image` caller | Stored and accessible |
