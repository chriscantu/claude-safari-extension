# Spec 007 — form_input

## Overview

`form_input` sets the value of a form element (input, textarea, select, checkbox) identified
by `ref_id`. It dispatches the appropriate DOM events so that React, Vue, and other frameworks
detect the change correctly.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/form-input.js`
- Content: Injected into active tab via `browser.scripting.executeScript`
- Tool name: `"form_input"`

## Tool Arguments

```ts
{
  ref:   string;             // ref_id of the target element (required)
  value: string | boolean;   // Value to set (required)
  tabId?: number;            // Virtual tab ID. Defaults to active tab.
}
```

- For `input[type=checkbox]` / `input[type=radio]`: `value` is a boolean (checked state).
- For `select`: `value` may be the option's `value` attribute or visible text (case-insensitive match).
- For all others: `value` must be a string.

## Return Value

```ts
{
  content: [{ type: "text", text: "Value set successfully" }]
}
```

On error:
```ts
{
  isError: true,
  content: [{ type: "text", text: "<error message>" }]
}
```

## Behavior

### Standard Inputs (text, email, password, number, textarea)

1. Focus the element (`element.focus()`).
2. Set `element.value = value`.
3. Dispatch events in order: `input` (bubbles), `change` (bubbles).
4. For React compatibility: use `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)` before dispatching events.

### Checkbox / Radio

1. Set `element.checked = value` (boolean).
2. Dispatch `change` event (bubbles).

### Select

1. Find the matching `<option>` by `option.value === value` (exact), then by
   `option.textContent.trim().toLowerCase() === value.toLowerCase()` (text match).
2. If found, set `element.value = matchedOption.value`.
3. Dispatch `change` event.
4. If not found, return `isError: true`, `"Option '<value>' not found in select"`.

### Other Elements

If the element has `contenteditable="true"`: set `element.textContent = value`, dispatch `input` and `change`.

If the element is none of the above categories: return `isError: true`, `"Element is not a form field"`.

## Event Dispatch Helper

All events must be dispatched with `{ bubbles: true, cancelable: true }`.

## Error Handling

| Condition                      | Behavior                                                  |
|-------------------------------|-----------------------------------------------------------|
| `ref` not found on page        | `isError: true`, "Element 'ref_id' not found"            |
| Element is disabled            | `isError: true`, "Element is disabled"                   |
| Element is readonly            | `isError: true`, "Element is readonly"                   |
| Option not found (select)      | `isError: true`, "Option '<value>' not found in select"  |
| Not a form element             | `isError: true`, "Element is not a form field"           |
| Tab not accessible             | `isError: true`, "Cannot access tab <tabId>"             |

## Test Cases

| ID  | Input                                             | Expected Output                                    |
|-----|---------------------------------------------------|----------------------------------------------------|
| T1  | Text input, `value: "hello"`                      | `element.value === "hello"`, events dispatched     |
| T2  | Checkbox, `value: true`                           | `element.checked === true`, change event           |
| T3  | Select, `value: "option-value"`                   | Correct option selected, change event              |
| T4  | Select, `value: "Option Label"` (text match)      | Correct option selected                            |
| T5  | Select, `value: "nonexistent"`                    | `isError: true`, option not found message          |
| T6  | Disabled input                                    | `isError: true`, "Element is disabled"             |
| T7  | `ref` not found                                   | `isError: true`, "Element 'ref_id' not found"      |
| T8  | Non-form element (e.g., a div)                    | `isError: true`, "Element is not a form field"     |
| T9  | React-controlled input                            | React state updates (via native setter + events)   |
| T10 | Textarea, multi-line value                        | Value set, events fired                            |
