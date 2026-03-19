# Resource Management (Spec 025) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lifecycle-aware cleanup to four resource types that accumulate without bounds during long sessions.

**Architecture:** Four independent, local changes — no shared abstractions. Each fix lives in the component it affects: tab group pruning in tabs-manager.js + background.js, poll backoff in background.js, image TTL in ScreenshotService.swift, orphan cleanup in ToolRouter.swift.

**Tech Stack:** JavaScript (Safari MV2 extension), Swift (native macOS app), Jest (JS tests), XCTest (Swift tests)

---

### Task 1: Tab Group Pruning — Tests

**Files:**
- Modify: `Tests/JS/tabs-manager.test.js`

- [ ] **Step 1: Write failing tests for pruneStaleGroups**

Add a new `describe` block at the end of the file:

```javascript
// ---------------------------------------------------------------------------
// pruneStaleGroups (Spec 025 §1)
// ---------------------------------------------------------------------------

describe("pruneStaleGroups", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.registerTool;
        delete globalThis.pruneStaleGroups;
    });

    function setup(opts) {
        jest.resetModules();
        const bm = makeBrowserMock(opts);
        globalThis.browser = bm;
        globalThis.registerTool = jest.fn();
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
        return bm;
    }

    test("T_prune1: removes tabs whose real tab no longer exists", async () => {
        const bm = setup({
            existingRealTabs: { 10: { id: 10, url: "https://a.com", title: "A" } },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 3,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 10, url: "https://a.com", title: "A", isStale: false },
                                "2": { realTabId: 99, url: "https://gone.com", title: "Gone", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups["1"].tabs)).toEqual(["1"]);
    });

    test("T_prune2: deletes group when all tabs are dead", async () => {
        const bm = setup({
            existingRealTabs: {},
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 2,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 99, url: "https://gone.com", title: "Gone", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups)).toEqual([]);
    });

    test("T_prune3: no-op when no groups exist", async () => {
        const bm = setup({ existingRealTabs: {} });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(state).toBeUndefined();
    });

    test("T_prune4: preserves groups with all live tabs", async () => {
        const bm = setup({
            existingRealTabs: {
                10: { id: 10, url: "https://a.com", title: "A" },
                11: { id: 11, url: "https://b.com", title: "B" },
            },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 3,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 10, url: "https://a.com", title: "A", isStale: false },
                                "2": { realTabId: 11, url: "https://b.com", title: "B", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups["1"].tabs)).toEqual(["1", "2"]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --testPathPattern tabs-manager`
Expected: FAIL — `globalThis.pruneStaleGroups` is not a function

- [ ] **Step 3: Commit failing tests**

```bash
git add Tests/JS/tabs-manager.test.js
git commit -m "test: add pruneStaleGroups tests (Spec 025 §1)"
```

---

### Task 2: Tab Group Pruning — Implementation

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/tools/tabs-manager.js:215-226`

- [ ] **Step 1: Implement pruneStaleGroups**

Add the function before the Registration section (before line 215):

```javascript
// ---------------------------------------------------------------------------
// Prune stale groups (Spec 025 §1)
// ---------------------------------------------------------------------------

/**
 * Remove tab entries whose real tab no longer exists.
 * Delete groups that become empty after pruning.
 * Called periodically from background.js on a 60-second interval.
 */
async function pruneStaleGroups() {
    const state = await readState();
    if (!state.groups || Object.keys(state.groups).length === 0) return;

    let changed = false;
    for (const [groupId, group] of Object.entries(state.groups)) {
        for (const [vtid, entry] of Object.entries(group.tabs)) {
            try {
                await browser.tabs.get(entry.realTabId);
            } catch (_) {
                delete group.tabs[vtid];
                changed = true;
            }
        }
        if (Object.keys(group.tabs).length === 0) {
            delete state.groups[groupId];
            changed = true;
        }
    }

    if (changed) {
        await writeState(state);
    }
}
```

Update the globalThis export block (currently lines 222-225) to also export `pruneStaleGroups`:

```javascript
if (typeof globalThis !== "undefined") {
    globalThis.resolveTab = resolveTab;
    globalThis.pruneStaleGroups = pruneStaleGroups;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- --testPathPattern tabs-manager`
Expected: PASS — all T_prune tests green

- [ ] **Step 3: Commit**

```bash
git add "ClaudeInSafari Extension/Resources/tools/tabs-manager.js"
git commit -m "feat: add pruneStaleGroups to tabs-manager (Spec 025 §1)"
```

---

### Task 3: Poll Backoff — Tests

**Files:**
- Modify: `Tests/JS/background.test.js`

- [ ] **Step 1: Write failing tests for exponential backoff**

Add to the `background.js poll loop` describe block, after T13:

```javascript
    // T14 — Poll backoff: second idle poll fires at 200ms, not at 100ms (Spec 025 §2)
    // Strategy: after the first idle response, advance only 100ms — that should NOT fire
    // the second poll (which should be at 200ms). Then advance another 100ms — that should.
    test("T14 — idle backoff: second idle poll needs 200ms, not 100ms", async () => {
        const browser = makeBrowserMock({
            nativeResponses: [{ type: "idle" }, { type: "idle" }, { type: "idle" }],
        });
        loadBackground({ browser });

        // First poll fires immediately (no timer). Wait for it to resolve.
        await Promise.resolve();

        // After first idle response, idleStreak=1, next timer = 100*2^1 = 200ms.
        // Advance only 100ms — second poll should NOT have fired yet.
        jest.advanceTimersByTime(100);
        await Promise.resolve();
        const pollsAfter100 = browser.runtime.sendNativeMessage.mock.calls
            .filter(([, msg]) => msg.type === "poll").length;

        // Advance another 100ms (total 200ms) — second poll should fire now.
        jest.advanceTimersByTime(100);
        await Promise.resolve();
        const pollsAfter200 = browser.runtime.sendNativeMessage.mock.calls
            .filter(([, msg]) => msg.type === "poll").length;

        // Before backoff: both would be 2 (binary switch used 5000ms idle).
        // With backoff: pollsAfter100 === 1 (timer hasn't fired), pollsAfter200 === 2.
        expect(pollsAfter100).toBe(1);
        expect(pollsAfter200).toBe(2);
    });

    // T15 — Poll backoff: activity resets idleStreak to 0 (Spec 025 §2)
    test("T15 — activity resets backoff: tool request after idle resets to 100ms", async () => {
        const payload = { tool: "navigate", args: {}, requestId: "req-backoff" };
        const browser = makeBrowserMock({
            nativeResponses: [
                { type: "idle" },
                { type: "tool_request", payload: JSON.stringify(payload) },
                { type: "idle" },
            ],
        });
        loadBackground({ browser });

        // First idle poll
        await Promise.resolve();

        // idleStreak=1, next timer at 200ms
        jest.advanceTimersByTime(200);
        await Promise.resolve();

        // Second poll is a tool_request — resets idleStreak=0
        jest.runAllTimers(); // setTimeout(0) for tool dispatch
        await Promise.resolve(); // executeTool
        await Promise.resolve(); // Phase 4 send
        await Promise.resolve(); // finally
        await Promise.resolve();

        // After tool, idleStreak=0, so next timer is 100ms (100*2^0).
        // Advance 100ms — the idle poll after the tool should fire.
        jest.advanceTimersByTime(100);
        await Promise.resolve();

        const pollCalls = browser.runtime.sendNativeMessage.mock.calls
            .filter(([, msg]) => msg.type === "poll");
        expect(pollCalls.length).toBeGreaterThanOrEqual(3);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --testPathPattern background`
Expected: T14 FAIL — without backoff, the binary switch uses 5000ms idle interval, so `pollsAfter100` will be 1 and `pollsAfter200` will also be 1 (timer hasn't fired at 200ms because the old interval is 5000ms). T15 may pass or fail depending on the idle interval.

- [ ] **Step 3: Commit failing tests**

```bash
git add Tests/JS/background.test.js
git commit -m "test: add poll backoff tests T14-T15 (Spec 025 §2)"
```

---

### Task 4: Poll Backoff + Prune Timer — Implementation

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/background.js:24-27,118-269`

- [ ] **Step 1: Add idleStreak counter and prune timer state**

Replace lines 24-27:

```javascript
const POLL_INTERVAL_MS = 100;
const POLL_IDLE_INTERVAL_MS = 5000;
let isActive = false;
let pollTimer = null;
```

With:

```javascript
const POLL_INTERVAL_MS = 100;
const POLL_IDLE_INTERVAL_MS = 5000;
let isActive = false;
let pollTimer = null;
let idleStreak = 0;
let lastPruneTime = Date.now();
let isPruning = false;
```

- [ ] **Step 2: Replace the binary interval calculation in the finally block**

Replace line 268 (`const interval = isActive ? POLL_INTERVAL_MS : POLL_IDLE_INTERVAL_MS;`):

```javascript
        const interval = isActive
            ? POLL_INTERVAL_MS
            : Math.min(POLL_INTERVAL_MS * Math.pow(2, idleStreak), POLL_IDLE_INTERVAL_MS);
```

- [ ] **Step 3: Track idleStreak in the poll loop**

In the `pollForRequests` function, after the early returns that set `isActive = false` (lines 136, 142, 153), increment `idleStreak`. Where `isActive = true` is set (line 145), reset it.

After line 136 (`isActive = false;`), add:
```javascript
            idleStreak++;
```

After line 142 (`isActive = false;`), add:
```javascript
            idleStreak++;
```

Replace line 145 (`isActive = true;`) with:
```javascript
        isActive = true;
        idleStreak = 0;
```

After line 153 (`isActive = false;`), add:
```javascript
            idleStreak++;
```

Note: Do NOT add `idleStreak++` to the Phase 3 error path (line 248) or Phase 4 error path (line 264). Those are tool execution/send failures, not idle polls. `idleStreak` only tracks consecutive empty poll responses.

- [ ] **Step 4: Add prune trigger in the finally block**

Before the `pollTimer = setTimeout(...)` line in the finally block, add:

```javascript
        // Spec 025 §1: periodic tab group pruning (every 60s when idle)
        if (idleStreak > 0 && !isPruning && typeof globalThis.pruneStaleGroups === "function") {
            const now = Date.now();
            if (now - lastPruneTime >= 60000) {
                lastPruneTime = now;
                isPruning = true;
                globalThis.pruneStaleGroups()
                    .catch((e) => console.warn("prune: failed (non-critical):", e && e.message))
                    .finally(() => { isPruning = false; });
            }
        }
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS — all existing tests + T14/T15 + T_prune tests green

- [ ] **Step 6: Commit**

```bash
git add "ClaudeInSafari Extension/Resources/background.js"
git commit -m "feat: exponential poll backoff + prune timer (Spec 025 §1-§2)"
```

---

### Task 5: Image TTL — Tests

**Files:**
- Modify: `Tests/Swift/ScreenshotServiceTests.swift`

- [ ] **Step 1: Write failing test for TTL expiration**

Add at the end of the `ScreenshotServiceTests` class:

```swift
    // MARK: - T_ttl1: Images older than 5 minutes are evicted by cleanup timer (Spec 025 §3)

    func testTTLEvictsExpiredImages() {
        // Capture an image (timestamp = now)
        let exp1 = expectation(description: "capture")
        var capturedId: String?
        service.captureScreenshot(tabId: nil) { result in
            if case .success(let img) = result { capturedId = img.imageId }
            exp1.fulfill()
        }
        waitForExpectations(timeout: 1)
        guard let id = capturedId else { return XCTFail("No imageId") }
        XCTAssertNotNil(service.retrieveImage(imageId: id), "Image should exist before TTL")

        // Run cleanup with a custom expiration of 0 seconds (everything expires immediately)
        service.evictExpiredImages(olderThan: 0)

        XCTAssertNil(service.retrieveImage(imageId: id), "Image should be evicted after TTL cleanup")
        XCTAssertEqual(service.imageCount, 0, "Image count should be 0 after eviction")
    }

    // MARK: - T_ttl2: Fresh images survive TTL cleanup

    func testTTLPreservesFreshImages() {
        let exp1 = expectation(description: "capture")
        var capturedId: String?
        service.captureScreenshot(tabId: nil) { result in
            if case .success(let img) = result { capturedId = img.imageId }
            exp1.fulfill()
        }
        waitForExpectations(timeout: 1)
        guard let id = capturedId else { return XCTFail("No imageId") }

        // Run cleanup with a long expiration (images younger than 1 hour survive)
        service.evictExpiredImages(olderThan: 3600)

        XCTAssertNotNil(service.retrieveImage(imageId: id), "Fresh image should survive TTL cleanup")
        XCTAssertEqual(service.imageCount, 1)
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `make test-swift`
Expected: FAIL — `evictExpiredImages` method does not exist

- [ ] **Step 3: Commit failing tests**

```bash
git add Tests/Swift/ScreenshotServiceTests.swift
git commit -m "test: add image TTL tests (Spec 025 §3)"
```

---

### Task 6: Image TTL — Implementation

**Files:**
- Modify: `ClaudeInSafari/Services/ScreenshotService.swift:63-74,196-208`

- [ ] **Step 1: Add TTL constants and timer**

After line 70 (`private static let maxStoredImages = 50`), add:

```swift
    private static let imageExpirationSeconds: TimeInterval = 300  // 5 minutes
    private static let cleanupIntervalSeconds: TimeInterval = 60

    private var cleanupTimer: DispatchSourceTimer?
```

- [ ] **Step 2: Start the cleanup timer in init**

At the end of the `init` method (after `self.captureProvider = captureProvider`), add:

```swift
        startCleanupTimer()
```

- [ ] **Step 3: Implement startCleanupTimer and evictExpiredImages**

Add before the `// MARK: - Private helpers` section:

```swift
    // MARK: - TTL cleanup (Spec 025 §3)

    /// Evict images older than `olderThan` seconds. Called by the periodic timer
    /// and exposed internally for testability.
    func evictExpiredImages(olderThan maxAge: TimeInterval = ScreenshotService.imageExpirationSeconds) {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        let expiredIds = imageStore.filter { now.timeIntervalSince($0.value.timestamp) > maxAge }.map { $0.key }
        for id in expiredIds {
            imageStore.removeValue(forKey: id)
            imageOrder.removeAll { $0 == id }
        }
    }

    private func startCleanupTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + Self.cleanupIntervalSeconds,
                       repeating: Self.cleanupIntervalSeconds)
        timer.setEventHandler { [weak self] in
            self?.evictExpiredImages()
        }
        timer.resume()
        cleanupTimer = timer
    }

    deinit {
        cleanupTimer?.cancel()
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make test-swift`
Expected: PASS — T_ttl1 and T_ttl2 green, all existing tests still green

- [ ] **Step 5: Commit**

```bash
git add "ClaudeInSafari/Services/ScreenshotService.swift"
git commit -m "feat: add image TTL cleanup timer (Spec 025 §3)"
```

---

### Task 7: Orphan Response File Cleanup on Disconnect — Tests

**Files:**
- Modify: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Write failing test for disconnect file cleanup**

Add to `ToolRouterDispatchTests`, after `testDidDisconnect_cleansPendingRequestsForClient`:

```swift
    // T_disconnect2 — didDisconnect deletes response files for the disconnecting client (Spec 025 §4)
    func testDidDisconnect_deletesResponseFilesForClient() throws {
        guard let dir = AppConstants.responsesDirectoryURL else {
            throw XCTSkip("App Group unavailable in test environment")
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Create response files for two requests — one belonging to the disconnecting client
        let reqA = "req-disc-A"
        let reqB = "req-disc-B"
        let fileA = dir.appendingPathComponent("\(reqA).json")
        let fileB = dir.appendingPathComponent("\(reqB).json")
        try "{}".data(using: .utf8)!.write(to: fileA, options: .atomic)
        try "{}".data(using: .utf8)!.write(to: fileB, options: .atomic)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: fileA)
            try? FileManager.default.removeItem(at: fileB)
        }

        router.injectPendingRequest(requestId: reqA, clientId: "client-disc", jsonrpcId: 20)
        router.injectPendingRequest(requestId: reqB, clientId: "client-other", jsonrpcId: 21)

        // Disconnect client-disc — its response file should be deleted
        router.socketServer(server, didDisconnect: "client-disc")

        XCTAssertFalse(FileManager.default.fileExists(atPath: fileA.path),
                        "Response file for disconnected client should be deleted")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileB.path),
                       "Response file for other client should be preserved")
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `make test-swift`
Expected: FAIL — response file for disconnected client is NOT deleted (current behavior)

- [ ] **Step 3: Commit failing test**

```bash
git add Tests/Swift/ToolRouterTests.swift
git commit -m "test: add disconnect response file cleanup test (Spec 025 §4)"
```

---

### Task 8: Orphan Response File Cleanup on Disconnect — Implementation

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift:291-300`

- [ ] **Step 1: Add file cleanup to didDisconnect handler**

Replace the current `socketServer(_:didDisconnect:)` method (lines 291-300):

```swift
    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String) {
        NSLog("MCP client disconnected: \(clientId)")
        // Collect request IDs under lock, then release before doing file I/O
        pendingRequestsLock.lock()
        let toCancel = pendingRequests.filter { $0.value.clientId == clientId }.map { $0.key }
        toCancel.forEach {
            pendingRequests.removeValue(forKey: $0)
            pendingToolContext.removeValue(forKey: $0)
        }
        pendingRequestsLock.unlock()

        // Spec 025 §4: Delete orphaned response files outside the lock
        for requestId in toCancel {
            if let url = AppConstants.responseFileURL(for: requestId) {
                do {
                    try FileManager.default.removeItem(at: url)
                } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError {
                    // File doesn't exist — not an error
                } catch {
                    NSLog("ToolRouter: disconnect cleanup failed to delete response file for %@: %@", requestId, error.localizedDescription)
                }
            }
        }
    }
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `make test-swift`
Expected: PASS — T_disconnect2 green, all existing tests still green

- [ ] **Step 3: Commit**

```bash
git add "ClaudeInSafari/MCP/ToolRouter.swift"
git commit -m "feat: delete orphan response files on client disconnect (Spec 025 §4)"
```

---

### Task 9: Full Test Suite + Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all JavaScript tests**

Run: `npm test`
Expected: PASS — all tests green

- [ ] **Step 2: Run all Swift tests**

Run: `make test-swift`
Expected: PASS — all tests green

- [ ] **Step 3: Build the app**

Run: `make build`
Expected: BUILD SUCCEEDED

- [ ] **Step 4: Commit any remaining changes**

If any test adjustments were needed, commit them now.
