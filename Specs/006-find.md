# Spec 006 — find

## Overview

`find` searches the active tab's page for elements matching a natural language query.
It returns up to 20 matching elements with their `ref_id`, role, name, and bounding rect.
Results can be used directly with `computer` (click/hover) and `form_input`.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/find.js`
- Content: Injected into active tab via `browser.scripting.executeScript`
- Tool name: `"find"`

## Tool Arguments

```ts
{
  query: string;   // Natural language description of what to find (required)
  tabId?: number;  // Virtual tab ID. Defaults to active tab.
}
```

## Return Value

```ts
{
  content: [{
    type: "text",
    text: string  // Serialized match list (see format below)
  }]
}
```

### Match Format

```
Found <N> match(es) for "<query>":

1. <role> "<name>" [ref=<ref_id>] at (<x>, <y>, <width>x<height>)
2. ...
```

If more than 20 matches: append `\nNote: showing first 20 of <total> matches. Use a more specific query to narrow results.`

If 0 matches: `No elements found matching "<query>".`

## Matching Algorithm

Matching is text-based (no ML), performed in the content script:

1. **Exact text match** — elements whose accessible name exactly matches `query` (case-insensitive)
2. **Partial text match** — elements whose accessible name contains `query` (case-insensitive)
3. **Placeholder match** — `input[placeholder]` and `textarea[placeholder]` where placeholder contains `query`
4. **ARIA label match** — `aria-label` or `aria-labelledby` content contains `query`
5. **Role + keyword** — if query contains a role keyword (e.g., "search bar", "login button"),
   attempt to match by role + partial name; role keywords: `button`, `link`, `input`,
   `checkbox`, `radio`, `select`, `heading`, `image`, `img`, `form`

Results are deduplicated (same DOM element cannot appear twice). Priority order: exact > partial > placeholder > aria-label > role+keyword.

## Ref ID Assignment

Same mechanism as `read_page`: elements receive `data-claude-ref` if not already assigned.
The shared `window.__claudeRefCounter` is used.

## Bounding Rect

Use `element.getBoundingClientRect()`. Report `{x, y, width, height}` in viewport pixels.
Elements with `width === 0 && height === 0` are excluded from results unless they are
`input[type=hidden]` (which are reported without bounding rect).

## Error Handling

| Condition               | Behavior                                           |
|-------------------------|----------------------------------------------------|
| `query` is empty        | `isError: true`, "query must be a non-empty string"|
| Tab not accessible      | `isError: true`, "Cannot access tab <tabId>"       |
| Script injection fails  | `isError: true`, error message                     |

## Test Cases

| ID  | Input                                      | Expected Output                                         |
|-----|--------------------------------------------|---------------------------------------------------------|
| T1  | `query: "Submit"` on page with Submit btn  | Returns button with name "Submit"                       |
| T2  | `query: "search bar"` on page with input   | Returns search input                                    |
| T3  | `query: "nonexistent xyz123"`              | "No elements found matching..."                         |
| T4  | Page with 25 matching elements             | Returns 20, appends "showing first 20 of 25" note       |
| T5  | `query: ""`                               | `isError: true`                                         |
| T6  | Same element matches multiple criteria     | Appears only once in results (deduplication)            |
| T7  | Zero-size element                          | Excluded from results                                   |
| T8  | `input[type=hidden]` matches query         | Included without bounding rect                          |
