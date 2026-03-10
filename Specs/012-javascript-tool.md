# Spec 012 — javascript_tool

## Overview

`javascript_tool` executes arbitrary JavaScript code in the context of the active tab's page.
The code runs in the page's **main world** (not the extension's isolated world), so it can
access the DOM, `window` object, page variables, and functions defined by the page.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/javascript-tool.js`
- Content: Two-phase injection — `browser.tabs.executeScript` injects a content script
  (isolated world) which creates a `<script>` element to run user code in the main world.
- Tool name: `"javascript_tool"`

## Manifest & Load Order

`javascript-tool.js` must be added to `manifest.json` `background.scripts` and the
load-order comment in `background.js`. See CLAUDE.md Code Review Checklist.

## Tool Arguments

```ts
{
  action: "javascript_exec";  // Must be exactly this value (required)
  text:   string;             // JavaScript code to execute (required)
  tabId?: number;             // Virtual tab ID. Defaults to active tab.
}
```

### Code Execution Model

- The `text` is evaluated as an expression. The result of the **last expression** is
  returned automatically.
- Callers should **not** use `return` statements — the code is wrapped internally,
  and the last expression's value is captured.
- Async code: if the last expression is a Promise, it is awaited and the resolved value
  is returned.

#### Examples

```js
// ✅ Correct — expression returns a value
"document.title"

// ✅ Correct — multi-statement, last expression returned
"const items = document.querySelectorAll('.item'); items.length"

// ✅ Correct — async
"await fetch('/api/data').then(r => r.json())"

// ❌ Wrong — bare `return` causes SyntaxError
"return document.title"
```

## Implementation

### MV2 Main-World Execution Architecture

Safari MV2 does not have `browser.scripting.executeScript` with `world: "MAIN"` (that is
an MV3 API). Instead, main-world execution uses a two-phase injection:

**Phase 1 — Inject bridge content script** (isolated world):
```js
browser.tabs.executeScript(realTabId, {
  code: bridgeScript,   // Content script that creates a <script> element
  runAt: "document_idle"
});
```

**Phase 2 — Bridge content script creates a `<script>` element** (main world):
The content script injects a `<script>` element into the page DOM. Code inside `<script>`
elements runs in the page's main world, with access to page variables and the real `window`.

```js
// Bridge content script (runs in isolated world):
const script = document.createElement('script');
script.textContent = wrappedUserCode;
(document.head || document.documentElement).appendChild(script);
script.remove();

// Listen for the result via window.postMessage:
window.addEventListener('message', function handler(event) {
  if (event.data && event.data.__claudeJsToolResult) {
    window.removeEventListener('message', handler);
    // Return result to background script
  }
});
```

**Result return channel:** The injected `<script>` uses `window.postMessage` to send the
result back to the content script (isolated world), which then returns it to the background
script via the `executeScript` return value.

### Wrapper Template

The user's code is wrapped to capture the last expression's value. The wrapper uses an
async IIFE with `AsyncFunction` constructor to provide expression-level return semantics
(the last expression in the function body is returned).

**Note on dynamic code execution:** This tool's entire purpose is to execute arbitrary
user-provided JavaScript in the page context — equivalent to a user typing in the browser
DevTools console. The `AsyncFunction` constructor is the correct mechanism for this because
it provides `return`-capable function bodies from string input. The MCP protocol is
local-only (Unix domain socket), so the trust boundary is the local machine.

The user code string is passed as a JSON-serialized value, not concatenated into the
source template, to prevent injection of the wrapper itself.

### Result Serialization

- Primitive values: converted to string via `String(value)`.
- Objects/Arrays: serialized via `JSON.stringify(value, null, 2)`.
- `undefined`: returned as the string `"undefined"`.
- Circular references: caught by `JSON.stringify` — return error message.
- DOM elements: not serializable — return `"[object HTMLElement]"` with a helpful note.

### Timeout Enforcement

The content script must implement a `Promise.race` between:
1. The `window.postMessage` listener (resolves on result).
2. A 30-second timeout (rejects with timeout error).

The losing branch must clean up: remove the `message` event listener on timeout, and
discard late-arriving results. This prevents leaked listeners (per CLAUDE.md Code Review
Checklist: event listener lifecycle cleanup).

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
`"\n[output truncated]"`.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `action` is not `"javascript_exec"` | `isError: true`, "'javascript_exec' is the only supported action" |
| `text` is empty or missing | `isError: true`, "Code parameter is required" |
| User code throws an error | `isError: true`, "JavaScript error: `<message>`\n`<stack>`" |
| User code throws a non-Error (e.g., `throw "string"`) | `isError: true`, message from `String(thrown)`, stack is `"(no stack)"` |
| User code returns circular object | `isError: true`, "Result contains circular references" |
| Tab not accessible | `isError: true`, "Cannot access tab `<tabId>`" (use `classifyExecuteScriptError`) |
| Script injection fails | `isError: true`, classified error via `globalThis.classifyExecuteScriptError` |
| Execution timeout (> 30s) | `isError: true`, "Script execution timed out after 30 seconds" |
| CSP blocks script injection | `isError: true`, "Page Content Security Policy blocks script execution" |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

`browser.tabs.executeScript` requires Safari to be the active application. If Safari
is in the background, the injection fails with a permission error.

**Impact:** Same as Spec 010 — the user cannot Cmd-Tab away during JavaScript execution.

**Mitigation:** `ToolRouter.swift` activates Safari before forwarding (shared helper).

### ⚠ `<script>` Element Injection and CSP

The `<script>` element injection technique runs subject to the page's Content Security
Policy. Pages with strict `script-src` directives that don't include `'unsafe-inline'`
will block the injected `<script>` element.

**Affected pages:** GitHub, Gmail, and many SPAs with strict CSPs.

**Behavior:** If CSP blocks execution, return `isError: true` with a clear error message:
`"Page Content Security Policy blocks script execution. The page's CSP does not allow
inline scripts."` **Do NOT** silently fall back to the isolated world — this would
produce confusing wrong results when user code references page variables.

### postMessage Security

The `window.postMessage` result channel uses a distinctive `__claudeJsToolResult` flag
to identify result messages. The content script must verify `event.data.__claudeJsToolResult`
before processing, to avoid being spoofed by page-originated messages. The `event.origin`
check is not useful here since both sender and receiver are on the same origin.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Execute arbitrary JS in page context | ✅ | ✅ | Different mechanism (script injection vs world: MAIN) |
| Access page variables and DOM | ✅ | ✅ | None |
| Async code (await) | ✅ | ✅ | None |
| Multi-statement last-expression return | ✅ | ✅ | None (AsyncFunction constructor) |
| Works when browser in background | ✅ | ❌ | Safari must be frontmost |
| CSP-restricted pages | Partial (unsafe-eval) | Partial (unsafe-inline) | Different CSP requirement |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | `text: "document.title"` | Returns page title string |
| T2 | `text: "1 + 1"` | Returns "2" |
| T3 | `text: "const x = 5; x * 3"` | Returns "15" |
| T4 | `text: "document.querySelectorAll('a').length"` | Returns link count |
| T5 | `text: "await fetch('/api').then(r => r.status)"` | Returns status code |
| T6 | `text: "({name: 'test', value: 42})"` | Returns JSON string |
| T7 | `text: "throw new Error('test')"` | `isError: true`, includes "test" |
| T8 | `text: ""` | `isError: true`, "Code parameter is required" |
| T9 | `action: "wrong"` | `isError: true`, "javascript_exec is the only supported action" |
| T10 | Invalid tab ID | `isError: true` |
| T11 | Result > 100,000 chars | Truncated with `[output truncated]` |
| T12 | `text: "return 5"` | `isError: true`, SyntaxError (bare return) |
| T13 | `text: "undefined"` | Returns string "undefined" |
| T14 | `text: "throw 'a string'"` (non-Error throw) | `isError: true`, message is "a string" |
| T15 | Code with infinite loop | Timeout fires at 30s |
| T16 | CSP-restricted page blocks inline scripts | `isError: true`, CSP error message |
| T17 | Code accessing `window.myPageVar` (page variable) | Accessible in main world |
| T18 | Code returning a DOM element | Returns `"[object HTMLElement]"` with note |
| T19 | `postMessage` listener cleaned up on timeout | No leaked event listeners |
