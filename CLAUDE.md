# Claude in Safari — Project Context

## What This Is
A macOS Safari Web Extension that replicates the "Claude in Chrome" browser automation extension. It allows Claude Code CLI to control Safari via MCP (Model Context Protocol).

## Quick Start
```
make dev                  # Build + launch + health check (full setup)
make test-all             # Run JS + Swift unit tests
make send TOOL=navigate ARGS='{"url":"https://example.com"}'
make doctor               # Full diagnostic if something seems off
```

## Architecture
- **Native Swift App** (`ClaudeInSafari/`): MCP socket server, screenshot capture, file I/O
- **Safari Web Extension** (`ClaudeInSafari Extension/`): Background script, content scripts, tool handlers
- Communication: CLI → Unix domain socket → Native App → `browser.runtime.sendNativeMessage()` → Extension → Content Scripts → Web Page

## Rules
- Always read PRINCIPLES.md before implementing any feature
- Always check STRUCTURE.md before creating or moving files
- Feature workflow: Spec → Test → Implement → Verify structure
- **One thing at a time**: always work on a single feature or fix per session; create a dedicated feature branch (`git checkout -b fix/...` or `feature/...`) before touching any code
- **Implementation plans** live in `docs/plans/` — one file per feature, named `YYYY-MM-DD-<feature>.md`
- **Version sync**: every PR must bump the version across all 3 sources (both `Info.plist`s + `manifest.json`). Use `scripts/bump-version.sh <new-version>`. CI enforces the match.

## Build After Changes
| What changed | Command |
|---|---|
| **Swift only** | `make kill && make build && make run` |
| **Any JS** (background.js, tool handlers, content scripts) | `make safari-restart` |
| **Both** | `make safari-restart` |

Safari caches background page JS — `make kill && make run` does NOT reload JavaScript. Only `make safari-restart` forces a JS reload (note: resets "Allow Unsigned Extensions").

## Testing
- `make test` — JS unit tests (tool handlers, content scripts). Fast, run after every JS change.
- `make test-swift` — Swift XCTests (MCP server, message framing, routing). Run after Swift changes.
- `make test-all` — Both. Run before every PR.
- `make functional-check` — End-to-end: sends a real `read_page` through the full pipeline. Requires running app + Safari.
- Manual regression: `docs/regression-tests.md` — required before merge (PRINCIPLES.md rule 8).

## Extension Not Loading?
1. `make health` → passes? You're fine.
2. Fails → `make kill && make build && make run && make health`
3. Still fails → Toggle extension off/on in Safari Settings, retry `make health`
4. Still fails → `make safari-restart` (resets Allow Unsigned Extensions — re-enable in Develop menu)
5. Still fails → `make doctor` for full diagnostics
6. See `docs/debugging.md` for the complete troubleshooting guide.

## Extension Workflow — Hard Rules
- **Never run `xcodebuild clean` alone.** The first build after a clean produces an invalid app signature, causing pluginkit to silently drop the extension. Always use `make clean` (which runs `clean build` in one invocation) or just `make build`.
- **Never use `pluginkit -e use/ignore`.** Force-overriding pluginkit state conflicts with Safari's native extension management. Use `pluginkit -e default` to reset, or don't touch pluginkit at all.
- **Always use `make kill`** to stop the app — Xcode's debugserver can hold zombie processes in `TX` (stopped) state, blocking extension loading.

## Safari Pitfalls
These platform quirks affect implementation decisions across the project:
- **`executeScript` requires Safari frontmost** — fails silently otherwise. Use `activateSafariIfNeeded()` (Spec 024).
- **`browser.tabs.query` returns empty** inside native messaging handlers — needs `setTimeout(0)` dispatch + retry loop.
- **Integer `1` arrives as boolean `true`** via the Swift native bridge (NSNumber/JSON serialization) — always use explicit type checks.
- **BFCache skips `"loading"` events** — `goBack()`/`goForward()` may jump straight to `"complete"`. Don't require `"loading"` before accepting `"complete"` for history navigations.
- **`browser.storage.session` resets** if background page suspends (mitigated by `persistent: true`).
- **`read_page` refs ≠ `computer` refs** — accessibility tree uses WeakRef map (`__claudeElementMap`); `computer.js` uses `data-claude-ref` DOM attrs (set only by `find.js`). Must use `find` before `computer(ref)`.

## Key Technical Decisions
- **MV2 manifest** with `"persistent": true` — MV2 avoids MV3's service-worker lifecycle unpredictability on macOS Safari; `persistent: true` is required on Safari 26+ because the background page never bootstraps with `false` (the event that would wake it never fires, since polling is initiated from the background itself)
- **ScreenCaptureKit** for screenshots (Safari's `captureVisibleTab` is unreliable)
- **App Sandbox** enabled for App Store distribution; file access uses security-scoped bookmarks via `FileAccessManager.swift`
- **Virtual tab groups** via `browser.storage.session` (no `browser.tabGroups` API in Safari)
- **GCD-based Unix domain socket** for MCP server (NWListener doesn't support UDS)
- **Newline-delimited JSON** framing (MCP stdio transport) — matches `MessageFramer.swift` and the MCP stdio spec

## Socket Path Convention
`<AppGroupContainer>/sockets/<pid>.sock` — socket lives in the App Group container (`group.com.chriscantu.claudeinsafari`) for App Sandbox compatibility. For development, the Makefile `run` target creates a `dev.sock` symlink at `/tmp/claude-mcp-browser-bridge-<username>/dev.sock`. Production builds have no `/tmp` symlink (writing to `/tmp` from inside the sandbox triggers a file-access dialog).

## Adding a New MCP Tool
Use `/new-tool` — covers spec, tests, implementation, manifest updates, and PR creation.
Abbreviated checklist: new file in `tools/`, register via `globalThis.registerTool`, add to `manifest.json` `background.scripts`, update load-order comment in `background.js`.

## CI Pipeline
What gets checked on every PR:
1. **Version sync** — all 3 sources match, tag must not already exist
2. **JS unit tests** — `npm test`
3. **Injected script syntax** — `node scripts/validate-injected-scripts.js`
4. **Xcode build** — unsigned build for CI
5. **Swift unit tests** — XCTest suite

**Auto-deploy**: merge to `main` → `auto-tag.yml` creates version tag → `release.yml` builds signed/notarized DMG + GitHub Release.

## Chrome Extension Reference
The original "Claude in Chrome" extension is the reference implementation:
- **Chrome Web Store**: https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn
- **Local source** (if installed): `~/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/<version>/`

Key files (filenames contain build hashes — use glob patterns to find them):
- `assets/mcpPermissions-*.js` — all tool definitions
- `assets/accessibility-tree.js-*.js` — accessibility tree generator
- `assets/service-worker.ts-*.js` — service worker message routing

This reference is only needed when porting new tools. All existing tools have already been ported.

## Code Review Checklist

Every PR review MUST verify all applicable areas:

### Safari Extension Best Practices (JS PRs)
- **Event listener lifecycle**: Any Promise that registers a browser event listener (`onUpdated`, `onRemoved`, etc.) MUST clean up that listener on ALL exit paths (resolve, reject, timeout). Use a `settled` guard flag to prevent double-settlement races.
- **Cancellable promises**: Promises that own external resources (listeners, timers) MUST expose a `.cancel()` method. Callers MUST invoke `.cancel()` when abandoning a promise early (e.g., in a `catch` block).
- **`browser.tabs.onRemoved`**: Navigation settlement MUST listen for tab closure and reject immediately with a clear error rather than waiting for the 30s timeout.
- **Manifest load order**: `background.scripts` in `manifest.json` determines execution order and dependency availability. The load-order comment in `background.js` MUST stay in sync with the manifest.
- **`alarms` permission**: `browser.alarms` may require explicit permission in Safari MV2 — verify before relying on keepalive alarms.

### STRUCTURE.md Compliance (all PRs)
- **Tool handlers**: one file per MCP tool, placed in `ClaudeInSafari Extension/Resources/tools/`, named in kebab-case.
- **Tests**: JavaScript tests in `Tests/JS/` named `<source-file>.test.js`.
- **Specs**: one file per feature in `docs/specs/`, named `NNN-description.md`.
- **No new files** outside the canonical layout without user approval (PRINCIPLES.md rule 5).
- **Background script load order**: each new tool file added to `manifest.json` background.scripts MUST also be reflected in the load-order comment in `background.js`.

### DRY / SOLID Principles (all PRs)
- **Single Responsibility**: each tool file implements exactly one MCP tool. Helper logic (URL normalization, navigation settlement) belongs in private functions within that file, not shared utilities, unless reused by 2+ tools.
- **Don't Repeat Yourself**: tab resolution MUST use `globalThis.resolveTab` from `tabs-manager.js`. Tool registration MUST use `globalThis.registerTool` from `tool-registry.js`. Never re-implement either.
- **Inter-module contracts**: tools communicate via `globalThis` only for the two established shared helpers (`resolveTab`, `registerTool`). Any new shared helper must be explicitly exported via `globalThis` in `tabs-manager.js` or `tool-registry.js` and documented.
- **No duplication across tool files**: if the same logic appears in two tool files, extract it — but only after it is genuinely needed in two places.
