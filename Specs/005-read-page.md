# Spec 005 — read_page

## Overview

`read_page` returns an accessibility-tree snapshot of the active tab's page. Each node in the
tree has a stable reference ID (`ref_id`) that other tools (e.g., `find`, `form_input`,
`computer`) use to target elements.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/read-page.js`
- Content: `ClaudeInSafari Extension/Resources/content-scripts/accessibility-tree.js`
- Tool name: `"read_page"`

## Tool Arguments

```ts
{
  tabId?:    number;   // Virtual tab ID (from tabs manager). Defaults to active tab.
  depth?:    number;   // Max tree depth to traverse. Default: 15.
  filter?:   "all" | "interactive";
             // "all"         = all visible + non-visible elements (default)
             // "interactive" = only buttons, inputs, links, selects, textareas
  max_chars?: number;  // Truncate output to this many characters. Default: 50000.
  ref_id?:   string;   // If provided, return only the subtree rooted at this element.
             //            Returns error if ref_id is not found.
}
```

## Return Value

```ts
{
  content: [{
    type: "text",
    text: string  // Serialized accessibility tree (see format below)
  }]
}
```

### Tree Format

Each element is rendered as one line:
```
<indent><role> <name> [ref=<ref_id>] [<state-flags>]
```

- `<indent>` — two spaces per depth level
- `<role>` — ARIA role or HTML tag (e.g., `button`, `link`, `input`, `img`, `heading`)
- `<name>` — accessible name (from aria-label > aria-labelledby > label > innerText, truncated to 80 chars)
- `<ref_id>` — stable reference ID assigned by `accessibility-tree.js`; persists until page reload
- `<state-flags>` — space-separated: `disabled`, `checked`, `expanded`, `selected`, `required`

Example:
```
StaticText Hello World [ref=ref_3]
  button Submit [ref=ref_7] disabled
  input Email [ref=ref_12] required
```

## Behavior

1. Background script calls `browser.scripting.executeScript` to inject and invoke the
   accessibility tree builder in the target tab.
2. `accessibility-tree.js` assigns `ref_id` values to elements that don't yet have them
   (via a `data-claude-ref` attribute), then walks the DOM from the specified root.
3. Ref IDs are stable within a page session: the same element always returns the same `ref_id`
   until the page is reloaded or navigated.
4. The ref counter is stored in `window.__claudeRefCounter` (integer, starts at 1).
5. If `ref_id` is specified and not found, return `isError: true` with an appropriate message.
6. Output is truncated at `max_chars` characters; if truncated, append `\n[output truncated]`.

## Filter: "interactive"

Only include elements with one of:
- Tag: `a`, `button`, `input`, `select`, `textarea`
- ARIA role: `button`, `link`, `menuitem`, `option`, `radio`, `checkbox`, `combobox`,
  `listbox`, `switch`, `tab`
- Has `tabindex >= 0` (explicitly focusable)

## Ref ID Assignment

```js
// accessibility-tree.js assigns ref IDs at traversal time
if (!element.dataset.claudeRef) {
  element.dataset.claudeRef = `ref_${window.__claudeRefCounter++}`;
}
```

The counter must be initialized once per page (`window.__claudeRefCounter = window.__claudeRefCounter || 1`).

## Error Handling

| Condition                   | Behavior                                           |
|-----------------------------|----------------------------------------------------|
| Tab not found / no access   | `isError: true`, "Cannot access tab <tabId>"       |
| ref_id not found on page    | `isError: true`, "Element ref_id '<id>' not found" |
| Script injection fails      | `isError: true`, error message from browser        |
| Page is a restricted URL    | `isError: true`, "Cannot access this page"         |

## Test Cases

| ID  | Input                             | Expected Output                                       |
|-----|-----------------------------------|-------------------------------------------------------|
| T1  | Basic page with buttons/inputs    | Tree includes button/input nodes with ref_ids         |
| T2  | `filter: "interactive"`           | Only interactive elements included                    |
| T3  | `depth: 2`                        | Tree nodes at depth > 2 omitted                       |
| T4  | `ref_id: "ref_5"` (exists)        | Returns subtree rooted at that element                |
| T5  | `ref_id: "ref_999"` (not exists)  | `isError: true`                                       |
| T6  | Calling twice on same page        | Same elements get same `ref_id`s                      |
| T7  | Output exceeds `max_chars`        | Output truncated, ends with `[output truncated]`      |
| T8  | Restricted URL (chrome://)        | `isError: true`                                       |
