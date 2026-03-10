# Spec 014 — read_console_messages

## Overview

`read_console_messages` reads captured browser console output (`console.log`, `console.error`,
`console.warn`, etc.) from a specific tab. The content script `console-monitor.js` (already
implemented) overrides `console.*` methods at `document_start` to capture all messages before
page scripts run. This tool handler reads the captured buffer.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/read-console.js`
- Content script: `ClaudeInSafari Extension/Resources/content-scripts/console-monitor.js`
  (already implemented — captures to `window.__claudeConsoleMessages`)
- Tool name: `"read_console_messages"`

## Tool Arguments

```ts
{
  tabId:      number;   // Virtual tab ID (required)
  onlyErrors?: boolean; // If true, only return error/exception messages. Default: false.
  clear?:     boolean;  // If true, clear messages after reading. Default: false.
  pattern?:   string;   // Regex pattern to filter messages. Only matching messages returned.
  limit?:     number;   // Maximum number of messages to return. Default: 100.
}
```

## Return Value

```ts
{
  content: [{
    type: "text",
    text: string  // Formatted console messages (see format below)
  }]
}
```

### Output Format

```
Console messages for tab <tabId> (<count> messages):

[<timestamp>] [<LEVEL>] <message>
[<timestamp>] [<LEVEL>] <message>
...
```

- `<timestamp>` — UTC time (HH:MM:SS.mmm), derived from
  `new Date(timestamp).toISOString().slice(11, 23)`. Note: this is UTC, not local time.
- `<LEVEL>` — uppercase: `LOG`, `INFO`, `WARN`, `ERROR`, `DEBUG`.
- `<message>` — the serialized message string.

If no messages match: `"No console messages found for tab <tabId>."`.

If `clear` is true, append: `"\n(Messages cleared)"`.

## Behavior

1. Resolve the real tab ID from the virtual tab ID via `globalThis.resolveTab`.
2. Inject a **single** IIFE via `browser.tabs.executeScript` that atomically reads and
   optionally clears `window.__claudeConsoleMessages`:
   ```js
   const msgs = (window.__claudeConsoleMessages || []).slice();
   if (CLEAR_FLAG) window.__claudeConsoleMessages = [];
   return msgs;
   ```
   The `|| []` guard handles the case where the content script hasn't loaded yet
   (returns `null`/`undefined` from `executeScript`).
3. Apply filters (in the background script, after injection returns):
   a. If `onlyErrors` is true: keep only messages where `level === "error"`.
   b. If `pattern` is set: keep only messages where `message` matches the regex
      (case-insensitive by default).
4. Apply `limit`: slice to the most recent `limit` messages, then output in
   **chronological (oldest-first)** order.
5. Format and return.
6. Injection failures must use `globalThis.classifyExecuteScriptError` for consistent
   error messages (matching the pattern in `get-page-text.js`).

### Regex Pattern

The `pattern` is compiled as a JavaScript `RegExp` with the `i` flag (case-insensitive).
If the pattern is invalid regex, return `isError: true` with the regex syntax error.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `tabId` missing | `isError: true`, "tabId parameter is required" |
| Tab not accessible | `isError: true`, "Cannot access tab `<tabId>`" |
| Invalid `pattern` regex | `isError: true`, "Invalid regex pattern: `<error>`" |
| Content script not loaded (no `__claudeConsoleMessages`) | Return empty result (not an error — content script may not have loaded yet) |
| Script injection fails | `isError: true`, browser error message |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

Reading console messages requires `browser.tabs.executeScript`, which fails when
Safari is not the active application.

**Impact:** Cannot read console output while the user is in another app. Chrome does not
have this limitation.

### ⚠ Background Page Suspension

The console messages buffer lives in the **content script** context
(`window.__claudeConsoleMessages`), not in the background page. This means messages
survive background page suspension (`persistent: false`). However:

- If the page navigates to a new domain, the content script re-initializes and the buffer
  resets. This is the same behavior as Chrome.
- If Safari suspends the tab itself (Tab Discarding / memory pressure), the buffer is lost.
  Chrome also loses content script state on tab discard.

### Content Script Injection Timing

`console-monitor.js` runs at `document_start` with `all_frames: true`, which means it
captures messages from all frames on the page. However, the Chrome extension's tool
description warns: "Returns console messages from the current domain only." Our
implementation returns **all captured messages** regardless of frame origin. Consider
filtering by the top frame's domain for Chrome parity, or documenting this as a Safari
enhancement (more visibility into cross-frame console output).

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Capture console.log/error/warn/info/debug | ✅ | ✅ | None |
| Capture unhandled errors | ✅ | ✅ | None |
| Capture unhandled promise rejections | ✅ | ✅ | None |
| Pattern filtering (regex) | ✅ | ✅ | None |
| Error-only filtering | ✅ | ✅ | None |
| Clear after reading | ✅ | ✅ | None |
| Limit parameter | ✅ | ✅ | None |
| Works when browser in background | ✅ | ❌ | Safari must be frontmost |
| Cross-frame messages | Same domain only | All frames | Safari captures more (enhancement) |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | Page with `console.log("hello")` | Message appears with `[LOG]` level |
| T2 | Page with `console.error("fail")` | Message appears with `[ERROR]` level |
| T3 | `onlyErrors: true` on page with log + error | Only error messages returned |
| T4 | `pattern: "api"` on page with mixed messages | Only messages matching "api" returned |
| T5 | `pattern: "[invalid"` (bad regex) | `isError: true`, regex syntax error |
| T6 | `clear: true` | Messages returned, then buffer cleared |
| T7 | `clear: true` then read again | Empty result on second read |
| T8 | `limit: 5` on page with 50 messages | Only 5 most recent messages returned |
| T9 | No console messages | "No console messages found" |
| T10 | Tab not found | `isError: true` |
| T11 | Unhandled error on page | Captured with filename/line info |
| T12 | Unhandled promise rejection | Captured with rejection reason |
| T13 | Content script not yet loaded | Empty result (not error) |
| T14 | `onlyErrors: true, pattern: "api"` | Only matching error messages returned |
| T15 | `limit: 5` returns results in chronological order | Oldest of 5 most recent first |
