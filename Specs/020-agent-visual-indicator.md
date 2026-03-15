# Spec 020 — Agent Visual Indicator

## Overview

The agent visual indicator provides visual feedback to the user when Claude is actively
automating the browser. It renders a pulsing orange glow border around the viewport and
a "Stop Claude" button centered at the bottom of the page. This matches Chrome's
implementation while adding macOS-native enhancements.

## Scope

- Content script: `ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js`
  (already exists as placeholder)
- Native: `AppDelegate.swift` (macOS Notification Center integration)
- Tool name: N/A — this is not an MCP tool. It is a visual overlay activated/deactivated
  by the background script during automation.

## Visual Design

### Glow Border

A `position: fixed` overlay covering the entire viewport with:
- `pointer-events: none` (does not intercept clicks).
- `z-index: 2147483646` (below the Stop button, above page content).
- Inset box-shadow with pulsing orange glow (color: `rgba(217, 119, 87, ...)`).
- CSS animation: `claude-pulse` — 2s ease-in-out infinite cycle between subtle and
  prominent glow.

```css
@keyframes claude-pulse {
  0%, 100% {
    box-shadow:
      inset 0 0 10px rgba(217, 119, 87, 0.5),
      inset 0 0 20px rgba(217, 119, 87, 0.3),
      inset 0 0 30px rgba(217, 119, 87, 0.1);
  }
  50% {
    box-shadow:
      inset 0 0 15px rgba(217, 119, 87, 0.7),
      inset 0 0 25px rgba(217, 119, 87, 0.5),
      inset 0 0 35px rgba(217, 119, 87, 0.2);
  }
}
```

### Stop Button

A `position: fixed` button centered at the bottom of the viewport:
- `z-index: 2147483647` (highest, above glow border).
- `pointer-events: auto` (clickable).
- Slides up from below the viewport with a CSS transform animation on show.
- Styled with system font, rounded corners, subtle border — matches the Chrome design.
- Contains a stop icon (SVG octagonal stop) + "Stop Claude" text.

### Show/Hide Transitions

- **Show:** Glow border fades in (`opacity: 0 → 1`, 300ms ease). Stop button slides up
  from below (`translateY(100px) → translateY(0)`, 300ms ease).
- **Hide:** Reverse transitions. Glow fades out, button slides down.

## Activation API

The background script controls the indicator via `browser.tabs.sendMessage`:

```js
// Activate indicator on a tab
browser.tabs.sendMessage(tabId, {
  type: "CLAUDE_AGENT_INDICATOR",
  action: "show"    // or "hide"
});
```

The content script listens for these messages and toggles the overlay.

### When to Activate

The background script shows the indicator inside `pollForRequests` in `background.js`:

1. **Show:** at the start of Phase 3 (after `payload` is parsed, before `executeTool` is called).
2. **Hide:** after Phase 3 completes (success or error), debounced 500ms.
3. **Debounce:** maintain a `hideIndicatorTimer` variable. On each tool start, cancel any
   pending hide timer (so rapid back-to-back calls keep the indicator visible). On each
   completion, schedule `hideIndicatorTimer = setTimeout(hideOnAllTabs, 500)`.
4. **Tab ID:** read from `payload.args?.tabId`; if absent, skip indicator (background-only tool).

### Tool-Use Suppression

During `screenshot` and `zoom` actions, the indicator must be **temporarily hidden** so
the orange glow border doesn't appear in captured images. The background script sends:

```js
browser.tabs.sendMessage(tabId, { type: "CLAUDE_AGENT_INDICATOR", action: "hide_for_tool" });
// ... perform screenshot ...
browser.tabs.sendMessage(tabId, { type: "CLAUDE_AGENT_INDICATOR", action: "show_after_tool" });
```

`hide_for_tool` hides immediately (no transition). `show_after_tool` restores immediately.

## Static Indicator Mode

Chrome implements a **second indicator mode** — a persistent pill-shaped status bar shown
whenever any tab is part of an active Claude session, even between tool calls. This
provides ambient awareness ("Claude is active in this tab group") without the urgency of
the pulsing glow.

### Static Indicator Visual Design

A fixed-position pill bar at the bottom of the viewport:
- Background: semi-transparent with backdrop blur.
- Contains: Claude icon + "Claude is active in this tab group" text + "Chat" button +
  "Dismiss" button.
- **"Chat" button behavior:** calls `browser.tabs.create({ url: 'https://claude.ai' })`
  to open Claude.ai in a new tab.
- Lower z-index than the agent glow border (visible between tool calls, hidden during
  active tool execution when the agent indicator is shown).

### Static Indicator Message Types

```js
// Show static indicator (session start or tab added to group)
browser.tabs.sendMessage(tabId, {
  type: "CLAUDE_STATIC_INDICATOR",
  action: "show"
});

// Hide static indicator (session end or all tabs removed from group)
browser.tabs.sendMessage(tabId, {
  type: "CLAUDE_STATIC_INDICATOR",
  action: "hide"
});

// Dismiss for the current group (user clicked dismiss)
browser.runtime.sendMessage({
  type: "DISMISS_STATIC_INDICATOR_FOR_GROUP"
});
```

### Heartbeat Mechanism

The content script runs a heartbeat (`setInterval`, every 5 seconds) while the static
indicator is visible. On each tick:

```js
browser.runtime.sendMessage(
  { type: "STATIC_INDICATOR_HEARTBEAT" },
  response => {
    if (!response || !response.success) hideStaticIndicator();
  }
).catch(() => {
  // Background page suspended — hide immediately
  hideStaticIndicator();
});
```

**Critical:** With `persistent: false`, if the background page is suspended,
`browser.runtime.sendMessage` **throws** (connection error). It does not time out. The
heartbeat must use `.catch()` to detect this and auto-hide immediately, not after a
delay.

## Stop Button Behavior

When the user clicks "Stop Claude":

1. The content script sends a message to the background script:
   ```js
   browser.runtime.sendMessage({ type: "STOP_AGENT" });
   ```
   If the background page is suspended when Stop is clicked, `sendMessage` will throw —
   the content script must catch this and still hide the indicator locally.

2. The background script:
   a. Hides the indicator on all tabs in the active group.
   b. If a tool call is currently in-flight (i.e. `currentRequestId` is set), sends an
      error `tool_response` for that requestId via the existing native IPC:
      ```js
      await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
        type: "tool_response",
        requestId: currentRequestId,
        error: { content: [{ type: "text", text: "Cancelled by user" }] }
      });
      ```
   c. Clears `currentRequestId`.

3. `ToolRouter.swift` receives the error `tool_response` through its normal poll loop and
   delivers the error to the MCP client — no new native message type required.

### Scope of Cancellation (PR A)

This approach cancels extension-forwarded tool calls (the majority). Native-handled tools
(`computer(screenshot)`, `gif_creator`, `resize_window`, `file_upload`) run to completion
since they execute entirely in Swift; the CLI receives the result but can choose to ignore
it after receiving the preceding error. Full native-side cancellation is deferred to PR B.

### `currentRequestId` Lifecycle

Background.js maintains a module-level `currentRequestId` variable:
- Set to `payload.requestId` at the start of Phase 3 (before `executeTool`).
- Cleared (`null`) after Phase 3 completes (success, error, or cancelled).
- The Stop handler checks for `null` before sending the error response (guard against
  double-send if Stop is clicked after the tool already completed).

## Content Script Details

### Installation Guard

```js
if (window.__claudeVisualIndicatorInstalled) return;
window.__claudeVisualIndicatorInstalled = true;
```

### DOM Element IDs

- `claude-agent-glow-border` — the glow overlay div
- `claude-agent-stop-container` — the stop button container div
- `claude-agent-stop-button` — the stop button element
- `claude-agent-animation-styles` — the injected `<style>` element

### Shadow DOM Isolation (Required)

The indicator **must** render inside a Shadow DOM root with `mode: "closed"` to:
1. Prevent page CSS from interfering with the indicator's styling (pages with
   `* { all: unset }` or aggressive CSS resets).
2. Prevent page JavaScript from accessing or removing the indicator elements.

```js
const host = document.createElement("div");
host.id = "claude-agent-indicator-host";
const shadow = host.attachShadow({ mode: "closed" });
// Render glow border, stop button, and static indicator inside shadow
// CSS animations (@keyframes claude-pulse) go in an adoptedStyleSheet
document.body.appendChild(host);
```

Chrome does **not** use Shadow DOM (it injects into `document.body` directly). This is
a Safari enhancement for robustness.

### Injection Timing

The content script runs at `document_idle` (manifest.json) and `all_frames: false`
(top frame only). This is correct — the indicator should only appear once per page,
not in each iframe.

## macOS Notification Center Integration

### ✅ Safari Enhancement: Native Notifications

When Claude begins a long-running automation sequence, the native app posts a macOS
notification so the user knows automation is in progress even when Safari is not visible:

```swift
import UserNotifications

func postAutomationNotification(toolName: String) {
    let content = UNMutableNotificationContent()
    content.title = "Claude is automating Safari"
    content.body = "Running: \(toolName)"
    content.sound = nil  // Silent — informational only

    // Use a stable identifier so subsequent notifications replace (not stack)
    let request = UNNotificationRequest(
        identifier: "claude-automation-active",
        content: content,
        trigger: nil  // Deliver immediately
    )
    UNUserNotificationCenter.current().add(request)
}
```

Post notifications for:
- Automation start (first tool call in a sequence).
- Automation error (tool call fails with an error the user should see).
- Automation complete (optional — configurable in the native app's preferences).

**Do not** post notifications for every individual tool call — that would be noisy.
Debounce: only post "started" if no notification was posted in the last 10 seconds.

### Debounce State Location

`ToolRouter.swift` owns the debounce state:
```swift
private var lastNotificationDate: Date? = nil
```
Checked and updated inside `handleToolCall` before dispatching to native or extension.
`postAutomationNotification` is a private method on `ToolRouter`; it calls
`UNUserNotificationCenter.current().add(request)` directly (no delegate needed for
fire-and-forget delivery).

`AppDelegate` requests notification authorization once at startup:
```swift
UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
```
If permission is not granted, `add(request)` silently fails — no special handling needed.

### Notification Actions

macOS notifications support actions. Add a "Stop" action that triggers the same stop
flow as the in-page button:

```swift
let stopAction = UNNotificationAction(
    identifier: "stop-automation",
    title: "Stop Claude",
    options: .destructive
)
let category = UNNotificationCategory(
    identifier: "claude-automation",
    actions: [stopAction],
    intentIdentifiers: []
)
```

This lets users stop automation from Notification Center without switching to Safari.

## Error Handling

The visual indicator is non-critical. Failures should be logged but never block tool
execution:

| Condition | Behavior |
|-----------|----------|
| Content script not loaded | Log warning, continue tool execution |
| `sendMessage` fails | Log warning, continue tool execution |
| Stop button click fails to cancel | Log error, attempt to hide indicator anyway |
| Notification permission not granted | Skip native notifications silently |

## Safari Considerations

### ⚠ No Visual Tab Group Indicator

Chrome shows Claude's tabs with a colored group label in the tab bar. Safari has no
`tabGroups` API, so there is no visual indicator in the tab bar itself showing which tabs
Claude controls.

**Impact:** Users cannot tell at a glance which tabs belong to Claude's session. The
in-page glow border partially compensates but only for the active tab.

**Mitigation:** The popup UI (Phase 7) should list managed tabs. The native app's menu
bar status item could also show the active tab count.

### ⚠ Background Page Suspension

If the background page suspends while the indicator is showing, the heartbeat mechanism
(5s interval) ensures the indicator auto-hides after 3s of no response. Without this,
the glow border and stop button would remain visible indefinitely.

### Content Script Re-injection

When Safari restores a tab from memory (tab discarding), content scripts may need to be
re-injected. The `document_idle` injection timing handles this automatically for new page
loads, but discarded-and-restored tabs may not re-trigger content script injection in all
Safari versions.

The background script re-injects defensively before every `show` message:
```js
async function showIndicatorOnTab(tabId) {
  try {
    await browser.tabs.executeScript(tabId, {
      file: "content-scripts/agent-visual-indicator.js"
    });
  } catch (e) {
    console.warn("indicator re-inject failed (non-critical):", e);
  }
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "CLAUDE_AGENT_INDICATOR", action: "show"
    });
  } catch (e) {
    console.warn("indicator show message failed (non-critical):", e);
  }
}
```
The installation guard (`window.__claudeVisualIndicatorInstalled`) makes re-injection
idempotent — the script body exits immediately on the second call, so no duplicate
overlays are created.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Pulsing orange glow border | ✅ | ✅ | None |
| "Stop Claude" button | ✅ | ✅ | None |
| Show/hide transitions | ✅ | ✅ | None |
| Heartbeat auto-hide | ✅ | ✅ | None |
| Stop signal to automation | ✅ | ✅ | None |
| Static indicator (persistent pill bar) | ✅ | ✅ | Parity |
| Hide-for-tool-use (screenshot suppression) | ✅ | ✅ | Parity |
| Tab group visual indicator | ✅ (colored tab bar) | ❌ | No tabGroups API in Safari |
| Shadow DOM isolation | ❌ | ✅ | Safari enhancement |
| macOS native notifications | ❌ | ✅ | Safari enhancement |
| Notification Center stop action | ❌ | ✅ | Safari enhancement |

## Implementation Phasing

This spec is implemented in two PRs to manage risk:

### PR A — JS-only (content script + background.js)
- `agent-visual-indicator.js` — full glow/stop + static indicator implementation
- `background.js` — indicator show/hide hooks around `executeTool`, `currentRequestId`
  tracking, `STOP_AGENT` handler
- No Swift changes required

### PR B — Native integration (deferred)
- `AppDelegate.swift` — `requestAuthorization` at startup
- `ToolRouter.swift` — `postAutomationNotification`, `lastNotificationDate` debounce
- `UNNotificationAction` "Stop Claude" action and delegate wiring
- Full cancellation for native-handled tools (screenshot, gif, file_upload)

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | Send "show" message to tab | Glow border + stop button appear |
| T2 | Send "hide" message to tab | Indicator fades out |
| T3 | Click "Stop Claude" button | Stop signal sent, indicator hides |
| T4 | Show → wait 500ms → show again | Indicator stays visible (no flicker) |
| T5 | Background page suspends while showing | Heartbeat auto-hides after 3s |
| T6 | Multiple tool calls in sequence | Indicator stays visible throughout |
| T7 | Indicator does not block page clicks | `pointer-events: none` on glow border |
| T8 | Page has aggressive CSS reset | Indicator unaffected (Shadow DOM isolation) |
| T9 | Tab navigates while indicator showing | Indicator re-appears after navigation |
| T10 | Long automation sequence starts | macOS notification posted |
| T11 | User clicks "Stop" in Notification Center | Automation halted |
| T12 | Notification permission not granted | No notification, no error |
| T13 | Content script not loaded when show sent | Warning logged, no crash |
| T14 | Indicator installed guard (double injection) | Only one instance created |
| T15 | Static indicator shows between tool calls | Pill bar with Claude icon visible |
| T16 | Click dismiss on static indicator | Static indicator hides for this group |
| T17 | `hide_for_tool` message | Agent indicator hides immediately, no transition |
| T18 | `show_after_tool` message | Agent indicator restores immediately |
| T19 | Stop clicked while background page suspended | Indicator hides locally, no crash |
| T20 | Second automation notification | Replaces first (stable identifier), no stacking |
