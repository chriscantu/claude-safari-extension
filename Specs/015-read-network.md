# Spec 015 — read_network_requests

## Overview

`read_network_requests` reads captured HTTP requests (fetch, XHR, and resource loads) from
a specific tab. The content script `network-monitor.js` (already implemented) patches
`fetch` and `XMLHttpRequest` at `document_start` to capture all outgoing requests. This
tool handler reads the captured buffer.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/read-network.js`
- Content script: `ClaudeInSafari Extension/Resources/content-scripts/network-monitor.js`
  (already implemented — captures to `window.__claudeNetworkRequests`)
- Tool name: `"read_network_requests"`

## Tool Arguments

```ts
{
  tabId:       number;   // Virtual tab ID (required)
  urlPattern?: string;   // URL substring filter. Only requests whose URL contains this
                         //   string are returned.
  clear?:      boolean;  // If true, clear requests after reading. Default: false.
  limit?:      number;   // Maximum number of requests to return. Default: 100.
}
```

## Return Value

```ts
{
  content: [{
    type: "text",
    text: string  // Formatted network requests (see format below)
  }]
}
```

### Output Format

```
Network requests for tab <tabId> (<count> requests):

[<type>] <METHOD> <url> → <status> <statusText> (<duration>ms)
[<type>] <METHOD> <url> → <status> <statusText> (<duration>ms)
...
```

- `<type>` — `fetch` or `xhr`.
- `<METHOD>` — HTTP method (GET, POST, etc.).
- `<url>` — the full request URL.
- `<status>` — HTTP status code (e.g., 200, 404). `ERR` if the request failed.
- `<statusText>` — HTTP status text (e.g., "OK", "Not Found").
- `<duration>` — `endTime - startTime` in milliseconds. `pending` if still in flight.

For failed requests (no response):
```
[fetch] POST https://api.example.com/data → ERR: <error message> (150ms)
```

If no requests match: `"No network requests found for tab <tabId>."`.

If `clear` is true, append: `"\n(Requests cleared)"`.

## Behavior

1. Resolve the real tab ID from the virtual tab ID via `globalThis.resolveTab`.
2. Inject a **single** IIFE via `browser.tabs.executeScript` that atomically reads and
   optionally clears `window.__claudeNetworkRequests`:
   ```js
   const reqs = (window.__claudeNetworkRequests || []).slice();
   if (CLEAR_FLAG) window.__claudeNetworkRequests = [];
   return reqs;
   ```
   The `|| []` guard handles the case where the content script hasn't loaded yet.
3. Apply filters (in the background script, after injection returns):
   a. If `urlPattern` is set: keep only requests where `url` contains `urlPattern`
      (case-insensitive substring match — not regex).
   b. Note: `read_console_messages` (Spec 014) uses regex for its `pattern` parameter.
      This tool intentionally uses a simpler substring match for `urlPattern`.
4. Apply `limit`: slice to the most recent `limit` requests, then output in
   **chronological (oldest-first)** order.
5. Format and return.
6. Injection failures must use `globalThis.classifyExecuteScriptError` for consistent
   error messages.

### XHR Error Handling

For XHR requests where the request fails at the network level (DNS failure, connection
refused), `status` is `0` and `statusText` is empty. The content script should also
listen for `xhr.addEventListener("error", ...)` and `xhr.addEventListener("abort", ...)`
to capture a descriptive error string. In the output format:
- `status === 0` with no error event → display as `→ 0 (no response)`
- `status === 0` with error event → display as `→ ERR: <error message>`

### In-Flight Request Display

If `entry.endTime` is undefined, the request is still in flight. Display `pending`
instead of a numeric duration.

### URL Pattern Matching

Unlike `read_console_messages` (which uses regex), `urlPattern` is a **plain substring
match** (case-insensitive). This matches Chrome's behavior and is simpler for common use
cases like filtering by domain or path prefix.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `tabId` missing | `isError: true`, "tabId parameter is required" |
| Tab not accessible | `isError: true`, "Cannot access tab `<tabId>`" |
| Content script not loaded (no `__claudeNetworkRequests`) | Return empty result (not error) |
| Script injection fails | `isError: true`, browser error message |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

Reading network requests requires `browser.tabs.executeScript`, which fails when
Safari is not the active application.

### ⚠ Background Page Suspension

The network request buffer lives in the **content script** context
(`window.__claudeNetworkRequests`), not in the background page. Messages survive background
page suspension. Same caveats as Spec 014: page navigation resets the buffer, and tab
discarding loses it.

### Fetch/XHR Patching Reliability

The content script patches `window.fetch` and `XMLHttpRequest.prototype`. This has known
limitations in Safari:

- **Service Worker requests:** Requests made by a Service Worker are not captured because
  the content script runs in the page context, not the SW context. Chrome has the same
  limitation.
- **Requests before content script loads:** If the page fires requests in an inline
  `<script>` that executes before `document_start` content scripts (rare but possible in
  Safari), those requests are missed.
- **Web Workers:** Requests from dedicated/shared Workers are not captured. Chrome has
  the same limitation.

### PerformanceObserver Gap

The existing `network-monitor.js` has a `PerformanceObserver` with an empty callback
(REVIEW.md M4). This observer doesn't currently contribute captured data. A future
enhancement could use `PerformanceResourceTiming` entries to supplement the fetch/XHR
patches, capturing resource loads (images, scripts, stylesheets) that bypass fetch/XHR.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Capture fetch requests | ✅ | ✅ | None |
| Capture XHR requests | ✅ | ✅ | None |
| URL pattern filtering | ✅ | ✅ | None |
| Clear after reading | ✅ | ✅ | None |
| Limit parameter | ✅ | ✅ | None |
| Request timing (duration) | ✅ | ✅ | None |
| Status codes | ✅ | ✅ | None |
| Error details | ✅ | ✅ | None |
| Works when browser in background | ✅ | ❌ | Safari must be frontmost |
| Service Worker requests | ❌ | ❌ | Same gap |
| Resource loads (images/CSS/JS) | Partial | ❌ | Could be added via PerformanceObserver |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | Page that fetches `/api/data` | Shows fetch request with URL, status, duration |
| T2 | Page with XHR to `/api/submit` | Shows xhr request |
| T3 | `urlPattern: "/api/"` on page with mixed requests | Only API requests returned |
| T4 | `urlPattern: "example.com"` (case test) | Case-insensitive match |
| T5 | `clear: true` | Requests returned, then buffer cleared |
| T6 | `clear: true` then read again | Empty result on second read |
| T7 | `limit: 3` on page with 20 requests | Only 3 most recent requests |
| T8 | No network requests | "No network requests found" |
| T9 | Tab not found | `isError: true` |
| T10 | Failed fetch (network error) | Shows `ERR: <message>` |
| T11 | In-flight request (no response yet) | Shows `pending` duration |
| T12 | Content script not yet loaded | Empty result (not error) |
| T13 | Request buffer at max (500) | Oldest requests evicted |
| T14 | Mix of completed + in-flight requests | Both formatted correctly in same output |
| T15 | XHR network failure (status 0) | Shows `ERR` with error message |
