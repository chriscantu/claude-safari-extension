# Spec 009 — get_page_text

## Overview

`get_page_text` extracts the human-readable text content from the active tab's page, with
priority given to article/main content. It returns plain text without HTML markup.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/get-page-text.js`
- Content: Injected into active tab via `browser.scripting.executeScript`
- Tool name: `"get_page_text"`

## Tool Arguments

```ts
{
  tabId?: number;  // Virtual tab ID. Defaults to active tab.
}
```

## Return Value

```ts
{
  content: [{ type: "text", text: string }]
}
```

The text is plain prose with newlines preserved; HTML tags are stripped.

## Extraction Algorithm

### Priority Order

1. **`<article>` element** — if exactly one exists, use `article.innerText`
2. **`<main>` element** — if no article, use `main.innerText`
3. **`[role="main"]`** — if no `<main>`, use the first element with `role="main"`
4. **`document.body`** — fallback if none of the above exist

### Post-Processing

1. Replace multiple consecutive blank lines with a single blank line.
2. Trim leading/trailing whitespace from each line.
3. Remove lines that are empty after trimming.
4. Trim the final result.
5. Truncate to **100,000 characters** maximum. If truncated, append `"\n[content truncated]"`.

### Excluded Elements

Before extracting `innerText`, remove (via cloning and manipulating the clone):
- `<script>`, `<style>`, `<noscript>` elements
- `[aria-hidden="true"]` elements
- `<nav>`, `<header>`, `<footer>` elements (when using body fallback only)

**Note:** Removal applies to the clone, not the live DOM.

## Error Handling

| Condition               | Behavior                                         |
|-------------------------|--------------------------------------------------|
| Tab not accessible      | `isError: true`, "Cannot access tab <tabId>"    |
| Empty page / no body    | Return empty string (not an error)              |
| Script injection fails  | `isError: true`, error message                  |

## Test Cases

| ID  | Input                                    | Expected Output                                     |
|-----|------------------------------------------|-----------------------------------------------------|
| T1  | Page with `<article>` containing text    | Returns article text only                           |
| T2  | Page with `<main>` but no `<article>`    | Returns main text                                   |
| T3  | Plain page with only `<body>`            | Returns body text (nav/header/footer excluded)      |
| T4  | Page with multiple blank lines           | Collapsed to single blank line                      |
| T5  | Page with `<script>` in body            | Script content not included in output               |
| T6  | Page with `aria-hidden="true"` section  | Hidden section excluded                             |
| T7  | Page text > 100,000 chars               | Truncated with `[content truncated]` appended       |
| T8  | Empty page                              | Empty string returned (no error)                    |
