# Spec 016 — resize_window

## Overview

`resize_window` resizes the Safari browser window to specified dimensions. This is useful
for testing responsive designs or setting up specific screen sizes for automation.

Unlike Chrome (which uses `chrome.windows.update()`), Safari MV2 does not expose a window
resize API. This tool is handled **natively** by the Swift app via AppleScript.

## Scope

- Native: `ClaudeInSafari/Services/AppleScriptBridge.swift`
- Router: `ClaudeInSafari/MCP/ToolRouter.swift` (handles natively, not forwarded to extension)
- Tool name: `"resize_window"`

## Tool Arguments

```ts
{
  width:  number;  // Target window width in pixels (required)
  height: number;  // Target window height in pixels (required)
  tabId?: number;  // Tab ID to identify which Safari window to resize.
                   //   If omitted, resizes the frontmost Safari window.
}
```

## Return Value

```ts
// Success
{
  content: [{
    type: "text",
    text: "Resized Safari window to <width>x<height> pixels"
  }]
}
```

## Implementation

### AppleScript Execution

The native app executes AppleScript to resize the Safari window:

```applescript
tell application "Safari"
    set bounds of window 1 to {x, y, x + width, y + height}
end tell
```

Where `{x, y}` is the window's current top-left position (preserved during resize).

### Window Resolution

Unlike most tools, `resize_window` is a **native tool** but needs tab/window information
from the extension. The architecture routes through the extension first:

If `tabId` is provided:
1. The extension resolves the virtual tab ID to a real tab ID via `globalThis.resolveTab`.
2. The extension calls `browser.tabs.get(realTabId)` to get the `windowId`.
3. The extension calls `browser.windows.getAll({ populate: false })` and finds the
   0-based index of the matching window (sorted by window ID).
4. The extension sends the **1-based window index** (AppleScript uses 1-based) plus the
   requested `width` and `height` to the native app via native messaging.
5. The native app executes AppleScript with `window <index>`.

If `tabId` is omitted:
1. Resize the frontmost Safari window (`window 1` in AppleScript).

**Note:** `browser.windows` IDs are not the same as AppleScript window indices. The
mapping above (sort by window ID, find index) is the only reliable cross-API bridge.
This mapping can break if windows are opened/closed between the query and the AppleScript
call — document this as an inherent race condition.

### Dimension Validation

- `width` and `height` must be positive integers.
- Minimum: 200 × 200 (Safari's practical minimum).
- Maximum: 7680 × 4320 (8K resolution limit, matching Chrome).
- Dimensions are truncated to integers (Swift `Int(dimension)`).
- The actual window size may differ slightly from requested due to macOS window manager
  constraints (menu bar, Dock, screen edges).

### Position Preservation

When resizing, the window's **top-left corner** remains in place. Only the width and
height change. This prevents the window from jumping to a new position during automation.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `width` or `height` missing | `isError: true`, "Both width and height parameters are required" |
| Non-numeric width/height | `isError: true`, "Width and height must be numbers" |
| Width or height ≤ 0 | `isError: true`, "Width and height must be positive numbers" |
| Exceeds 7680 × 4320 | `isError: true`, "Dimensions exceed 8K resolution limit" |
| Width < 200 | `isError: true`, "Width must be at least 200 pixels" |
| Height < 200 | `isError: true`, "Height must be at least 200 pixels" |
| Safari window is fullscreen | `isError: true`, "Cannot resize a fullscreen window. Exit fullscreen first." |
| Accessibility permission not granted | `isError: true`, "Accessibility permission required. Grant access in System Settings > Privacy & Security > Accessibility." |
| No Safari window found | `isError: true`, "No Safari window found" |
| AppleScript execution fails | `isError: true`, "Failed to resize window: `<error>`" |
| Tab not found | `isError: true`, "Tab not found: `<tabId>`" |

## Safari Considerations

### ⚠ Accessibility Permission Required

AppleScript control of other applications requires the **Accessibility** permission in
System Settings > Privacy & Security > Accessibility. The native app must be listed and
toggled on.

**Impact:** First-time users must grant an additional system permission (beyond Screen
Recording for screenshots). This is a macOS sandboxing requirement that Chrome doesn't
face — Chrome's `windows.update()` API works without any OS-level permissions.

**Mitigation:**
- The native app's setup wizard (Phase 7) should detect missing Accessibility permission
  and guide the user.
- The error message should include the exact System Settings path.
- Consider requesting the `com.apple.security.temporary-exception.apple-events` entitlement
  targeting Safari specifically, which may reduce the permission scope.

### ⚠ Entitlement Requirement

To send Apple Events to Safari, the app needs either:
1. `com.apple.security.temporary-exception.apple-events` entitlement with
   `com.apple.Safari` as the target, OR
2. Full `com.apple.security.automation.apple-events` entitlement (broader scope).

For App Store distribution (Phase 7), Apple may require justification for this entitlement.

### ✅ Safari Enhancement: Window Positioning

AppleScript can set both position **and** size via `bounds`. A future enhancement could
expose `x` and `y` parameters to move the window, which Chrome's `windows.update()` also
supports but is less reliable cross-platform.

### ✅ Safari Enhancement: Fullscreen Toggle

AppleScript can enter/exit fullscreen mode in Safari. A future `fullscreen: boolean`
parameter could toggle this, which is not available in Chrome's extension API.

### Window Dimensions vs Viewport Dimensions

`resize_window` sets the **window** dimensions (including Safari's title bar and toolbar),
not the **viewport** (content area) dimensions. The viewport will be smaller than the
requested size by the toolbar height (~74–88px) and any sidebar width.

Chrome's `windows.update()` has the same behavior — it sets outer window dimensions.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Resize by width/height | ✅ | ✅ | None |
| Dimension validation | ✅ | ✅ | None |
| 8K max limit | ✅ | ✅ | None |
| No extra permissions needed | ✅ | ❌ | Accessibility permission required |
| Works programmatically | `chrome.windows.update` | AppleScript | Different mechanism, same result |
| Window positioning | ✅ | Future | Could add x/y parameters |
| Fullscreen toggle | ❌ | Future | Safari advantage via AppleScript |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | `width: 1024, height: 768` | Window resized to 1024×768 |
| T2 | `width: 375, height: 812` (iPhone viewport) | Window resized to mobile dimensions |
| T3 | `width: 1920, height: 1080` | Window resized to 1080p |
| T4 | Missing `width` | `isError: true` |
| T5 | Missing `height` | `isError: true` |
| T6 | `width: -100, height: 500` | `isError: true`, not positive |
| T7 | `width: 10000, height: 10000` | `isError: true`, exceeds 8K limit |
| T8 | `width: 100, height: 100` | `isError: true`, below minimum |
| T9 | No Accessibility permission | `isError: true` with instructions |
| T10 | No Safari window open | `isError: true` |
| T11 | Resize preserves window position | Top-left corner unchanged |
| T12 | `width: 1024.7, height: 768.3` | Truncated to 1024×768 |
| T13 | Safari window in fullscreen mode | `isError: true`, cannot resize fullscreen |
| T14 | `width: 100, height: 500` | `isError: true`, width below minimum (per-axis) |
