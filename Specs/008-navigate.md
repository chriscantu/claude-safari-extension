# Spec 008 — navigate

## Overview

`navigate` navigates the active tab (or a specific virtual tab) to a given URL, or moves
forward/backward in history. It waits for the navigation to settle before returning.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/navigate.js`
- Tool name: `"navigate"`

## Tool Arguments

```ts
{
  url:    string;   // URL to navigate to, OR "forward" / "back" (required)
  tabId?: number;   // Virtual tab ID. Defaults to active tab.
}
```

### URL Normalization

- If `url` does not begin with `http://` or `https://` and is not `"forward"` or `"back"`:
  prepend `"https://"` automatically.
- `"forward"` and `"back"` trigger `browser.tabs.goForward()` / `browser.tabs.goBack()`
  respectively.

## Return Value

```ts
{
  content: [{ type: "text", text: "Navigated to <finalUrl>" }]
}
```

Where `<finalUrl>` is the tab's `url` after navigation settles.

## Behavior

1. Resolve the real tab ID from the virtual tab ID via the Tabs Manager (Spec 013).
2. For URL navigation: call `browser.tabs.update(realTabId, { url: normalizedUrl })`.
3. For history navigation: call `browser.tabs.goForward(realTabId)` or `browser.tabs.goBack(realTabId)`.
4. Wait for the `browser.tabs.onUpdated` event where `changeInfo.status === "complete"` for
   the target tab.
5. Resolve with the tab's final URL.
6. Timeout: if navigation does not complete within **30 seconds**, return `isError: true` with
   "Navigation timed out after 30 seconds".

### Navigation Settlement

Listen for `browser.tabs.onUpdated` with matching `tabId` and `changeInfo.status === "complete"`.
Remove the listener after resolving or timing out.

## Error Handling

| Condition                      | Behavior                                                 |
|-------------------------------|----------------------------------------------------------|
| `url` is empty                 | `isError: true`, "url must be a non-empty string"        |
| Tab not found                  | `isError: true`, "Tab not found: <tabId>"                |
| Navigation blocked by browser  | `isError: true`, error message from browser API          |
| Timeout (> 30s)               | `isError: true`, "Navigation timed out after 30 seconds" |
| Restricted URL (e.g., about:) | `isError: true`, pass through browser error              |

## Test Cases

| ID  | Input                             | Expected Output                                          |
|-----|-----------------------------------|----------------------------------------------------------|
| T1  | `url: "https://example.com"`      | Navigates; returns "Navigated to https://example.com"    |
| T2  | `url: "example.com"` (no scheme)  | Prepends https://; navigates to "https://example.com"    |
| T3  | `url: "back"`                     | Calls goBack; returns with previous URL                  |
| T4  | `url: "forward"`                  | Calls goForward; returns with next URL                   |
| T5  | `url: ""`                         | `isError: true`                                          |
| T6  | Invalid tabId                      | `isError: true`, "Tab not found"                         |
| T7  | Navigation takes > 30s             | `isError: true`, timeout message                         |
