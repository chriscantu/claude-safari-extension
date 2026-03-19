# Tool Execution Guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden tool execution with tab-closed guards in computer.js, upfront payload validation, and Safari-frontmost auto-activation.

**Architecture:** Three independent hardening layers. (1) Replace direct `executeScript` calls in `computer.js` action handlers with `executeScriptWithTabGuard()` from `tool-registry.js`. (2) Add upfront parameter validation in `handleComputer()` before async work. (3) Add `activateSafariIfNeeded()` in `ToolRouter.swift` before forwarding executeScript-requiring tools.

**Tech Stack:** JavaScript (Safari Web Extension MV2), Swift (macOS app), Jest, XCTest

---

## Task 1: computer.js — Tab-Closed Guards

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/tools/computer.js` (action handlers: lines 404–701)
- Test: `Tests/JS/computer.test.js`

### Context

`tool-registry.js` exports `globalThis.executeScriptWithTabGuard(realTabId, scriptCode, toolName)` which wraps `browser.tabs.executeScript` with:
- `browser.tabs.onRemoved` listener → rejects immediately on tab close
- 30s timeout → rejects if script never completes
- settled-flag → prevents double-settlement
- `.cancel()` → releases resources on early abandonment

Currently, all 7 action handlers in `computer.js` call `browser.tabs.executeScript` directly. Each follows this pattern:

```javascript
let results;
try {
    results = await browser.tabs.executeScript(realTabId, {
        code: buildXxxScript(...),
        runAt: "document_idle",
    });
} catch (err) {
    throw globalThis.classifyExecuteScriptError("computer", realTabId, err);
}
```

Replace with:

```javascript
let results;
try {
    results = await globalThis.executeScriptWithTabGuard(
        realTabId, buildXxxScript(...), "computer"
    );
} catch (err) {
    if (/was closed during/.test(err.message)) throw err;
    throw globalThis.classifyExecuteScriptError("computer", realTabId, err);
}
```

The key difference: if the error message contains "was closed during", the tab-guard already produced a user-friendly message — pass it through directly. Otherwise, classify as before.

- [ ] **Step 1: Write failing tests for tab-closed guard**

Add a new `describe("tab-closed guards")` block in `computer.test.js`. The browser mock needs `tabs.onRemoved` to simulate tab closure.

```javascript
describe("tab-closed guards", () => {
    test("left_click rejects with tab-closed error when tab is removed mid-flight", async () => {
        let onRemovedListener = null;
        const browser = {
            tabs: {
                executeScript: jest.fn(() => new Promise(() => {})), // never resolves
                onRemoved: {
                    addListener: jest.fn((fn) => { onRemovedListener = fn; }),
                    removeListener: jest.fn(),
                },
            },
            alarms: {
                create: jest.fn(), clear: jest.fn(),
                get: jest.fn(() => Promise.resolve(undefined)),
                onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
            },
            storage: { session: {
                get: jest.fn(() => Promise.resolve({})),
                set: jest.fn(() => Promise.resolve()),
                remove: jest.fn(() => Promise.resolve()),
            }},
        };

        const handler = loadComputer({ browser, resolveTab: jest.fn(async () => 42) });
        const promise = handler({ action: "left_click", coordinate: [100, 200] });

        // One microtask tick for resolveTab (async), then addListener is synchronous
        // inside the Promise executor of executeScriptWithTabGuard.
        await Promise.resolve();
        onRemovedListener(42); // fire tab removed

        await expect(promise).rejects.toThrow(/was closed during computer/);
    });

    test("type rejects with tab-closed error when tab is removed mid-flight", async () => {
        let onRemovedListener = null;
        const browser = {
            tabs: {
                executeScript: jest.fn(() => new Promise(() => {})),
                onRemoved: {
                    addListener: jest.fn((fn) => { onRemovedListener = fn; }),
                    removeListener: jest.fn(),
                },
            },
            alarms: {
                create: jest.fn(), clear: jest.fn(),
                get: jest.fn(() => Promise.resolve(undefined)),
                onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
            },
            storage: { session: {
                get: jest.fn(() => Promise.resolve({})),
                set: jest.fn(() => Promise.resolve()),
                remove: jest.fn(() => Promise.resolve()),
            }},
        };

        const handler = loadComputer({ browser, resolveTab: jest.fn(async () => 42) });
        const promise = handler({ action: "type", text: "hello" });

        // One microtask tick for resolveTab
        await Promise.resolve();
        onRemovedListener(42);

        await expect(promise).rejects.toThrow(/was closed during computer/);
    });

    test("non-tab-closed executeScript errors still use classifyExecuteScriptError", async () => {
        const browser = {
            tabs: {
                executeScript: jest.fn(() => Promise.reject(new Error("No tab with id 99"))),
                onRemoved: {
                    addListener: jest.fn(),
                    removeListener: jest.fn(),
                },
            },
            alarms: {
                create: jest.fn(), clear: jest.fn(),
                get: jest.fn(() => Promise.resolve(undefined)),
                onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
            },
            storage: { session: {
                get: jest.fn(() => Promise.resolve({})),
                set: jest.fn(() => Promise.resolve()),
                remove: jest.fn(() => Promise.resolve()),
            }},
        };

        const handler = loadComputer({ browser, resolveTab: jest.fn(async () => 99) });

        await expect(
            handler({ action: "left_click", coordinate: [100, 200] })
        ).rejects.toThrow(/tabs_context_mcp/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest Tests/JS/computer.test.js --verbose 2>&1 | tail -20`
Expected: FAIL — `executeScriptWithTabGuard` is not being called yet, so `onRemoved` mock shape mismatch.

- [ ] **Step 3: Update action handlers to use executeScriptWithTabGuard**

In `computer.js`, replace the `try { results = await browser.tabs.executeScript(...) } catch` pattern in all 7 action handlers with:

```javascript
let results;
try {
    results = await globalThis.executeScriptWithTabGuard(
        realTabId, buildXxxScript(...), "computer"
    );
} catch (err) {
    if (/was closed during/.test(err.message)) throw err;
    throw globalThis.classifyExecuteScriptError("computer", realTabId, err);
}
```

Handlers to update:
1. `handleClick` (line 404) — `buildClickScript(action, coordinate, ref, modifiers)`
2. `handleHover` (line 428) — `buildHoverScript(coordinate, ref)`
3. `handleType` (line 452) — `buildTypeScript(text)`
4. `handleKey` (line 476) — `buildKeyScript(text, repeatNum)`
5. `handleScroll` (line 616) — `buildScrollScript(coordinate, scroll_direction, scrollAmount)`
6. `handleScrollTo` (line 652) — `buildScrollToScript(ref)`
7. `handleDrag` (line 676) — `buildDragScript(start_coordinate, coordinate)`

- [ ] **Step 4: Update existing browser mocks to include onRemoved**

The existing `makeBrowserMock()` and `makeBrowserMockWithDomEval()` in the test file need `tabs.onRemoved` added so existing tests still pass with the new `executeScriptWithTabGuard` path:

```javascript
// Add to both makeBrowserMock and makeBrowserMockWithDomEval, inside the tabs object:
onRemoved: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
},
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `npx jest Tests/JS/computer.test.js --verbose 2>&1 | tail -30`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
git add ClaudeInSafari\ Extension/Resources/tools/computer.js Tests/JS/computer.test.js
git commit -m "feat(computer): use executeScriptWithTabGuard for tab-closed resilience (Spec 024)"
```

---

## Task 2: computer.js — Upfront Payload Validation

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/tools/computer.js` (handleComputer, lines 68–84)
- Test: `Tests/JS/computer.test.js`

### Context

Currently, `handleComputer()` validates the action name and resolves the tab before dispatching to handlers. Action-specific validation (e.g., missing `text` for `type`) happens inside each handler **after** tab resolution.

Move action-specific required-parameter checks into `handleComputer()` so bad payloads are rejected synchronously before any async work (tab resolution, executeScript). This is a defense-in-depth improvement — the per-handler checks stay as a safety net.

Note: click/hover coordinate-or-ref validation stays in the handlers (via `validateCoordinateOrRef`) since it already rejects before executeScript and moving it would duplicate the logic without meaningful benefit.

- [ ] **Step 1: Write failing tests for upfront validation**

Add a `describe("upfront payload validation")` block:

```javascript
describe("upfront payload validation", () => {
    test("type with non-string text rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(handler({ action: "type", text: 123 })).rejects.toThrow(/text.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });

    test("type with empty string text rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(handler({ action: "type", text: "" })).rejects.toThrow(/text.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });

    test("key with missing text rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(handler({ action: "key" })).rejects.toThrow(/text.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });

    test("scroll with missing scroll_direction rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(handler({ action: "scroll" })).rejects.toThrow(/scroll_direction.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });

    test("scroll_to with missing ref rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(handler({ action: "scroll_to" })).rejects.toThrow(/ref.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });

    test("left_click_drag with missing start_coordinate rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(
            handler({ action: "left_click_drag", coordinate: [300, 300] })
        ).rejects.toThrow(/start_coordinate.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });

    test("left_click_drag with missing coordinate rejects before resolveTab", async () => {
        const resolveTab = jest.fn(async () => 42);
        const handler = loadComputer({ browser: makeBrowserMock(), resolveTab });

        await expect(
            handler({ action: "left_click_drag", start_coordinate: [100, 100] })
        ).rejects.toThrow(/coordinate.*required/);
        expect(resolveTab).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest Tests/JS/computer.test.js --testNamePattern="upfront" --verbose 2>&1 | tail -20`
Expected: FAIL — `resolveTab` IS currently called before validation.

- [ ] **Step 3: Add upfront validation to handleComputer()**

Replace `handleComputer()` in `computer.js`:

```javascript
async function handleComputer(args) {
    const { action, tabId: virtualTabId = null } = args || {};
    const handler = ACTION_HANDLERS[action];

    if (!handler) {
        throw new Error(
            action == null ? "action is required" : `Invalid action: "${action}"`
        );
    }

    if (action === "wait") {
        return handler(args);
    }

    // Upfront validation — reject bad payloads before resolveTab or executeScript.
    // Per-handler checks remain as a safety net.
    if (action === "type" || action === "key") {
        if (!args.text || typeof args.text !== "string") {
            throw new Error("text parameter is required for " + action + " action");
        }
    } else if (action === "scroll") {
        if (!args.scroll_direction) {
            throw new Error("scroll_direction is required for scroll action");
        }
    } else if (action === "scroll_to") {
        if (!args.ref || typeof args.ref !== "string") {
            throw new Error("ref is required for scroll_to action");
        }
    } else if (action === "left_click_drag") {
        if (!args.start_coordinate) {
            throw new Error("start_coordinate is required for left_click_drag");
        }
        if (!args.coordinate) {
            throw new Error("coordinate is required for left_click_drag");
        }
    }

    const realTabId = await globalThis.resolveTab(virtualTabId);
    return handler(args, realTabId);
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npx jest Tests/JS/computer.test.js --verbose 2>&1 | tail -30`
Expected: ALL PASS (both new upfront tests and existing handler-level tests)

- [ ] **Step 5: Commit**

```
git add ClaudeInSafari\ Extension/Resources/tools/computer.js Tests/JS/computer.test.js
git commit -m "feat(computer): upfront payload validation before resolveTab (Spec 024)"
```

---

## Task 3: ToolRouter.swift — Safari-Frontmost Auto-Activation

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift` (add `activateSafariIfNeeded()`, call in `forwardToExtension`)
- Test: `Tests/Swift/ToolRouterTests.swift`

### Context

Tools using `browser.tabs.executeScript` require Safari to be the frontmost app. Currently, if Safari is in the background, executeScript fails with a cryptic WebKit permission error. The native app should activate Safari before forwarding these tool calls.

The set of tools that need Safari frontmost (all use executeScript in the extension):
- `computer` (non-screenshot/zoom actions — screenshot/zoom are native ScreenCaptureKit)
- `find`, `read_page`, `form_input`, `get_page_text`
- `javascript_tool`, `read_console_messages`, `read_network_requests`

Note: `upload_image` and `file_upload` are handled natively first, then forwarded to extension via `forwardToExtension()`. Since activation is in `forwardToExtension()`, they are covered automatically — no per-handler activation needed.

- [ ] **Step 1: Write failing test for Safari activation**

Add to `Tests/Swift/ToolRouterTests.swift`:

```swift
// MARK: - Safari Activation

func testActivateSafariIfNeeded_doesNotCrash() {
    // activateSafariIfNeeded is a best-effort call.
    // We verify it doesn't crash and returns without error.
    // Full activation requires a running Safari.app — cannot unit test.
    let router = ToolRouter()
    router.activateSafariIfNeeded()
    // No assertion — just verifying it doesn't crash or hang.
    // Integration testing via `make send` covers actual activation.
}
```

Since `activateSafariIfNeeded` is a new method, the test will fail to compile.

- [ ] **Step 2: Verify the test fails to compile**

Run: `xcodebuild test -project ClaudeInSafari/ClaudeInSafari.xcodeproj -scheme ClaudeInSafari -destination 'platform=macOS' 2>&1 | tail -20`
Expected: Compile error — `activateSafariIfNeeded` does not exist yet.

- [ ] **Step 3: Add activateSafariIfNeeded() to ToolRouter.swift**

First, add `import AppKit` at the top of `ToolRouter.swift` (the file only imports `Foundation` and `UserNotifications`).

Then add this after the `cancelCurrentRequest()` method (around line 204):

```swift
/// Set of tool names that use browser.tabs.executeScript and require Safari frontmost.
private static let executeScriptTools: Set<String> = [
    "computer", "find", "read_page", "form_input", "get_page_text",
    "javascript_tool", "read_console_messages", "read_network_requests",
    "upload_image", "file_upload"
]

/// Activate Safari if it is not already the frontmost application.
/// Best-effort: logs a warning on failure but does not throw — the tool will
/// fail with a clearer executeScript permission error.
func activateSafariIfNeeded() {
    guard let safari = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleIdentifier == "com.apple.Safari"
    }) else {
        NSLog("activateSafariIfNeeded: Safari is not running")
        return
    }
    if safari.isActive { return }
    if !safari.activate() {
        NSLog("activateSafariIfNeeded: activate() returned false")
    }
}
```

**⚠ Swift API note:** `NSRunningApplication.activate()` requires no arguments on macOS 14+ (Sonoma). On macOS 13 (Ventura, our deployment target), use `safari.activate(options: .activateIgnoringOtherApps)` instead:

```swift
if !safari.activate(options: .activateIgnoringOtherApps) {
    NSLog("activateSafariIfNeeded: activate() returned false")
}
```

Check the deployment target (`macOS 13.0+` per STRUCTURE.md) and use the appropriate API.

- [ ] **Step 4: Call activateSafariIfNeeded in forwardToExtension**

In `forwardToExtension()` (line 715), add activation before the existing enqueue logic:

```swift
private func forwardToExtension(_ queued: QueuedToolRequest, id: Any?, clientId: String,
                                 arguments: [String: Any] = [:]) {
    // Activate Safari before executeScript-requiring tools
    if Self.executeScriptTools.contains(queued.tool) {
        activateSafariIfNeeded()
    }

    guard enqueueToolRequest(queued) else {
        // ... existing code
```

This single call site covers all extension-forwarded tools including `upload_image` and `file_upload` (which go through `forwardToExtension` after their native prep work).

- [ ] **Step 5: Run tests to verify they pass**

Run: `xcodebuild test -project ClaudeInSafari/ClaudeInSafari.xcodeproj -scheme ClaudeInSafari -destination 'platform=macOS' 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 6: Run JS tests to verify nothing broke**

Run: `npx jest Tests/JS/ --verbose 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```
git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
git commit -m "feat(ToolRouter): auto-activate Safari before executeScript tools (Spec 024)"
```

---

## Task 4: Manual Smoke Test

- [ ] **Step 1: Build and launch**

Run: `make kill && make build && make run`
Expected: App launches, extension loads.

- [ ] **Step 2: Verify health**

Run: `make health`
Expected: Health check passes.

- [ ] **Step 3: Test computer tool with Safari in background**

1. Open a terminal (not Safari)
2. Run: `make send TOOL=computer ARGS='{"action":"left_click","coordinate":[100,200]}'`
3. Verify: Safari comes to front, click is performed

- [ ] **Step 4: Test bad payload rejection**

Run: `make send TOOL=computer ARGS='{"action":"type"}'`
Expected: Error response with "text parameter is required" (no 30s timeout).

- [ ] **Step 5: Verify existing tools still work**

Run: `make send TOOL=navigate ARGS='{"url":"https://example.com"}'`
Then: `make send TOOL=read_page ARGS='{}'`
Expected: Both succeed normally.
