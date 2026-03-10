# Design: computer tool — Mouse, Keyboard, Scroll (Spec 010)

**Date:** 2026-03-10
**Spec:** [Specs/010-computer-mouse-keyboard.md](../../../Specs/010-computer-mouse-keyboard.md)
**Branch:** feature/computer-mouse-keyboard

---

## Overview

Implement the `computer` tool's mouse, keyboard, and scroll actions as a Safari Web Extension background script tool (`computer.js`). Screenshot and zoom actions (Spec 011) are excluded from this PR — they are native-side and will be a separate feature branch.

---

## Architecture

### Files Changed

| File | Change |
|------|--------|
| `ClaudeInSafari Extension/Resources/tools/computer.js` | Create — tool handler |
| `Tests/JS/computer.test.js` | Create — 28 test cases |
| `ClaudeInSafari Extension/Resources/manifest.json` | Add `computer.js` to `background.scripts` |
| `ClaudeInSafari Extension/Resources/background.js` | Update load-order comment |

No Swift changes in this PR. `ToolRouter.swift` already forwards non-screenshot/zoom `computer` actions to the extension (Spec 011 wires that routing).

---

## computer.js Structure

```
1. JSDoc header (tool name, actions, dependencies, Safari caveats)
2. ACTION_HANDLERS dispatch table
3. handleComputer(args) — validates action, resolves tab, routes via table
4. Shared validation helpers
5. Per-action handlers + IIFE builders
6. registerTool("computer", handleComputer)
```

### Dispatch Table

```js
const ACTION_HANDLERS = {
  left_click:      handleClick,
  right_click:     handleClick,
  double_click:    handleClick,
  triple_click:    handleClick,
  hover:           handleHover,
  type:            handleType,
  key:             handleKey,
  wait:            handleWait,
  scroll:          handleScroll,
  scroll_to:       handleScrollTo,
  left_click_drag: handleDrag,
};
```

### Top-Level Handler

`handleComputer(args)`:
1. Validate `action` is a known key in `ACTION_HANDLERS` → `isError` if not
2. For all actions except `wait`: call `globalThis.resolveTab(args.tabId)` to get real tab
3. Route to action handler

### Shared Validation

`validateCoordinateOrRef(action, args)`:
- Both provided → `isError: true`, "Provide either coordinate or ref, not both"
- Neither provided (for actions that require one) → `isError: true`, "Provide coordinate or ref for `<action>`"

### Per-Action Handlers

**`handleClick(args, tab)`** — shared for all 4 click variants
- Calls `buildClickScript(action, coordinate, modifiers)` → returns IIFE string
- IIFE dispatches PointerEvent + MouseEvent sequence per action variant
- Ref-based: IIFE resolves `data-claude-ref` → `getBoundingClientRect()` center
- Coordinate out-of-bounds check inside IIFE → returns `{ error: "..." }`

**`handleType(args, tab)`**
- Validates `text` is present
- `buildTypeScript(text)` IIFE:
  - React-native-setter trick on `document.activeElement`
  - Dispatches `keydown` → `keypress` → `input` → `keyup` per character
  - Final `input` + `change` events for framework compat
  - `contenteditable` fallback: `document.execCommand("insertText")`

**`handleKey(args, tab)`**
- Validates `text` present, `repeat` in [1, 100]
- `buildKeyScript(text, repeat)` IIFE:
  - Parses space-separated key names; maps `cmd` → `metaKey: true`
  - Dispatches `keydown` → `keyup` per key, repeated `repeat` times

**`handleWait(args)`**
- Validates `duration` in (0, 30]
- `duration ≤ 20s`: `new Promise(resolve => setTimeout(resolve, ms))`
- `duration > 20s`: `browser.alarms.create` to survive background page suspension
- No tab resolution, no executeScript

**`handleScroll(args, tab)`**
- `scroll_direction` required
- Defaults `coordinate` to viewport center if omitted
- `buildScrollScript(coordinate, direction, amount)` IIFE:
  - `document.elementFromPoint(x, y)` → walk ancestors for scrollable element
  - `scrollBy({ left, top, behavior: "instant" })`, 100px per tick

**`handleScrollTo(args, tab)`**
- `ref` required
- `buildScrollToScript(ref)` IIFE:
  - Resolve `data-claude-ref` → `scrollIntoView({ behavior: "smooth", block: "center" })`
  - Returns new bounding rect in confirmation

**`handleDrag(args, tab)`**
- `start_coordinate` and `coordinate` both required
- `buildDragScript(start, end)` IIFE:
  - `pointerdown` + `mousedown` at start
  - `mousemove` at midpoint
  - `mousemove` + `pointerup` + `mouseup` at end

**`handleHover(args, tab)`**
- Coordinate or ref required
- `buildHoverScript(coordinate)` IIFE:
  - Dispatches `mouseover` → `mouseenter` → `mousemove`

### IIFE Pattern

All `build*Script()` functions follow the `form-input.js` pattern:
- Parameters serialized into the string via `JSON.stringify` (injection safety)
- IIFE returns `{ result: "...", error: "..." }`
- Handler checks `results[0]?.error`, throws if set

### Error Handling

All `executeScript` failures → `globalThis.classifyExecuteScriptError("computer", tabId, err)`

---

## Tests (computer.test.js)

28 test cases from Spec 010, organized by `describe` block:

| Block | Tests |
|-------|-------|
| `left_click / right_click / double_click / triple_click` | T1–T5, T17–T19, T24, T27 |
| `type` | T6, T20, T26 |
| `key` | T7–T9 |
| `wait` | T10, T21, T28 |
| `scroll` | T11–T12, T23 |
| `scroll_to` | T13 |
| `left_click_drag` | T14, T25 |
| `hover` | T15–T16 |
| `error handling (tab)` | T22 |

Test infrastructure: `@jest-environment jsdom` + `vm.runInNewContext` for real IIFE evaluation (matches `get-page-text.test.js` pattern). Mocks: `document.elementFromPoint`, `data-claude-ref` elements, `browser.tabs.executeScript`, `globalThis.resolveTab`, `globalThis.classifyExecuteScriptError`.

---

## Manifest / Load Order

`computer.js` inserted after `get-page-text.js` in `manifest.json` `background.scripts`.
`background.js` load-order comment updated to include step 9: `tools/computer.js`.

---

## Safari Caveats (documented in JSDoc)

- `executeScript` requires Safari to be frontmost — all actions except `wait` will fail if Safari isn't active. Mitigation lives in `ToolRouter.swift` (out of scope for this PR).
- `wait` > 20s uses `browser.alarms` to survive background page suspension.
