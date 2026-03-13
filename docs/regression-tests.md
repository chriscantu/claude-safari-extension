# Regression Test Suite

Manual regression checklist for Claude in Safari. Run before merging any PR that touches
tool handlers, ToolRouter, background.js, content scripts, or the native bridge.

Automated tests (`npm test`, `xcodebuild test`) must pass first — this document covers
what automated tests cannot: live Safari interaction, permission gates, and cross-tool flows.

---

## Prerequisites

Before running any manual tests:

```fish
make dev          # Build, launch app, create dev.sock symlink
make list-tools   # Verify all tools are registered (should list ~16 tools)
make status       # Confirm app process + socket are present
```

**Required system permissions** (System Settings → Privacy & Security):
- Screen Recording → Claude in Safari ✅
- Automation → osascript → Safari ✅
- Accessibility → osascript ✅ *(resize_window only)*

**Safari requirements:**
- Extension installed and enabled (Preferences → Extensions → Claude in Safari ✅)
- Extension background page active (visible in Develop → Web Extension Background Pages)
- **Safari must be the frontmost app** for all `executeScript`-based tools

To activate Safari before each `make send` call, the Makefile does this automatically via `osascript`. If tests are failing with "Extension response timeout", bring Safari to the front manually.

---

## 1  Automated Tests

Run these first. All must pass before proceeding to manual tests.

```fish
npm test
# Expected: 350 tests pass, 16 suites, 0 failures

make test-swift
# Expected: 17 tests pass, 0 failures

node scripts/validate-injected-scripts.js
# Expected: All tool files pass syntax validation
```

---

## 2  Infrastructure

### 2.1  Socket & connection

```fish
make status
```

- [ ] App process is listed
- [ ] Socket file exists at `/tmp/claude-mcp-browser-bridge-<username>/dev.sock`
- [ ] Extension process is listed (Safari launched the extension)

```fish
make list-tools
```

- [ ] Returns tool list with ~16 tool names (no error)
- [ ] `upload_image` is present
- [ ] `gif_creator` is present
- [ ] `file_upload` is present

### 2.2  Fast-fail: unknown tool

```fish
make send TOOL=nonexistent_tool ARGS='{}'
```

- [ ] Returns error "Unknown tool" or similar (not a timeout)

---

## 3  Screenshot & Image Tools

### 3.1  Full screenshot

```fish
make send TOOL=computer ARGS='{"action":"screenshot"}'
```

- [ ] Returns base64 PNG image block
- [ ] Result text includes `imageId: <uuid>`
- [ ] Result text includes "Use this imageId with upload_image"

### 3.2  Zoom

Navigate to a page with visible content first:

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=computer ARGS='{"action":"screenshot"}'
# Note viewport dimensions from result (e.g. 1280×800)
make send TOOL=computer ARGS='{"action":"zoom","coordinate":[0,0,640,400]}'
```

- [ ] Returns a cropped/zoomed PNG image block
- [ ] Returned image is visibly smaller region than full screenshot
- [ ] Result text includes `imageId: <uuid>`

### 3.3  Screenshot — Screen Recording permission denied

*(Skip if you can't temporarily revoke permission)*

Revoke Screen Recording permission, then:

```fish
make send TOOL=computer ARGS='{"action":"screenshot"}'
```

- [ ] Returns actionable error mentioning Screen Recording permission
- [ ] Does not hang or timeout

---

## 4  Navigation

### 4.1  URL navigation

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
```

- [ ] Safari navigates to example.com
- [ ] Returns success (no error)

### 4.2  Auto-scheme prepend

```fish
make send TOOL=navigate ARGS='{"url":"example.com"}'
```

- [ ] Safari navigates successfully (https:// prepended automatically)

### 4.3  Back/forward

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=navigate ARGS='{"url":"https://www.iana.org/domains/reserved"}'
make send TOOL=navigate ARGS='{"url":"back"}'
```

- [ ] Safari goes back to example.com
- [ ] Returns success (BFCache handled correctly — no "loading" event required)

---

## 5  Page Reading

### 5.1  read_page

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=read_page ARGS='{}'
```

- [ ] Returns accessibility tree with role/name pairs
- [ ] Elements have `ref_id` values (`data-claude-ref` attributes visible in DevTools)
- [ ] Tree is indented / formatted

### 5.2  get_page_text

```fish
make send TOOL=get_page_text ARGS='{}'
```

- [ ] Returns plain text of page content
- [ ] Scripts/styles are stripped
- [ ] Does not include nav/header/footer boilerplate

### 5.3  find

```fish
make send TOOL=find ARGS='{"query":"More information"}'
```

- [ ] Returns at least one result with ref_id, role, name
- [ ] Result includes bounding rect

---

## 6  Page Interaction

### 6.1  click

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=read_page ARGS='{}'
# Note the ref_id for the "More information..." link
make send TOOL=computer ARGS='{"action":"left_click","ref":"<ref_id_from_above>"}'
```

- [ ] Safari navigates to iana.org (link was followed)

### 6.2  type

```fish
make send TOOL=navigate ARGS='{"url":"https://www.google.com"}'
make send TOOL=find ARGS='{"query":"search input"}'
# Note ref_id of search input
make send TOOL=computer ARGS='{"action":"left_click","ref":"<ref_id>"}'
make send TOOL=computer ARGS='{"action":"type","text":"hello world"}'
```

- [ ] "hello world" appears in Google search box

### 6.3  scroll

```fish
make send TOOL=navigate ARGS='{"url":"https://en.wikipedia.org/wiki/Safari"}'
make send TOOL=computer ARGS='{"action":"scroll","coordinate":[640,400],"scroll_direction":"down","scroll_distance":3}'
```

- [ ] Page scrolls down

### 6.4  form_input — text input

```fish
make send TOOL=navigate ARGS='{"url":"https://www.google.com"}'
make send TOOL=find ARGS='{"query":"search box"}'
make send TOOL=form_input ARGS='{"ref":"<ref_id>","value":"test query"}'
```

- [ ] Search box value is set to "test query"
- [ ] Returns success (no error)

### 6.5  form_input — select

Navigate to a page with a `<select>` element, then:

```fish
make send TOOL=form_input ARGS='{"ref":"<select_ref>","value":"<option_value>"}'
```

- [ ] Select changes to specified option
- [ ] change event fired (frameworks react to it)

---

## 7  JavaScript Tool

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=javascript_tool ARGS='{"action":"javascript_exec","code":"document.title"}'
```

- [ ] Returns `"Example Domain"` (or current page title)

```fish
make send TOOL=javascript_tool ARGS='{"action":"javascript_exec","code":"1 + 1"}'
```

- [ ] Returns `"2"`

```fish
make send TOOL=javascript_tool ARGS='{"action":"javascript_exec","code":"await fetch(\"https://example.com\").then(r => r.status)"}'
```

- [ ] Returns `"200"` (async code resolved correctly)

---

## 8  Console & Network Monitoring

### 8.1  read_console_messages

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=javascript_tool ARGS='{"action":"javascript_exec","code":"console.log(\"regression-test\")"}'
make send TOOL=read_console_messages ARGS='{"tabId":1}'
```

- [ ] Output includes `[log] regression-test` entry

### 8.2  read_network_requests

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=read_network_requests ARGS='{"tabId":1}'
```

- [ ] At least one network request listed for example.com
- [ ] Format: `[fetch/xhr] METHOD url → status statusText (Xms)`

---

## 9  Window Resize

```fish
make send TOOL=resize_window ARGS='{"width":1200,"height":800}'
```

- [ ] Safari window resizes to approximately 1200×800
- [ ] Returns "Resized Safari window to 1200×800"

```fish
make send TOOL=resize_window ARGS='{"width":100,"height":100}'
```

- [ ] Returns error: "Width must be at least 200 pixels"
- [ ] Window does not change

---

## 10  Upload Image

### 10.1  Fast-fail: unknown imageId

```fish
make send TOOL=upload_image ARGS='{"imageId":"no-such-id","ref":"some-ref"}'
```

- [ ] Returns immediate error "Image not found: no-such-id"
- [ ] Does **not** wait 30 seconds

### 10.2  Fast-fail: missing imageId

```fish
make send TOOL=upload_image ARGS='{"ref":"some-ref"}'
```

- [ ] Returns error "imageId parameter is required"

### 10.3  Fast-fail: both ref and coordinate

```fish
make send TOOL=upload_image ARGS='{"imageId":"x","imageData":"x","ref":"r","coordinate":[10,10]}'
```

- [ ] Returns error "Provide either ref or coordinate, not both"

### 10.4  E2E — ref path *(requires extension loaded)*

Open a local test page with `<input type="file" data-claude-ref="upload-test">`, then:

```fish
make send TOOL=computer ARGS='{"action":"screenshot"}'
# Note imageId from result
make send TOOL=upload_image ARGS='{"imageId":"<imageId>","ref":"upload-test"}'
```

- [ ] File input shows 1 file selected
- [ ] Returns "Image uploaded to file input upload-test"

### 10.5  E2E — coordinate drag-drop path *(requires extension loaded)*

On a page that accepts file drops:

```fish
make send TOOL=computer ARGS='{"action":"screenshot"}'
make send TOOL=upload_image ARGS='{"imageId":"<imageId>","coordinate":[640,400]}'
```

- [ ] Returns "Image uploaded via drag-drop at (640, 400)"

---

## 11  GIF Creator

### 11.1  Full record/export cycle

```fish
make send TOOL=gif_creator ARGS='{"action":"start_recording"}'
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=navigate ARGS='{"url":"https://www.iana.org/domains/reserved"}'
make send TOOL=gif_creator ARGS='{"action":"stop_recording"}'
make send TOOL=gif_creator ARGS='{"action":"export","filename":"regression-test.gif"}'
```

- [ ] start_recording returns "Recording started"
- [ ] stop_recording returns frame count > 0
- [ ] export returns base64 GIF image block
- [ ] `~/Desktop/regression-test.gif` exists and opens in Preview

### 11.2  Fast-fail: export with no frames

```fish
make send TOOL=gif_creator ARGS='{"action":"clear"}'
make send TOOL=gif_creator ARGS='{"action":"export"}'
```

- [ ] Returns error "No frames recorded"

---

## 12  Tabs Manager

```fish
make send TOOL=tabs_context_mcp ARGS='{}'
```

- [ ] Returns tab group context (or "No MCP tab group exists" if none created)

```fish
make send TOOL=tabs_create_mcp ARGS='{"url":"https://example.com"}'
```

- [ ] New Safari tab opens with example.com
- [ ] Returns virtual tab ID

---

## 13  Cross-Tool E2E Flows

These exercise multiple tools in sequence — the most valuable regression scenarios.

### 13.1  Screenshot → upload to file input

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=computer ARGS='{"action":"screenshot"}'
# Note imageId
# Open a page with file input...
make send TOOL=upload_image ARGS='{"imageId":"<imageId>","ref":"<file-input-ref>"}'
```

- [ ] Image from screenshot appears in the file input

### 13.2  Navigate → read_page → click → verify navigation

```fish
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=read_page ARGS='{}'
# Find the "More information..." link ref_id
make send TOOL=computer ARGS='{"action":"left_click","ref":"<ref_id>"}'
make send TOOL=get_page_text ARGS='{}'
```

- [ ] Page text is from iana.org (navigation succeeded via click)

### 13.3  Navigate → find → form_input → javascript_tool verify

```fish
make send TOOL=navigate ARGS='{"url":"https://www.google.com"}'
make send TOOL=find ARGS='{"query":"search input"}'
make send TOOL=form_input ARGS='{"ref":"<ref_id>","value":"safari extension test"}'
make send TOOL=javascript_tool ARGS='{"action":"javascript_exec","code":"document.querySelector(\"input[name=q]\")?.value"}'
```

- [ ] JavaScript returns `"safari extension test"`

### 13.4  GIF recording across navigation

```fish
make send TOOL=gif_creator ARGS='{"action":"start_recording"}'
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make send TOOL=computer ARGS='{"action":"screenshot"}'
make send TOOL=navigate ARGS='{"url":"https://www.iana.org/domains/reserved"}'
make send TOOL=computer ARGS='{"action":"screenshot"}'
make send TOOL=gif_creator ARGS='{"action":"stop_recording"}'
make send TOOL=gif_creator ARGS='{"action":"export","filename":"regression-nav.gif"}'
```

- [ ] GIF contains at least 2 frames showing the two different pages
- [ ] File written to `~/Desktop/regression-nav.gif`

---

## 14  Error & Edge Cases

### 14.1  Tab closed mid-tool

Start a slow operation, close the tab:

```fish
make send TOOL=javascript_tool ARGS='{"action":"javascript_exec","code":"await new Promise(r => setTimeout(r, 5000))"}'
# Immediately close the active Safari tab
```

- [ ] Tool returns an error (does not hang indefinitely)
- [ ] App process still running after (`make status`)

### 14.2  Safari not frontmost

Bring another app to the foreground, then:

```fish
python3 scripts/mcp-test.py call read_page '{}'
```

*(Note: using mcp-test.py directly, which skips the `osascript activate` in the Makefile)*

- [ ] Returns error or "Extension response timeout" — not a crash
- [ ] `make send` (which activates Safari) then works correctly

### 14.3  Multiple rapid tool calls

```fish
for i in (seq 5)
    make send TOOL=computer ARGS='{"action":"screenshot"}' &
end
wait
```

- [ ] All 5 calls return a screenshot result (no crashes or corrupted responses)

---

## Checklist Summary

Copy this into a PR description when a full regression run is required:

```
### Regression Test Results

- [ ] 1. Automated tests (npm test + xcodebuild test + validate-injected-scripts)
- [ ] 2. Infrastructure: socket, list-tools, fast-fail unknown tool
- [ ] 3. Screenshot: full screenshot, zoom
- [ ] 4. Navigation: URL, auto-scheme, back/forward
- [ ] 5. Page reading: read_page, get_page_text, find
- [ ] 6. Page interaction: click, type, scroll, form_input
- [ ] 7. JavaScript tool: sync, async
- [ ] 8. Console & network monitoring
- [ ] 9. Window resize
- [ ] 10. Upload image: fast-fail paths, E2E ref path, E2E drag-drop
- [ ] 11. GIF creator: record/export cycle, fast-fail no frames
- [ ] 12. Tabs manager
- [ ] 13. Cross-tool E2E flows
- [ ] 14. Error & edge cases
```
