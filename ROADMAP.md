# Claude in Safari — Roadmap

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Done — implemented and tested |
| 🔧 | In progress |
| 📋 | Spec written, not implemented |
| ⬜ | Planned — no spec yet |
| 🐛 | Known bug / pre-condition for next phase |

---

## Phase 1 — Core Infrastructure ✅

Foundational plumbing: MCP socket server, message framing, native↔extension bridge.

| Item | Spec | Status |
|------|------|--------|
| Unix domain socket server (GCD) | [001](docs/specs/001-mcp-socket-server.md) | ✅ |
| Newline-delimited JSON framing | [002](docs/specs/002-message-framing.md) | ✅ |
| Native ↔ extension bridge (`SafariWebExtensionHandler`) | [003](docs/specs/003-native-extension-bridge.md) | ✅ |

---

## Phase 2 — Extension Foundation ✅

Tool dispatch layer, background script, tab group management, content script scaffolding.

| Item | Spec | Status |
|------|------|--------|
| Tool registry (`registerTool` / dispatch) | [004](docs/specs/004-tool-registry.md) | ✅ |
| Tab group manager (`tabs_context_mcp`, `tabs_create_mcp`) | [013](docs/specs/013-tabs-manager.md) | ✅ |
| Background script event loop + polling | — | ✅ |
| Accessibility tree content script | — | ✅ |
| Console monitor content script | — | ✅ |
| Network monitor content script | — | ✅ |
| Agent visual indicator content script | — | ✅ |

---

## Phase 3 — Navigation ✅

URL navigation and browser history traversal.

| Item | Spec | Status |
|------|------|--------|
| `navigate` — URL nav, back/forward | [008](docs/specs/008-navigate.md) | ✅ |

---

## Milestone: First Build → `v0.1.0` ✅

All critical and medium bugs from [REVIEW.md](REVIEW.md) resolved. Ready to compile, install, and verify end-to-end connectivity.

> **Versioning policy:** `0.x.x` throughout pre-release. The minor version bumps at each phase completion. `1.0.0` is reserved for when the extension is a genuine drop-in replacement for Claude in Chrome.

### Bug Fixes

| ID | Severity | File | Issue | Status |
|----|----------|------|-------|--------|
| C1 | 🔴 Critical | `AppDelegate.swift` | `toolRouter.setServer()` never called → all responses silently dropped | ✅ Fixed |
| H1 | 🟠 High | `MCPSocketServer.swift` | Partial TCP writes silently discarded — needs retry loop | ✅ Fixed |
| H2 | 🟠 High | `SafariWebExtensionHandler.swift` | Single-slot `UserDefaults` IPC drops concurrent requests | ✅ Fixed (file-based FIFO + `NSFileCoordinator`) |
| H3 | 🟠 High | `ToolRouter.swift` | `hybridTools` declared but never consulted (dead code) | ✅ Fixed (removed) |
| H4 | ~~🟠 High~~ | `tool-registry.js` | ~~Core dispatch layer has zero tests~~ | ✅ Fixed (tests added in Phase 4) |
| M1 | 🟡 Medium | `background.js`, `popup.js` | Bundle ID hardcoded in two files (DRY) | ✅ Fixed (`constants.js` loaded in both contexts) |
| M2 | 🟡 Medium | `ToolModels.swift` | `NativeMessage` should be a Swift enum, not stringly-typed struct | ✅ Fixed |
| M3 | 🟡 Medium | `manifest.json` | `persistent: false` + `setTimeout` polling fragile under suspension | ✅ Fixed (`"persistent": true` required on Safari 26+ — background page never bootstraps with `false`) |
| M8 | 🟡 Medium | `tool-registry.js` | All results force-coerced to `text`; blocks image content type | ✅ Fixed (content arrays pass through as-is) |

### Build & Install Checklist

- [x] `xcodebuild build -scheme ClaudeInSafari -destination "platform=macOS"`
- [x] Run the app; verify MCP socket appears at expected path
- [x] Send a `navigate` tool call via `make send TOOL=navigate ARGS='{"url":"https://example.com"}'`; end-to-end response confirmed (socket → native → extension → content script → back)
- [ ] Enable extension in Safari → Settings → Extensions (manual step)
- [ ] Tag `v0.1.0` → release workflow publishes unsigned `.app` archive to GitHub Releases

---

## Phase 4 — Content Extraction → `v0.2.0` ✅

Read DOM structure, find elements, fill forms, extract text.

| Item | Spec | Status |
|------|------|--------|
| `read_page` — accessibility tree snapshot | [005](docs/specs/005-read-page.md) | ✅ |
| `find` — natural language element search | [006](docs/specs/006-find.md) | ✅ |
| `form_input` — fill inputs, checkboxes, selects | [007](docs/specs/007-form-input.md) | ✅ |
| `get_page_text` — extract article/main text | [009](docs/specs/009-get-page-text.md) | ✅ |

---

## JS Test Infrastructure ✅

Resolved [L6](#deferred--known-issues): `get-page-text.test.js` now carries a `@jest-environment jsdom` docblock. Tests T1–T8 use `vm.runInNewContext` to execute the injected IIFE against a real jsdom DOM so the extraction algorithm is actually exercised. `runInjectedScript` was never written, so nothing to remove.

| Item | Status |
|------|--------|
| Add `@jest-environment jsdom` to `get-page-text.test.js` | ✅ |
| Replace vacuous T1–T8 mocks with DOM-based IIFE eval tests | ✅ |
| Remove dead `runInjectedScript` helper (never existed) | ✅ |

---

## Phase 5 — Input & Interaction → `v0.3.0` ⬜

Mouse, keyboard, scroll simulation; page-context JS execution; screenshots.

| Item | Spec | Status |
|------|------|--------|
| `computer` — mouse, keyboard, scroll actions | [010](docs/specs/010-computer-mouse-keyboard.md) | ✅ |
| `computer` (screenshot) — ScreenCaptureKit | [011](docs/specs/011-computer-screenshot.md) | ✅ |
| `javascript_tool` — execute JS in page context | [012](docs/specs/012-javascript-tool.md) | ✅ |

---

## Phase 6 — Monitoring & Advanced Tools → `v0.4.0` ⬜

Console/network capture, window management, GIF recording, file upload.

| Item | Spec | Status |
|------|------|--------|
| `read_console_messages` | [014](docs/specs/014-read-console.md) | ✅ |
| `read_network_requests` | [015](docs/specs/015-read-network.md) | ✅ |
| `resize_window` — AppleScript window management | [016](docs/specs/016-resize-window.md) | ✅ |
| `gif_creator` — record, stop, export animated GIFs | [017](docs/specs/017-gif-creator.md) | ✅ |
| `upload_image` — screenshot/image to page element | [018](docs/specs/018-upload-image.md) | ✅ |
| `file_upload` — local file to file input | [019](docs/specs/019-file-upload.md) | ✅ |

### Phase 6 Future Items (gif_creator)

| Item | Notes |
|------|-------|
| In-browser GIF delivery via drag-drop | After `upload_image` (Spec 018) validates DataTransfer injection in Safari |
| Per-frame local color palette | `kCGImagePropertyGIFHasGlobalColorMap: false` per frame — export-time only, no capture overhead |
| Frame deduplication | Skip consecutive near-identical frames via pixel sampling — export-time only |

---

## Phase 7 — Polish & Distribution → `v1.0.0` ⬜

App Store or notarized DMG distribution, onboarding UX, documentation.

| Item | Status |
|------|--------|
| App Store submission (or notarized DMG) | ⬜ |
| Setup wizard / onboarding UI | ⬜ |
| `agent-visual-indicator` refinement ([020](docs/specs/020-agent-visual-indicator.md)) | ✅ |
| Remaining medium/low REVIEW.md findings (M3–M7, L1–L5) | ✅ All resolved (M3/M4/M7 fixed as side-effects of subsystem rewrites; L2/L3/L4/L5 fixed in #23–#24) |
| Full test coverage for all Swift classes | ⬜ |

---

## Follow-up — Tool UX Improvements

| Item | Notes |
|------|-------|
| `read_page` auto-pagination for large pages | HN accessibility tree is ~20K chars; users hit `max_chars` limit repeatedly. Consider auto-chunking or smarter default depth. |
| `navigate` should auto-create MCP tab if none exists | First `navigate` call fails with "No active tab found" — user must call `tabs_create_mcp` first. Auto-create on first use. |

---

## Deferred / Known Issues

Issues from REVIEW.md deferred past the First Build milestone:

| ID | Issue |
|----|-------|
| ~~M4~~ | ✅ Resolved — `network-monitor.js` rewritten to patch main-world fetch/XHR via `<script>` injection; `PerformanceObserver` approach abandoned entirely. |
| ~~M5~~ | ✅ Resolved in #23 — `normalizePayload()` extracted from poll loop. |
| ~~M6~~ | ✅ Resolved in #23 — `__captureResolveTab` test hook removed; tests read `globalThis.resolveTab` directly. |
| ~~M7~~ | ✅ Resolved — `ToolRouter` conforms to `MCPSocketServerDelegate` directly; `NSObject` inheritance was never present in the current implementation. |
| ~~L1~~ | ✅ Resolved — all 10 spec files written (010–012 Phase 5, 014–019 Phase 6, 020 Phase 7). Each spec includes Safari Considerations documenting degradations and enhancements vs Chrome. |
| ~~L2~~ | ✅ Resolved in #24 — `MCPSocketServer` integration tests added. |
| ~~L3~~ | ✅ Resolved in #23 — `AnyCodable` edge case tests added (null, String, nested Array, nested Dict). |
| ~~L4~~ | ✅ Resolved — `MCPSocketServer.readBufferSize` is a named `private static let` constant; no magic numbers present. |
| ~~L5~~ | ✅ Resolved in #23 — dead `ToolRequest`/`ToolRequestParams` structs deleted from `MCPMessage.swift`. |
| ~~L6~~ | ✅ Resolved in `fix/js-test-infrastructure` — `@jest-environment jsdom` docblock added to `get-page-text.test.js`; T1–T8 now eval the IIFE via `vm.runInNewContext` against a real jsdom DOM. |
