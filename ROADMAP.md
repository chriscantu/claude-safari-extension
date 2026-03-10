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
| Unix domain socket server (GCD) | [001](Specs/001-mcp-socket-server.md) | ✅ |
| 4-byte BE length-prefix framing | [002](Specs/002-message-framing.md) | ✅ |
| Native ↔ extension bridge (`SafariWebExtensionHandler`) | [003](Specs/003-native-extension-bridge.md) | ✅ |

---

## Phase 2 — Extension Foundation ✅

Tool dispatch layer, background script, tab group management, content script scaffolding.

| Item | Spec | Status |
|------|------|--------|
| Tool registry (`registerTool` / dispatch) | [004](Specs/004-tool-registry.md) | ✅ |
| Tab group manager (`tabs_context_mcp`, `tabs_create_mcp`) | [013](Specs/013-tabs-manager.md) | ✅ |
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
| `navigate` — URL nav, back/forward | [008](Specs/008-navigate.md) | ✅ |

---

## Milestone: First Build → `v0.1.0` 🔧

**Next up.** Fix critical bugs from [REVIEW.md](REVIEW.md), compile, install, and verify end-to-end connectivity. Tagging `v0.1.0` is the first act that publishes an artifact — intentionally gated behind working end-to-end traffic so nothing is released in a broken state.

> **Versioning policy:** `0.x.x` throughout pre-release. The minor version bumps at each phase completion. `1.0.0` is reserved for when the extension is a genuine drop-in replacement for Claude in Chrome.

### Bug Fixes Required

| ID | Severity | File | Issue |
|----|----------|------|-------|
| C1 | 🔴 Critical | `AppDelegate.swift` | `toolRouter.setServer()` never called → all responses silently dropped |
| H1 | 🟠 High | `MCPSocketServer.swift` | Partial TCP writes silently discarded — needs retry loop |
| H2 | 🟠 High | `SafariWebExtensionHandler.swift` | Single-slot `UserDefaults` IPC drops concurrent requests |
| H3 | 🟠 High | `ToolRouter.swift` | `hybridTools` declared but never consulted (dead code) |
| H4 | ~~🟠 High~~ | `tool-registry.js` | ~~Core dispatch layer has zero tests~~ — ✅ fixed (tests added in Phase 4) |
| M1 | 🟡 Medium | `background.js`, `popup.js` | Bundle ID hardcoded in two files (DRY) |
| M2 | 🟡 Medium | `ToolModels.swift` | `NativeMessage` should be a Swift enum, not stringly-typed struct |
| M3 | 🟡 Medium | `manifest.json` | `persistent: false` + `setTimeout` polling fragile under suspension |
| M8 | 🟡 Medium | `tool-registry.js` | All results force-coerced to `text`; blocks image content type |

### Build & Install Checklist

- [ ] Fix C1, H1, H2, H3 (required for any traffic to flow end-to-end; H4 resolved)
- [ ] Fix M1, M2, M8 (required for Phase 4 tools to work correctly)
- [ ] `xcodebuild build -scheme ClaudeInSafari -destination "platform=macOS"`
- [ ] Run the app; verify MCP socket appears at expected path
- [ ] Enable extension in Safari → Settings → Extensions
- [ ] Send a `navigate` tool call from Claude Code CLI; verify response
- [ ] Tag `v0.1.0` → release workflow publishes unsigned `.app` archive to GitHub Releases

---

## Phase 4 — Content Extraction → `v0.2.0` ✅

Read DOM structure, find elements, fill forms, extract text.

| Item | Spec | Status |
|------|------|--------|
| `read_page` — accessibility tree snapshot | [005](Specs/005-read-page.md) | ✅ |
| `find` — natural language element search | [006](Specs/006-find.md) | ✅ |
| `form_input` — fill inputs, checkboxes, selects | [007](Specs/007-form-input.md) | ✅ |
| `get_page_text` — extract article/main text | [009](Specs/009-get-page-text.md) | ✅ |

---

## Phase 5 — Input & Interaction → `v0.3.0` ⬜

Mouse, keyboard, scroll simulation; page-context JS execution; screenshots.

| Item | Spec | Status |
|------|------|--------|
| `computer` — mouse, keyboard, scroll actions | 010 | ⬜ |
| `computer` (screenshot) — ScreenCaptureKit | 011 | ⬜ |
| `javascript_tool` — execute JS in page context | 012 | ⬜ |

---

## Phase 6 — Monitoring & Advanced Tools → `v0.4.0` ⬜

Console/network capture, window management, GIF recording, file upload.

| Item | Spec | Status |
|------|------|--------|
| `read_console_messages` | 014 | ⬜ |
| `read_network_requests` | 015 | ⬜ |
| `resize_window` — AppleScript window management | 016 | ⬜ |
| `gif_creator` — record, stop, export animated GIFs | 017 | ⬜ |
| `upload_image` — screenshot/image to page element | 018 | ⬜ |
| `file_upload` — local file to file input | 019 | ⬜ |

---

## Phase 7 — Polish & Distribution → `v1.0.0` ⬜

App Store or notarized DMG distribution, onboarding UX, documentation.

| Item | Status |
|------|--------|
| App Store submission (or notarized DMG) | ⬜ |
| Setup wizard / onboarding UI | ⬜ |
| `agent-visual-indicator` refinement (spec 020) | ⬜ |
| Remaining medium/low REVIEW.md findings (M3–M7, L1–L5) | ⬜ |
| Full test coverage for all Swift classes | ⬜ |

---

## Deferred / Known Issues

Issues from REVIEW.md deferred past the First Build milestone:

| ID | Issue |
|----|-------|
| M4 | Empty `PerformanceObserver` callback in `network-monitor.js` |
| M5 | Payload normalisation inline in poll loop (SRP) |
| M6 | Test hook `__captureResolveTab` leaking into production code |
| M7 | Unnecessary `NSObject` inheritance on `ToolRouter` |
| L1 | 10 spec files not yet written (must be written before Phase 5/6 begins) |
| L2 | 6 Swift classes lack test coverage |
| L3 | Hand-rolled `AnyCodable` edge cases — consider Flight-School/AnyCodable |
| L4 | Magic number read buffer size in `MCPSocketServer` |
| L5 | `clientId` duplicated at payload and socket level |
| L6 | JS tool tests (T1–T8 in `get-page-text.test.js`) mock `scriptResult` rather than eval-ing the injected IIFE in jsdom — `runInjectedScript` helper is dead code. Requires switching Jest env to `@jest-environment jsdom` and eval-ing the IIFE source; blocked until jsdom environment is set up for the JS test suite. Affects: priority chain, blank-line collapse, noise removal, truncation boundary. |
