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
- **One thing at a time**: always work on a single feature or fix per session; create a dedicated feature branch (`git checkout -b fix/...` or `feature/...`) before touching any code
- **Implementation plans** live in `docs/plans/` — one file per feature, named `YYYY-MM-DD-<feature>.md`

## Key Technical Decisions
- **MV2 manifest** with `"persistent": true` — MV2 avoids MV3's service-worker lifecycle unpredictability on macOS Safari; `persistent: true` is required on Safari 26+ because the background page never bootstraps with `false` (the event that would wake it never fires, since polling is initiated from the background itself)
- **ScreenCaptureKit** for screenshots (Safari's `captureVisibleTab` is unreliable)
- **AppleScript** for window management (Safari's `browser.windows` API is limited)
- **Virtual tab groups** via `browser.storage.session` (no `browser.tabGroups` API in Safari)
- **GCD-based Unix domain socket** for MCP server (NWListener doesn't support UDS)
- **Newline-delimited JSON** framing (MCP stdio transport) — matches `MessageFramer.swift` and the MCP stdio spec

## Socket Path Convention
`/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock` — must match Claude Code CLI expectations

## Extension Workflow — Critical Rules

See `docs/debugging.md` for the full troubleshooting guide. Key rules:

- **Never run `xcodebuild clean` alone.** The first build after a clean produces an invalid app signature, causing pluginkit to silently drop the extension and it disappears from Safari Settings. Always use `make clean` (which runs `clean build` in one invocation) or just `make build`.
- **Never use `pluginkit -e use/ignore`.** Force-overriding pluginkit state conflicts with Safari's native extension management and can prevent the background page from loading. Use `pluginkit -e default` to reset, or don't touch pluginkit at all.
- **`make kill` kills zombie Xcode debug processes.** Xcode's debugserver can hold the app process in `TX` (stopped) state, blocking extension loading. Always use `make kill` rather than `pkill` directly.
- **Safari caches background page JS.** After `make kill && make run`, Safari does NOT reload the extension's JavaScript. Every JS change (background.js, tool handlers, content scripts) requires `make safari-restart`. Swift-only changes work with just `make kill && make build && make run`.
- **`make dev` never restarts Safari.** Safari restart resets "Allow Unsigned Extensions". Use `make safari-restart` for JS changes; avoid it for Swift-only changes.
- **Standard recovery when extension stops loading:** `make kill && make build && make run && make health`. If health fails: toggle extension in Settings, check Allow Unsigned Extensions. If still failing: `make safari-restart`.

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
- **MV2 persistent background page**: We use `"persistent": true` (required on Safari 26+). The background page runs continuously; no suspension risk. The `browser.alarms` keepalive is kept for forward compatibility but is no longer load-bearing.
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
