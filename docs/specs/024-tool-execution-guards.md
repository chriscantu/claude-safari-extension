# Spec 024 — Tool Execution Guards

## Goal
Harden tool execution in three areas: (1) detect tab closure during executeScript, (2) reject malformed payloads early, (3) auto-activate Safari before tools that require it to be frontmost.

## Motivation
Currently, if a tab closes while `computer.js` is running an executeScript call, the error is caught generically. There's no upfront schema validation for `computer` args beyond action routing. And tools requiring Safari frontmost silently fail with cryptic WebKit errors if Safari is in the background.

## Scope

### 1. computer.js tab-closed guards
Replace all direct `browser.tabs.executeScript()` calls in action handlers (click, hover, type, key, scroll, scrollTo, drag) with `globalThis.executeScriptWithTabGuard()` from `tool-registry.js`.

The guard provides:
- `browser.tabs.onRemoved` listener that rejects immediately on tab close
- 30s timeout
- Settled-flag preventing double-settlement
- `.cancel()` method for early abandonment

Error handling: if the error message contains "was closed during", use as-is. Otherwise pass through `classifyExecuteScriptError`.

### 2. Immediate error on bad payload
Add upfront validation in `handleComputer()` for action-specific required parameters **before** resolving the tab or calling the handler:
- `type` / `key`: require `text` (string)
- `scroll`: require `scroll_direction` (string)
- `scroll_to`: require `ref` (string)
- `left_click_drag`: require `start_coordinate` and `coordinate`
- Click/hover actions: require coordinate or ref (already validated in handlers, but move check earlier)

This catches obviously bad payloads before any async work (tab resolution, executeScript).

### 3. Safari-frontmost auto-activation
In `ToolRouter.swift`, activate Safari before forwarding tool calls that use `executeScript`:
- Tools forwarded to extension that need executeScript: `computer` (non-screenshot/zoom), `find`, `read_page`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`
- Tools already handled natively that then forward to extension: `upload_image`, `file_upload`

Add `activateSafariIfNeeded()` using `NSWorkspace.shared.runningApplications` to find and activate Safari. Call it in `forwardToExtension()` for the relevant tools.

## Files Modified
- `ClaudeInSafari Extension/Resources/tools/computer.js` — tab guards + payload validation
- `ClaudeInSafari/MCP/ToolRouter.swift` — Safari activation
- `Tests/JS/computer.test.js` — new tests for tab guards + payload validation
- `Tests/Swift/ToolRouterTests.swift` — new tests for Safari activation

## Out of Scope
- Tab guards for other executeScript-based tools (find.js, form-input.js, etc.) — PR 3 or separate PR
- Resource management (tab group pruning, poll backoff) — PR 3
