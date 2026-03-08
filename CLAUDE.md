# Claude in Safari — Project Context

## What This Is
A macOS Safari Web Extension that replicates the "Claude in Chrome" browser automation extension. It allows Claude Code CLI to control Safari via MCP (Model Context Protocol).

## Architecture
- **Native Swift App** (`ClaudeInSafari/`): MCP socket server, screenshot capture, window management, file I/O
- **Safari Web Extension** (`ClaudeInSafari Extension/`): Background script, content scripts, tool handlers
- Communication: CLI → Unix domain socket → Native App → `browser.runtime.sendNativeMessage()` → Extension → Content Scripts → Web Page

## Rules
- Always read PRINCIPLES.md before implementing any feature
- Always check STRUCTURE.md before creating or moving files
- Feature workflow: Spec → Test → Implement → Verify structure
- Run `xcodebuild test` after every change to verify tests pass

## Key Technical Decisions
- **MV2 manifest** (not MV3) for persistent background page reliability on macOS Safari
- **ScreenCaptureKit** for screenshots (Safari's `captureVisibleTab` is unreliable)
- **AppleScript** for window management (Safari's `browser.windows` API is limited)
- **Virtual tab groups** via `browser.storage.session` (no `browser.tabGroups` API in Safari)
- **GCD-based Unix domain socket** for MCP server (NWListener doesn't support UDS)
- **4-byte big-endian length-prefix** framing to match Chrome's native messaging host protocol

## Socket Path Convention
`/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock` — must match Claude Code CLI expectations

## Chrome Extension Reference
Source at: `~/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.59_0/`
- `assets/mcpPermissions-DCuIPzw1.js` — all tool definitions
- `assets/accessibility-tree.js-D8KNCIWO.js` — accessibility tree generator (port verbatim)
- `assets/service-worker.ts-B8kO2DT6.js` — service worker message routing

## Code Review Checklist

Every PR review MUST verify all three areas:

### 1. Safari Extension Best Practices
- **Event listener lifecycle**: Any Promise that registers a browser event listener (`onUpdated`, `onRemoved`, etc.) MUST clean up that listener on ALL exit paths (resolve, reject, timeout). Use a `settled` guard flag to prevent double-settlement races.
- **Cancellable promises**: Promises that own external resources (listeners, timers) MUST expose a `.cancel()` method. Callers MUST invoke `.cancel()` when abandoning a promise early (e.g., in a `catch` block).
- **MV2 non-persistent background page**: With `"persistent": false`, listeners registered inside Promises may be lost if the background page is suspended. Document this risk in JSDoc where relevant.
- **`browser.tabs.onRemoved`**: Navigation settlement MUST listen for tab closure and reject immediately with a clear error rather than waiting for the 30s timeout.
- **BFCache / history navigation**: `goBack()`/`goForward()` may complete without a `"loading"` status event in Safari (BFCache). Do not require a `"loading"` event before accepting `"complete"` for history navigations.
- **Manifest load order**: `background.scripts` in `manifest.json` determines execution order and dependency availability. The load-order comment in `background.js` MUST stay in sync with the manifest.
- **`alarms` permission**: `browser.alarms` may require explicit permission in Safari MV2 — verify before relying on keepalive alarms.

### 2. STRUCTURE.md Compliance
- **Tool handlers**: one file per MCP tool, placed in `ClaudeInSafari Extension/Resources/tools/`, named in kebab-case.
- **Tests**: JavaScript tests in `Tests/JS/` named `<source-file>.test.js`.
- **Specs**: one file per feature in `Specs/`, named `NNN-description.md`.
- **No new files** outside the canonical layout without user approval (PRINCIPLES.md rule 5).
- **Background script load order**: each new tool file added to `manifest.json` background.scripts MUST also be reflected in the load-order comment in `background.js`.

### 3. DRY / SOLID Principles
- **Single Responsibility**: each tool file implements exactly one MCP tool. Helper logic (URL normalization, navigation settlement) belongs in private functions within that file, not shared utilities, unless reused by 2+ tools.
- **Don't Repeat Yourself**: tab resolution MUST use `globalThis.resolveTab` from `tabs-manager.js`. Tool registration MUST use `globalThis.registerTool` from `tool-registry.js`. Never re-implement either.
- **Inter-module contracts**: tools communicate via `globalThis` only for the two established shared helpers (`resolveTab`, `registerTool`). Any new shared helper must be explicitly exported via `globalThis` in `tabs-manager.js` or `tool-registry.js` and documented.
- **No duplication across tool files**: if the same logic appears in two tool files, extract it — but only after it is genuinely needed in two places.
