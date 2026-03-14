# Spec 012 — javascript_tool

## Overview

`javascript_tool` executes arbitrary JavaScript code in the context of the active tab's page.
The code runs in the page's **main world** (not the extension's isolated world), so it can
access the DOM, `window` object, page variables, and functions defined by the page.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/javascript-tool.js`
- Content: `ClaudeInSafari Extension/Resources/content-scripts/js-bridge-relay.js` (async fallback)
- Tool name: `"javascript_tool"`

## Manifest & Load Order

`javascript-tool.js` must be added to `manifest.json` `background.scripts` and the
load-order comment in `background.js`. See CLAUDE.md Code Review Checklist.

`js-bridge-relay.js` must be in `manifest.json` `content_scripts` with `"run_at": "document_idle"`
and `"all_frames": true`.

## Tool Arguments

```ts
{
  action: "javascript_exec";  // Must be exactly this value (required)
  text:   string;             // JavaScript code to execute (required)
  tabId?: number;             // Virtual tab ID. Defaults to active tab.
}
```

### Code Execution Model

- The `text` is evaluated via `eval()` in the page's main world. The result of the
  **last expression** is returned automatically. (Note: `eval()` is the correct mechanism
  here — this tool replicates the browser DevTools console over a local-only MCP socket.)
- Callers should **not** use `return` statements — the code is `eval()`'d directly,
  and the last expression's value is captured.
- Async code: if `eval()` returns a Promise, its `.then()` callback writes the resolved
  value to a DOM attribute for relay back to the background (see Async Path below).

#### Examples

```js
// ✅ Correct — expression returns a value
"document.title"

// ✅ Correct — multi-statement, last expression returned
"const items = document.querySelectorAll('.item'); items.length"

// ✅ Correct — async (Promise detected, result relayed)
"fetch('/api/data').then(r => r.json())"

// ❌ Wrong — bare `return` causes SyntaxError (eval, not function body)
"return document.title"
```

## Implementation

### MV2 Main-World Execution Architecture

Safari MV2 does not have `browser.scripting.executeScript` with `world: "MAIN"` (that is
an MV3 API). Instead, main-world execution uses a two-phase injection with **dual-path
result delivery**.

**Phase 1 — Inject bridge IIFE** (isolated world via `executeScript`):
```js
browser.tabs.executeScript(realTabId, {
  code: bridgeIIFE,        // Compact IIFE built by buildBridge()
  runAt: "document_idle"
});
```

**Phase 2 — Bridge creates a `<script>` element** (main world):
The bridge IIFE creates a `<script>` element whose `textContent` is the main-world script.
Code inside `<script>` elements runs in the page's main world. The main-world script
evaluates the user's code and writes the result as JSON to a DOM attribute on
`document.documentElement`.

```
Bridge IIFE (isolated world)          Main-world <script>
─────────────────────────────         ──────────────────────
1. createElement('script')      →     1. evaluate(userCode)
2. set textContent              →     2. setAttribute(attr, JSON.stringify(result))
3. appendChild(script)          →        (sync for non-Promise results)
4. getAttribute(attr)           ←     3. For Promises: .then() writes attr later
5. Return attr value (sync)
   OR return null (async)
```

### Dual-Path Result Delivery

Results are delivered via one of two paths depending on whether the evaluated code returns
synchronously or asynchronously:

**Sync path (non-Promise results):**
1. Main-world `<script>` evaluates user code.
2. Result is not a Promise → immediately writes JSON to `data-claude-js-result-{corrId}`
   attribute on `<html>`.
3. Bridge IIFE reads the attribute synchronously (DOM attributes set by main-world scripts
   ARE visible to isolated-world scripts immediately — verified).
4. Bridge returns the JSON string as the `executeScript` result.
5. Background handler reads `execResults[0]`, parses JSON, returns to caller.

**Async path (Promise results):**
1. Main-world `<script>` evaluates user code.
2. Result IS a Promise → `.then()` callback will write the attribute later.
3. Bridge IIFE reads attribute → `null` (not set yet) → returns `null`.
4. Background handler sees `execResults[0]` is null → enters async fallback.
5. `js-bridge-relay.js` (persistent content script) polls the DOM attribute every 50ms.
6. When attribute appears, relay reads it, removes it, and calls
   `browser.runtime.sendMessage({ [corrId]: true, ...parsed })`.
7. Background handler's `onMessage` listener receives the relay and resolves the Promise.

**Why the bridge IIFE cannot poll (async path):**
Safari MV2 tears down the `executeScript` isolated-world context after the IIFE returns
synchronously. ALL async callbacks (setTimeout, setInterval, Promise.then) scheduled within
the IIFE are **silently dropped** by Safari. This is why a separate persistent content
script (`js-bridge-relay.js`) is required for the async path.

**Why not `window.postMessage`:** In Safari MV2, `window.postMessage` from main-world
`<script>` elements is NOT delivered to isolated-world content script event listeners.
Both the bridge IIFE's own listener and `js-bridge-relay.js`'s listener are silently
ignored by Safari for cross-world postMessage.

### Bridge Construction

`buildBridge(text, correlationId)` produces a compact bridge IIFE. The main-world script
is pre-serialized via `JSON.stringify()` at build time, so the bridge IIFE only needs to:

1. Create a `<script>` element
2. Set its `textContent` to the pre-serialized main-world code
3. Append it to the DOM
4. Read the result attribute (sync path)
5. Return the result or `null`

The correlation ID uses the format `__claudejstoolresult_{random}`. The attribute name is
`data-claude-js-result-{correlationId}`. Both MUST be lowercase — HTML attribute names
are case-insensitive.

### Result Serialization

- Primitive values: converted to string via `String(value)`.
- Objects/Arrays: serialized via `JSON.stringify(value, null, 2)`.
- `undefined`: returned as the string `"undefined"`.
- Circular references: caught by `JSON.stringify` — uses `'[circular]'` fallback.
- Errors in user code: caught by try/catch, returned as `{error: "JavaScript error: ..."}`.

### Timeout Enforcement

The background handler registers:
1. `browser.runtime.onMessage` listener — for async path relay results.
2. `browser.tabs.onRemoved` listener — rejects immediately if tab closes.
3. `setTimeout(30s)` — rejects with "Script execution timed out after 30 seconds".

All three share a `settled` flag and a `settle()` function. The first to fire wins; the
others are cleaned up. The Swift ToolRouter has a separate 30-second timeout on the native
side.

## Return Value

```ts
// Success
{
  content: [{
    type: "text",
    text: string  // String representation of the result
  }]
}

// Error (thrown in user code)
{
  isError: true,
  content: [{
    type: "text",
    text: "JavaScript error: <message>\n<stack>"
  }]
}
```

## Output Truncation

If the serialized result exceeds **100,000 characters**, truncate and append
`"\n[truncated]"`.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `action` is not `"javascript_exec"` | `isError: true`, "'javascript_exec' is the only supported action" |
| `text` is empty or missing | `isError: true`, "Code parameter is required" |
| User code throws an error | `isError: true`, "JavaScript error: `<message>`\n`<stack>`" |
| Script injection fails (CSP, etc.) | `isError: true`, "Script injection failed: `<message>`" |
| Tab not accessible | `isError: true`, classified error via `globalThis.classifyExecuteScriptError` |
| Execution timeout (> 30s) | `isError: true`, "Script execution timed out after 30 seconds" |
| Tab closed during execution | `isError: true`, "Tab closed during javascript_tool" |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

`browser.tabs.executeScript` requires Safari to be the active application. If Safari
is in the background, the injection fails with a permission error.

**Impact:** Same as Spec 010 — the user cannot Cmd-Tab away during JavaScript execution.

**Mitigation:** `make send` activates Safari via `osascript` before forwarding.

### ⚠ executeScript Isolated-World Contexts Are Ephemeral

Safari MV2 tears down the isolated-world context created by `executeScript` after the
injected IIFE returns synchronously. Any async callbacks (setTimeout, setInterval,
Promise.then, MutationObserver) scheduled within the IIFE are silently dropped.

**Impact:** The bridge IIFE cannot poll for async results. A persistent content script
(`js-bridge-relay.js`) handles async relay instead.

### ⚠ `<script>` Element Injection and CSP

The `<script>` element injection technique runs subject to the page's Content Security
Policy. Pages with strict `script-src` directives that don't include `'unsafe-inline'`
will block the injected `<script>` element.

**Affected pages:** GitHub, Gmail, and many SPAs with strict CSPs.

**Behavior:** If CSP blocks execution, the bridge returns `{error: "Script injection
failed: ..."}`. **Do NOT** silently fall back to the isolated world — this would
produce confusing wrong results when user code references page variables.

### ⚠ browser.tabs.query Restriction in Native Messaging Context

`browser.tabs.query` returns empty arrays when called from within a `sendNativeMessage`
callback handler unless Safari has been recently activated (frontmost).

**Mitigation:** Three layers:
1. `background.js` dispatches tool execution via `setTimeout(0)` to escape the native
   messaging callback context.
2. `resolveTab(null)` retries 3 times with 300ms/600ms delays.
3. `make send` activates Safari and waits 2 seconds before sending.

### ⚠ Safari Caches Background Page JavaScript

Safari does NOT reload the extension's background page JavaScript when the native app
is relaunched (`make kill && make run`). A full Safari restart (`make safari-restart`)
is required for any JavaScript changes to take effect. Having Web Inspector open does
NOT change this — Safari caches the background page independently.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Execute arbitrary JS in page context | ✅ | ✅ | Different mechanism (script injection vs world: MAIN) |
| Access page variables and DOM | ✅ | ✅ | None |
| Async code (Promises) | ✅ | ✅ | Safari needs relay content script for async path |
| Multi-statement last-expression return | ✅ | ✅ | None (eval captures last expression) |
| Works when browser in background | ✅ | ❌ | Safari must be frontmost |
| CSP-restricted pages | Partial (unsafe-eval) | Partial (unsafe-inline) | Different CSP requirement |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | `text: "document.title"` | Returns page title string |
| T2 | `text: "1 + 1"` | Returns "2" |
| T3 | `text: "const x = 5; x * 3"` | Returns "15" |
| T4 | `text: "document.querySelectorAll('a').length"` | Returns link count |
| T5 | `text: "fetch('/api').then(r => r.status)"` | Returns status code (async path) |
| T6 | `text: "({name: 'test', value: 42})"` | Returns JSON string |
| T7 | `text: "throw new Error('test')"` | `isError: true`, includes "test" |
| T8 | `text: ""` | `isError: true`, "Code parameter is required" |
| T9 | `action: "wrong"` | `isError: true`, "javascript_exec is the only supported action" |
| T10 | Invalid tab ID | `isError: true` |
| T11 | Result > 100,000 chars | Truncated with `[truncated]` |
| T12 | `text: "return 5"` | `isError: true`, SyntaxError (bare return in eval) |
| T13 | `text: "undefined"` | Returns string "undefined" |
| T14 | `text: "throw 'a string'"` (non-Error throw) | `isError: true`, message is "a string" |
| T15 | Code with infinite loop | Timeout fires at 30s |
| T16 | CSP-restricted page blocks inline scripts | `isError: true`, injection failed message |
| T17 | Code accessing `window.myPageVar` (page variable) | Accessible in main world |
| T18 | Tab closed during async execution | `isError: true`, "Tab closed during javascript_tool" |
