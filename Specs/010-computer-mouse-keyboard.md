# Spec 010 — computer (Mouse, Keyboard, Scroll)

## Overview

`computer` simulates mouse clicks, keyboard input, scrolling, and drag operations on the
active tab's page. It dispatches real DOM events via `browser.tabs.executeScript` so
that frameworks (React, Vue, etc.) and native listeners respond correctly.

This spec covers all `computer` actions **except** `screenshot` and `zoom`, which are
handled by the native app and specified in [Spec 011](011-computer-screenshot.md).

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/computer.js`
- Content: Injected into active tab via `browser.scripting.executeScript`
- Tool name: `"computer"`
- Native routing: `ToolRouter.swift` intercepts `action: "screenshot"` and `action: "zoom"`
  and handles them natively (Spec 011). All other actions are forwarded to the extension.

## Tool Arguments

```ts
{
  action: "left_click" | "right_click" | "double_click" | "triple_click"
        | "type" | "wait" | "scroll" | "key"
        | "left_click_drag" | "scroll_to" | "hover";

  coordinate?:       [number, number];  // [x, y] viewport pixels
  text?:             string;            // For type / key actions
  duration?:         number;            // Seconds to wait (wait action). Max 30.
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?:    number;            // Scroll ticks (1–10). Default: 3.
  start_coordinate?: [number, number];  // Drag start point (left_click_drag)
  ref?:              string;            // Element ref_id — alternative to coordinate for
                                        //   click actions, scroll_to, and hover
  repeat?:           number;            // Key repeat count (1–100). Default: 1.
  modifiers?:        string;            // "ctrl", "shift", "alt", "cmd", or combos "ctrl+shift"
  tabId?:            number;            // Virtual tab ID. Defaults to active tab.
}
```

### Coordinate vs Ref

For click actions (`left_click`, `right_click`, `double_click`, `triple_click`), `hover`,
and `scroll_to`: the caller provides **either** `coordinate` or `ref`, not both.

- `coordinate` — click at the given `[x, y]` viewport pixels.
- `ref` — resolve the element by `data-claude-ref`, compute its center via
  `getBoundingClientRect()`, and click/hover there.

If both are provided: return `isError: true`, `"Provide either coordinate or ref, not both"`.

For `scroll_to`: `ref` is **required** (scroll the element into view).

## Manifest & Load Order

`computer.js` must be added to `manifest.json` `background.scripts` and the load-order
comment in `background.js`. See CLAUDE.md Code Review Checklist, STRUCTURE.md Compliance.

## Script Construction

All injected code must follow the `buildFormInputScript` pattern from `form-input.js`:
- Parameters (`ref`, `coordinate`, `text`, etc.) are serialized into the IIFE string
  using `JSON.stringify` to prevent injection.
- Injection failures must be classified using `globalThis.classifyExecuteScriptError`
  (exported from `tool-registry.js`).

## Actions

### left_click / right_click / double_click / triple_click

1. Resolve target coordinates (from `coordinate` or `ref`).
2. If `coordinate` is outside `[0, 0, window.innerWidth, window.innerHeight]`, return
   `isError: true`, `"Coordinates (x, y) are outside the viewport"`.
3. Dispatch both `PointerEvent` and `MouseEvent` sequences at the target point (for
   maximum site compatibility):
   - `left_click`: `pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`
   - `right_click`: `pointerdown` → `mousedown` (button 2) → `pointerup` → `mouseup` (button 2) → `contextmenu`
   - `double_click`: two `click` events → `dblclick`
   - `triple_click`: three `click` events (selects paragraph in most browsers)
4. If `modifiers` is set, include `ctrlKey`, `shiftKey`, `altKey`, `metaKey` on all events.
5. Use `document.elementFromPoint(x, y)` to find the target element. If `ref` resolves to
   an element with a zero-size `getBoundingClientRect`, return `isError: true`,
   `"Element <ref> has no visible bounding rect"`.

### type

1. For each character in `text`:
   - Dispatch `keydown` → `keypress` → `input` → `keyup` on `document.activeElement`.
2. Also set the element's `value` property (for inputs/textareas) and dispatch a final
   `input` + `change` event for framework compatibility.
3. Uses the same React-compatible native setter trick as `form_input` (Spec 007).

### key

1. Parse `text` as space-separated key names (e.g., `"Enter"`, `"Backspace"`,
   `"cmd+a"`, `"Tab"`).
2. For each key: dispatch `keydown` → `keyup` on `document.activeElement`.
3. For modifier combos (e.g., `cmd+a`): hold modifier keys as `metaKey: true` / `ctrlKey: true`
   in the `KeyboardEvent` constructor.
4. Repeat the full sequence `repeat` times (default 1, max 100).
5. Platform note: `cmd` maps to `metaKey: true` on macOS.

### wait

1. Wait for `duration` seconds (max 30).
2. Return `{ output: "Waited <duration> seconds" }`.
3. This action does **not** require Safari to be frontmost.

### scroll

1. Resolve target coordinates (from `coordinate`; defaults to center of viewport if omitted).
2. Find the nearest scrollable ancestor of `document.elementFromPoint(x, y)`.
3. Call `scrollableElement.scrollBy({ left, top, behavior: "instant" })`.
4. Scroll amounts per tick: vertical = 100px, horizontal = 100px.
5. Total scroll = `scroll_amount` ticks × 100px.

### scroll_to

1. `ref` is required. Resolve the element by `data-claude-ref`.
2. Call `element.scrollIntoView({ behavior: "smooth", block: "center" })`.
3. Return confirmation with the element's new bounding rect.

### left_click_drag

1. `start_coordinate` and `coordinate` are both required.
2. Dispatch at `start_coordinate`: `pointerdown` → `mousedown`.
3. Dispatch at least one intermediate `mousemove` at the midpoint between start and end
   (required for sites that implement custom drag-and-drop handlers).
4. Dispatch at `coordinate`: `mousemove` → `pointerup` → `mouseup`.

### hover

1. Resolve target (from `coordinate` or `ref`).
2. Dispatch `mouseover` → `mouseenter` → `mousemove` at the target point.
3. Return confirmation. Useful for revealing tooltips and dropdown menus.

## Return Value

```ts
// Success
{
  content: [{ type: "text", text: "<action-specific confirmation>" }]
}

// Example confirmations:
// "Clicked at (350, 200)"
// "Clicked element ref_5 at (350, 200)"
// "Typed \"hello world\""
// "Pressed Enter"
// "Scrolled down 3 ticks at (500, 400)"
// "Scrolled element ref_12 into view"
// "Dragged from (100, 100) to (300, 300)"
// "Hovered at (200, 150)"
// "Waited 2 seconds"
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `action` missing or invalid | `isError: true`, "Invalid action: `<action>`" |
| Click action with neither `coordinate` nor `ref` | `isError: true`, "Provide coordinate or ref for `<action>`" |
| Both `coordinate` and `ref` provided | `isError: true`, "Provide either coordinate or ref, not both" |
| `ref` not found on page | `isError: true`, "Element '`<ref>`' not found" |
| `text` missing for `type` / `key` | `isError: true`, "text parameter is required for `<action>` action" |
| `scroll_direction` missing for `scroll` | `isError: true`, "scroll_direction is required for scroll action" |
| `start_coordinate` missing for `left_click_drag` | `isError: true`, "start_coordinate is required for left_click_drag" |
| `coordinate` missing for `left_click_drag` | `isError: true`, "coordinate is required for left_click_drag" |
| `ref` missing for `scroll_to` | `isError: true`, "ref is required for scroll_to action" |
| `duration` missing or > 30 for `wait` | `isError: true`, "duration must be between 0 and 30 seconds" |
| `repeat` out of range (< 1 or > 100) | `isError: true`, "repeat must be between 1 and 100" |
| Tab not accessible | `isError: true`, "Cannot access tab `<tabId>`" |
| Script injection fails | `isError: true`, browser error message |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

`browser.tabs.executeScript` fails with a permission error when Safari is not the
active (frontmost) application. This affects **all** `computer` actions except `wait`.

**Impact:** If the user Cmd-Tabs to Terminal to watch Claude Code output, the next
`computer` action will fail. Chrome does not have this limitation.

**Mitigation:** `ToolRouter.swift` must call
`NSWorkspace.shared.open(URL(string: "x-safari://")!)` (or equivalent `NSRunningApplication`
activation) before forwarding any `computer` action except `wait` to the extension. This
should be a shared helper function in `ToolRouter`, not duplicated per tool.

### Wait Action and Background Page Suspension

The `wait` action uses a `setTimeout` inside the background page. With `persistent: false`,
the background page can be suspended during waits longer than ~20 seconds. The keepalive
alarm fires every 24 seconds, but a 30-second wait may outlive it.

**Mitigation:** For waits > 20 seconds, use `browser.alarms.create` instead of
`setTimeout`. Document this risk in JSDoc matching the pattern in `navigate.js`.

### Event Dispatch Fidelity

Safari's DOM event model has minor differences from Chrome:
- `MouseEvent` `pointerId` is not always set (Pointer Events Level 2 partial support).
- `InputEvent.inputType` granularity may differ for `type` actions.
- Some sites use `PointerEvent` exclusively; we should dispatch both `MouseEvent` and
  `PointerEvent` sequences for maximum compatibility.

### contenteditable and Shadow DOM

- For `contenteditable` elements: `type` should use `document.execCommand("insertText")`
  as a fallback if the native setter approach fails.
- Shadow DOM roots: `document.elementFromPoint()` may return the shadow host. Use
  `element.shadowRoot?.elementFromPoint()` to drill into open shadow roots.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| All 11 non-screenshot actions | ✅ | ✅ | None |
| Coordinate-based targeting | ✅ | ✅ | None |
| Ref-based targeting | ✅ | ✅ | None |
| Modifier keys | ✅ | ✅ | None |
| Works when browser is in background | ✅ | ❌ | Safari must be frontmost |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | `action: "left_click", coordinate: [100, 200]` | Click dispatched at (100, 200) |
| T2 | `action: "left_click", ref: "ref_5"` | Click dispatched at element center |
| T3 | `action: "right_click", coordinate: [100, 200]` | Context menu event dispatched |
| T4 | `action: "double_click", coordinate: [100, 200]` | dblclick event dispatched |
| T5 | `action: "triple_click", coordinate: [100, 200]` | Three clicks dispatched |
| T6 | `action: "type", text: "hello"` | Text typed into active element |
| T7 | `action: "key", text: "Enter"` | Enter key dispatched |
| T8 | `action: "key", text: "cmd+a"` | Select-all dispatched (metaKey: true) |
| T9 | `action: "key", text: "Backspace", repeat: 5` | Backspace dispatched 5 times |
| T10 | `action: "wait", duration: 2` | Waits 2 seconds, returns confirmation |
| T11 | `action: "scroll", coordinate: [400, 300], scroll_direction: "down"` | Scrolls down 3 ticks |
| T12 | `action: "scroll", scroll_direction: "up", scroll_amount: 5` | Scrolls up 5 ticks at viewport center |
| T13 | `action: "scroll_to", ref: "ref_20"` | Element scrolled into view |
| T14 | `action: "left_click_drag", start_coordinate: [100, 100], coordinate: [300, 300]` | Drag dispatched |
| T15 | `action: "hover", coordinate: [200, 150]` | Hover events dispatched |
| T16 | `action: "hover", ref: "ref_3"` | Hover events dispatched at element center |
| T17 | `action: "left_click", modifiers: "shift", coordinate: [100, 200]` | Shift-click dispatched |
| T18 | Both `coordinate` and `ref` provided | `isError: true` |
| T19 | `action: "left_click"` with no coordinate or ref | `isError: true` |
| T20 | `action: "type"` with no `text` | `isError: true` |
| T21 | `action: "wait", duration: 60` | `isError: true`, exceeds max |
| T22 | Invalid tab ID | `isError: true`, tab not found |
| T23 | `action: "scroll"` with no `coordinate` | Defaults to viewport center |
| T24 | `action: "left_click", coordinate: [-1, -1]` | `isError: true`, outside viewport |
| T25 | `action: "left_click_drag"` | At least one intermediate `mousemove` dispatched |
| T26 | `action: "type"` on `contenteditable` | `execCommand("insertText")` fallback |
| T27 | `ref` resolves to zero-size element | `isError: true`, no visible bounding rect |
| T28 | Concurrent `wait` calls | Both resolve correctly (serialized by poll loop) |
