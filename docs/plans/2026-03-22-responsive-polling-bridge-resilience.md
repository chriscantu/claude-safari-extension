# Responsive Polling & Bridge Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce worst-case tool-call latency from ~5s to <500ms, eliminate per-call response polling overhead, and make the bridge survive native app restarts without Claude Desktop intervention (Spec 029).

**Architecture:** Four independent changes: (1) cap extension idle poll at 500ms, (2) exponential backoff in bridge socket retry, (3) Darwin notification for response delivery with 500ms fallback poll, (4) bridge auto-reconnect on socket loss with MCP re-initialization. Changes 1-2 are simple constant/loop edits. Change 3 has a sandbox POC gate. Change 4 transforms the bridge from a one-shot relay into a reconnecting state machine.

**Tech Stack:** Swift / XCTest (native side + bridge), JavaScript / Jest (extension side)

---

## Chunk 1: Cap Extension Idle Poll Interval (Change 1)

### Task 1: Update `POLL_IDLE_INTERVAL_MS` and fix test

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/background.js:25`
- Modify: `Tests/JS/background.test.js` (T11 assertion)

- [ ] **Step 1: Update the test to expect the new cap**

  In `Tests/JS/background.test.js`, find test T11 (line ~272). It currently asserts the idle interval is 5000ms. Update the assertion to expect 500ms:

  ```js
  // T11 - poll schedule: uses POLL_IDLE_INTERVAL_MS (500) when idle
  test("T11 - poll schedule: uses POLL_IDLE_INTERVAL_MS (500) when idle", async () => {
  ```

  Change the expected setTimeout value from `5000` to `500` in the assertion. The test body checks `setTimeout.mock.calls` - find the assertion that checks the idle interval cap and change `5000` to `500`.

- [ ] **Step 2: Run tests to verify T11 fails**

  ```fish
  npm test -- --testPathPattern=background.test.js 2>&1 | grep -E "(T11|FAIL|PASS)"
  ```

  Expected: T11 FAIL - background.js still uses 5000.

- [ ] **Step 3: Change the constant in background.js**

  In `background.js` line 25, change:

  ```js
  // Before
  const POLL_IDLE_INTERVAL_MS = 5000;

  // After
  const POLL_IDLE_INTERVAL_MS = 500;
  ```

- [ ] **Step 4: Add T14 - verify backoff never exceeds 500ms**

  After T13 in `background.test.js`, add:

  ```js
  // T14 - poll schedule: idle backoff caps at 500ms, not 5000ms (Spec 029 Change 1)
  test("T14 - idle backoff caps at 500ms, not 5000ms", async () => {
      const mock = makeBrowserMock();
      loadBackground({ browser: mock });

      // Advance through enough idle polls to hit the cap
      // Backoff: 100, 200, 400, 500 (capped), 500, ...
      for (let i = 0; i < 10; i++) {
          await jest.advanceTimersByTimeAsync(500);
      }

      // Check that no setTimeout was called with an interval > 500
      const calls = setTimeout.mock ? setTimeout.mock.calls : [];
      const intervals = calls.map(c => c[1]).filter(t => typeof t === "number");
      for (const interval of intervals) {
          expect(interval).toBeLessThanOrEqual(500);
      }
  });
  ```

- [ ] **Step 5: Run all JS tests to verify they pass**

  ```fish
  npm test
  ```

  Expected: all tests pass including T11 (updated) and T14 (new).

- [ ] **Step 6: Add observability log for poll pickup**

  In `background.js`, inside `pollForRequests`, after the `isActive = true` line (around line 150), add:

  ```js
  console.log("Poll: picked up request after " + (idleStreak * POLL_INTERVAL_MS) + "ms idle (interval was " +
      Math.min(POLL_INTERVAL_MS * Math.pow(2, idleStreak), POLL_IDLE_INTERVAL_MS) + "ms)");
  ```

  This logs the idle duration and poll interval when a request is picked up, per Spec 029 Observability.

- [ ] **Step 7: Run JS tests again to confirm no regressions**

  ```fish
  npm test
  ```

- [ ] **Step 8: Commit**

  ```fish
  echo "feat(background): cap idle poll interval at 500ms (Spec 029 Change 1)

  Reduces worst-case first-tool-call latency from 5s to 500ms by lowering
  POLL_IDLE_INTERVAL_MS. Adds observability log on request pickup.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari Extension/Resources/background.js" Tests/JS/background.test.js
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 2: Bridge Exponential Backoff (Change 2)

### Task 2: Replace fixed `sleep()` with exponential backoff

**Files:**
- Modify: `safari-mcp-bridge/BridgeRelay.swift:63-107`
- Test: `Tests/Swift/BridgeRelayTests.swift`

- [ ] **Step 1: Write tests for backoff formula**

  In `Tests/Swift/BridgeRelayTests.swift`, add after the existing tests:

  ```swift
  // MARK: - Exponential Backoff (Spec 029 Change 2)

  func testBackoffSequence_doublesFromBaseToMax() {
      // Verify the backoff calculation matches spec:
      // 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms, 2000ms
      let baseMs: UInt64 = 100_000  // 100ms in microseconds
      let maxMs: UInt64 = 2_000_000 // 2s in microseconds

      var delays: [UInt64] = []
      for attempt in 0..<7 {
          let delay = min(baseMs * (1 << UInt64(attempt)), maxMs)
          delays.append(delay)
      }

      XCTAssertEqual(delays, [
          100_000,    // 100ms
          200_000,    // 200ms
          400_000,    // 400ms
          800_000,    // 800ms
          1_600_000,  // 1600ms
          2_000_000,  // 2000ms (capped)
          2_000_000,  // 2000ms (capped)
      ])
  }

  func testBackoffTotalTime_staysWithinTimeout() {
      let baseMs: UInt64 = 100
      let maxMs: UInt64 = 2000
      let timeoutMs: UInt64 = 30_000

      var totalMs: UInt64 = 0
      var attempts = 0
      while totalMs < timeoutMs {
          let delay = min(baseMs * (1 << UInt64(attempts)), maxMs)
          totalMs += delay
          attempts += 1
      }

      // Should take multiple attempts to reach 30s
      XCTAssertGreaterThan(attempts, 15)
      XCTAssertLessThan(attempts, 25)
  }
  ```

- [ ] **Step 2: Run tests to verify they pass (formula validation)**

  ```fish
  make test-swift 2>&1 | grep -E "(testBackoff|FAIL|PASS)"
  ```

  Expected: PASS (pure math tests).

- [ ] **Step 3: Implement exponential backoff in `BridgeRelay.run()`**

  In `BridgeRelay.swift`, replace lines 63-107 (socket discovery loop). Change the constants and extract a `discoverSocket` function:

  ```swift
  // Replace:
  static let socketWaitTimeout: Int = 30
  static let socketPollInterval: UInt32 = 2 // seconds

  // With:
  static let socketWaitTimeoutMs: UInt64 = 30_000
  static let backoffBaseUs: UInt64 = 100_000  // 100ms in microseconds
  static let backoffMaxUs: UInt64 = 2_000_000 // 2s in microseconds

  /// Calculate backoff delay in microseconds for the given attempt (0-indexed).
  static func backoffDelay(attempt: Int) -> UInt64 {
      min(backoffBaseUs * (1 << UInt64(min(attempt, 20))), backoffMaxUs)
  }

  /// Discover and connect to the MCP socket with exponential backoff.
  /// Returns the connected fd, or -1 if the timeout expires.
  static func discoverSocket(logPrefix: String = "") -> Int32 {
      var fd: Int32 = -1
      var waited = false
      var elapsedUs: UInt64 = 0
      var attempt = 0

      while true {
          if let path = findNewestSocket(in: socketDirectory) {
              do {
                  fd = try connectToSocket(at: path)
                  let elapsedMs = elapsedUs / 1000
                  fputs("\(logPrefix)bridge: connected in \(elapsedMs)ms (attempt \(attempt + 1))\n", stderr)
                  break
              } catch let error as BridgeError {
                  if case .socketCreationFailed(let code) = error {
                      fputs("\(logPrefix){\"error\": \"Failed to create socket: \(String(cString: strerror(code)))\"}\n", stderr)
                      exit(1)
                  }
              } catch {
              }
          }

          if !waited {
              fputs("\(logPrefix)Waiting for Claude in Safari to start...\n", stderr)
              waited = true
          }

          if elapsedUs >= socketWaitTimeoutMs * 1000 {
              break
          }

          let delay = backoffDelay(attempt: attempt)
          usleep(UInt32(delay))
          elapsedUs += delay
          attempt += 1
      }

      return fd
  }
  ```

  Then update `run()` to call `discoverSocket()`:

  ```swift
  static func run() -> Never {
      let fd = discoverSocket()

      guard fd >= 0 else {
          fputs("{\"error\": \"Claude in Safari is not running after waiting up to \(socketWaitTimeoutMs / 1000)s. Launch the app and try again.\"}\n", stderr)
          exit(1)
      }

      // (rest of run() unchanged - stdin/stdout relay)
  ```

- [ ] **Step 4: Add test that calls `BridgeRelay.backoffDelay` directly**

  ```swift
  func testBackoffDelay_matchesExpectedSequence() {
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 0), 100_000)
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 1), 200_000)
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 2), 400_000)
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 3), 800_000)
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 4), 1_600_000)
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 5), 2_000_000) // capped
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 6), 2_000_000) // capped
      XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 99), 2_000_000) // still capped
  }
  ```

- [ ] **Step 5: Build and run all Swift tests**

  ```fish
  make test-swift
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```fish
  echo "feat(bridge): exponential backoff for socket discovery (Spec 029 Change 2)

  Replaces fixed 2s sleep with 100ms-to-2s exponential backoff. Typical
  cold-start when app is already running now connects in ~100ms instead
  of waiting up to 2s. Extracts discoverSocket() for reuse by Change 4.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add safari-mcp-bridge/BridgeRelay.swift Tests/Swift/BridgeRelayTests.swift
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 3: Darwin Notification for Response Delivery (Change 3)

This chunk has a **sandbox POC gate**: Darwin notifications may not work from the `appex` sandbox. Task 3 is the POC. If it fails, skip Tasks 4-5 and the fallback poll (Task 6) becomes the primary response delivery mechanism.

### Task 3: Sandbox POC - Darwin notification from extension handler

**Files:**
- Modify: `ClaudeInSafari Extension/SafariWebExtensionHandler.swift:72` (after response file write)
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift` (temporary observer in `performStartupCleanup`)

- [ ] **Step 1: Add Darwin notification post to `handleToolResponse`**

  In `SafariWebExtensionHandler.swift`, after the successful `responseData.write(to:)` (line 72) and before `respond(with: ["status": "ok"])` (line 79), add:

  ```swift
  // Spec 029 Change 3: Post Darwin notification to wake ToolRouter immediately.
  let darwinCenter = CFNotificationCenterGetDarwinNotifyCenter()
  let notifName = "com.chriscantu.claudeinsafari.response-ready" as CFString
  CFNotificationCenterPostNotification(darwinCenter, CFNotificationName(notifName), nil, nil, true)
  ```

- [ ] **Step 2: Add temporary Darwin observer to ToolRouter for POC**

  In `ToolRouter.swift`, add a temporary test at the end of `performStartupCleanup()`:

  ```swift
  // POC: verify Darwin notification is receivable from appex process
  let darwinCenter = CFNotificationCenterGetDarwinNotifyCenter()
  let notifName = "com.chriscantu.claudeinsafari.response-ready" as CFString
  let selfPtr = Unmanaged.passUnretained(self).toOpaque()
  CFNotificationCenterAddObserver(darwinCenter, selfPtr, { _, _, _, _, _ in
      NSLog("ToolRouter: Darwin notification received from appex - POC passed")
  }, notifName, nil, .deliverImmediately)
  NSLog("ToolRouter: Darwin notification POC observer registered")
  ```

- [ ] **Step 3: Build and test the POC**

  ```fish
  make kill && make build && make run && make health
  ```

  Then trigger a tool call:

  ```fish
  make send TOOL=read_page
  ```

  Check Console.app (filter: `claudeinsafari`) for:
  - `"ToolRouter: Darwin notification received from appex - POC passed"` then **POC passes**, proceed to Tasks 4-6
  - No such log then **POC fails**, skip Tasks 4-5, proceed directly to Task 6 (fallback poll only)

- [ ] **Step 4: Record POC result**

  If POC **passes**: continue to Task 4.
  If POC **fails**: remove the post from `SafariWebExtensionHandler.swift`, remove the POC observer from `performStartupCleanup()`, commit a note, and skip to Task 6.

  ```fish
  echo "chore(poc): Darwin notification from appex - [PASS/FAIL]

  Spec 029 Change 3 sandbox verification.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari Extension/SafariWebExtensionHandler.swift" ClaudeInSafari/MCP/ToolRouter.swift
  git commit -F /tmp/commitmsg
  ```

---

### Task 4: Add Darwin notification observer to ToolRouter (POC pass only)

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift` (add observer, `checkAllPendingResponses`, cleanup)
- Test: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Write the failing test for notification-based response delivery**

  In `Tests/Swift/ToolRouterTests.swift`, add at end:

  ```swift
  // MARK: - Darwin Notification Response Delivery (Spec 029 Change 3)

  func testCheckAllPendingResponses_deliversReadyResponse() throws {
      guard let dir = AppConstants.responsesDirectoryURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      let mockServer = MockMCPSocketServer()
      let router = ToolRouter(
          screenshotService: ScreenshotService(),
          gifService: GifService(),
          fileService: FileService()
      )
      router.setServer(mockServer)

      let requestId = "darwin-test-1"
      router.injectPendingRequest(requestId: requestId, clientId: "test-client", jsonrpcId: 50)

      // Write the response file (simulates what SafariWebExtensionHandler does)
      let responseFile = dir.appendingPathComponent("\(requestId).json")
      let response: [String: Any] = [
          "requestId": requestId,
          "result": ["content": [["type": "text", "text": "darwin delivery"]]]
      ]
      let data = try JSONSerialization.data(withJSONObject: response)
      try data.write(to: responseFile, options: .atomic)

      // Call checkAllPendingResponses (simulates Darwin notification callback)
      router.checkAllPendingResponsesForTest()

      // Response file should be deleted
      XCTAssertFalse(FileManager.default.fileExists(atPath: responseFile.path),
                      "Response file should be consumed")

      // MCP response should have been sent
      let json = mockServer.lastSentJSON()
      XCTAssertNotNil(json, "Should have sent MCP response")
  }

  func testCheckAllPendingResponses_handlesMultipleReadyResponses() throws {
      guard let dir = AppConstants.responsesDirectoryURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      let mockServer = MockMCPSocketServer()
      let router = ToolRouter(
          screenshotService: ScreenshotService(),
          gifService: GifService(),
          fileService: FileService()
      )
      router.setServer(mockServer)

      router.injectPendingRequest(requestId: "multi-1", clientId: "client-a", jsonrpcId: 51)
      router.injectPendingRequest(requestId: "multi-2", clientId: "client-a", jsonrpcId: 52)

      for reqId in ["multi-1", "multi-2"] {
          let file = dir.appendingPathComponent("\(reqId).json")
          let resp: [String: Any] = [
              "requestId": reqId,
              "result": ["content": [["type": "text", "text": "ok"]]]
          ]
          try JSONSerialization.data(withJSONObject: resp).write(to: file, options: .atomic)
      }

      router.checkAllPendingResponsesForTest()

      XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("multi-1.json").path))
      XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("multi-2.json").path))
      XCTAssertEqual(mockServer.sentCount(), 2)
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```fish
  make test-swift 2>&1 | grep -E "(testCheckAllPending|FAIL|PASS)"
  ```

  Expected: FAIL - `checkAllPendingResponsesForTest` does not exist yet.

- [ ] **Step 3: Add `responseQueue`, `checkAllPendingResponses`, and Darwin observer registration to ToolRouter**

  In `ToolRouter.swift`, add properties after `pendingRequestsLock` (line 105):

  ```swift
  /// Serial queue for Darwin notification callbacks.
  private let responseQueue = DispatchQueue(label: "com.chriscantu.claudeinsafari.response")

  /// Opaque pointer to self for Darwin notification registration/removal.
  private var darwinObserverPtr: UnsafeMutableRawPointer?
  ```

  Add `checkAllPendingResponses` after `readExtensionGeneration()`:

  ```swift
  /// Check all pending requests for available response files and deliver any that exist.
  /// Called by the Darwin notification callback and the fallback poll timer.
  func checkAllPendingResponses() {
      pendingRequestsLock.lock()
      let requestIds = Array(pendingRequests.keys)
      pendingRequestsLock.unlock()

      for requestId in requestIds {
          guard let fileURL = AppConstants.responseFileURL(for: requestId) else { continue }
          guard let data = try? Data(contentsOf: fileURL),
                let responseString = String(data: data, encoding: .utf8) else { continue }

          try? FileManager.default.removeItem(at: fileURL)

          pendingRequestsLock.lock()
          let pending = pendingRequests.removeValue(forKey: requestId)
          let toolCtx = pendingToolContext.removeValue(forKey: requestId)
          pendingRequestsLock.unlock()

          if let pending = pending {
              NSLog("ToolRouter: response for %@ delivered via notification", requestId)
              deliverExtensionResponse(
                  responseString, id: pending.jsonrpcId, to: pending.clientId,
                  toolName: toolCtx?.toolName ?? "",
                  arguments: toolCtx?.arguments ?? [:]
              )
          }
      }
  }

  /// Test-only: call checkAllPendingResponses from tests.
  func checkAllPendingResponsesForTest() {
      checkAllPendingResponses()
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```fish
  make test-swift 2>&1 | grep -E "(testCheckAllPending|FAIL|PASS)"
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```fish
  echo "feat(toolrouter): add checkAllPendingResponses for Darwin notify delivery (Spec 029 Change 3)

  New method scans all pending requests for available response files
  and delivers them. Called by Darwin notification callback and
  fallback poll timer.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
  git commit -F /tmp/commitmsg
  ```

---

### Task 5: Register Darwin observer and wire up lifecycle (POC pass only)

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift` (register observer, cleanup in stop)

- [ ] **Step 1: Replace POC observer with production registration**

  In `ToolRouter.swift`, remove the POC observer code from `performStartupCleanup()` and add `registerDarwinObserver()` and `removeDarwinObserver()`:

  ```swift
  /// Subscribe to the cross-process Darwin notification for response delivery.
  private func registerDarwinObserver() {
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      let name = "com.chriscantu.claudeinsafari.response-ready" as CFString
      darwinObserverPtr = Unmanaged.passUnretained(self).toOpaque()

      CFNotificationCenterAddObserver(
          center, darwinObserverPtr,
          { _, observer, _, _, _ in
              guard let observer = observer else { return }
              let router = Unmanaged<ToolRouter>.fromOpaque(observer).takeUnretainedValue()
              router.responseQueue.async {
                  router.checkAllPendingResponses()
              }
          },
          name, nil, .deliverImmediately
      )
      NSLog("ToolRouter: Darwin notification observer registered")
  }

  /// Unsubscribe from the Darwin notification. Called from stop(), not deinit,
  /// because by deinit time the Unmanaged pointer to self is dangling.
  private func removeDarwinObserver() {
      guard let ptr = darwinObserverPtr else { return }
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      CFNotificationCenterRemoveObserver(center, ptr, nil, nil)
      darwinObserverPtr = nil
      NSLog("ToolRouter: Darwin notification observer removed")
  }
  ```

  Call `registerDarwinObserver()` at the end of `performStartupCleanup()`.

  Add a `stop()` method:

  ```swift
  /// Tear down: remove Darwin observer.
  func stop() {
      removeDarwinObserver()
  }
  ```

  Verify `AppDelegate` calls `toolRouter?.stop()` on teardown. Check `applicationWillTerminate` or the equivalent lifecycle method. If no teardown call exists, add `toolRouter?.stop()` in `AppDelegate.applicationWillTerminate(_:)` (or `applicationShouldTerminate`). This ensures the Unmanaged pointer is released before ToolRouter is deallocated.

- [ ] **Step 2: Build and run all tests**

  ```fish
  make test-swift && npm test
  ```

  Expected: all pass.

- [ ] **Step 3: Manual verification**

  ```fish
  make kill && make build && make run && make health
  make send TOOL=read_page
  ```

  Check Console.app for: `"ToolRouter: response for <id> delivered via notification"`.

- [ ] **Step 4: Commit**

  ```fish
  echo "feat(toolrouter): register Darwin notification observer for response delivery (Spec 029 Change 3)

  ToolRouter subscribes to response-ready Darwin notification on startup.
  SafariWebExtensionHandler posts after writing each response file.
  Response delivery is now near-instant instead of up to 50ms polling.
  Observer cleaned up in stop() to avoid dangling pointer.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/MCP/ToolRouter.swift "ClaudeInSafari Extension/SafariWebExtensionHandler.swift"
  git commit -F /tmp/commitmsg
  ```

---

### Task 6: Replace 50ms poll with 500ms fallback poll

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift:804-856` (`pollForExtensionResponse`)
- Test: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Write failing test for 500ms fallback interval**

  In `Tests/Swift/ToolRouterTests.swift`, add:

  ```swift
  // MARK: - Fallback Poll Interval (Spec 029 Change 3)

  func testPollForExtensionResponse_fallbackInterval_is500ms() throws {
      XCTAssertEqual(ToolRouter.fallbackPollIntervalSeconds, 0.5,
                     "Fallback poll should be 500ms, not 50ms")
  }
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```fish
  make test-swift 2>&1 | grep -E "(testPollForExtensionResponse_fallback|FAIL|PASS)"
  ```

  Expected: FAIL - `fallbackPollIntervalSeconds` does not exist yet.

- [ ] **Step 3: Change the poll interval from 50ms to 500ms**

  In `ToolRouter.swift`, add a static constant near the top of the class:

  ```swift
  /// Fallback poll interval for response file checking (seconds).
  /// 500ms: belt-and-suspenders behind Darwin notification (Spec 029 Change 3).
  static let fallbackPollIntervalSeconds: TimeInterval = 0.5
  ```

  Then in `pollForExtensionResponse`, change the `asyncAfter` delay (line 852):

  ```swift
  // Before
  DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) { [weak self] in

  // After
  DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + Self.fallbackPollIntervalSeconds) { [weak self] in
  ```

- [ ] **Step 4: Add observability log for fallback poll delivery**

  In `pollForExtensionResponse`, in the response-file-found block (the `if let data = try? Data(contentsOf: fileURL)` block), add before `deliverExtensionResponse`:

  ```swift
  NSLog("ToolRouter: response for %@ delivered via fallback poll", requestId)
  ```

- [ ] **Step 5: Run all Swift tests**

  ```fish
  make test-swift
  ```

  Expected: all pass.

- [ ] **Step 6: Commit**

  ```fish
  echo "feat(toolrouter): change response poll from 50ms to 500ms fallback (Spec 029 Change 3)

  With Darwin notification as primary delivery, the poll is now a safety
  net. 500ms fallback reduces filesystem reads from 600 to 60 over the
  30s timeout while ensuring delivery if notification is lost.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 4: Bridge Auto-Reconnect (Change 4)

### Task 7: Refactor `run()` into a reconnect loop

**Files:**
- Modify: `safari-mcp-bridge/BridgeRelay.swift:70-204` (restructure `run()`)
- Test: `Tests/Swift/BridgeRelayTests.swift`

This is the most complex change. The current `run()` is a linear flow: discover, relay, exit. We need to transform it into: discover, initialize, relay, (on socket error), discover, initialize, relay, ... (exit on stdin EOF or timeout).

- [ ] **Step 1: Write tests for reconnect preconditions**

  In `Tests/Swift/BridgeRelayTests.swift`, add:

  ```swift
  // MARK: - Auto-Reconnect (Spec 029 Change 4)

  func testVerifyConnection_returnsNilForNonexistentSocket() throws {
      let result = BridgeRelay.verifyConnection(socketPath: "/tmp/nonexistent-\(UUID().uuidString).sock")
      XCTAssertNil(result, "Should return nil when socket does not exist")
  }

  func testBackoffDelay_largeAttemptDoesNotOverflow() {
      // Ensure attempt=99 doesn't cause integer overflow
      let delay = BridgeRelay.backoffDelay(attempt: 99)
      XCTAssertEqual(delay, BridgeRelay.backoffMaxUs, "Very large attempt should cap at max")
  }
  ```

- [ ] **Step 2: Run tests to confirm they pass**

  ```fish
  make test-swift 2>&1 | grep -E "(testVerifyConnection|testBackoffDelay_large|FAIL|PASS)"
  ```

  Expected: PASS.

- [ ] **Step 3: Add `RelayExitReason` enum and `performHandshake` method**

  In `BridgeRelay.swift`, add before `run()`:

  ```swift
  /// Reason the relay loop exited.
  enum RelayExitReason {
      case stdinEOF
      case socketError
  }

  /// Perform MCP initialize + notifications/initialized handshake on the given fd.
  /// Returns true on success. Sets a 5s read timeout during handshake, then removes it.
  static func performHandshake(fd: Int32) -> Bool {
      var tv = timeval(tv_sec: 5, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

      var leftover = Data()

      func sendLine(_ json: String) -> Bool {
          let data = (json + "\n").data(using: .utf8)!
          return data.withUnsafeBytes { ptr -> Bool in
              guard let base = ptr.baseAddress else { return false }
              let w = Darwin.write(fd, base, data.count)
              return w == data.count
          }
      }

      func readNextLine() -> [String: Any]? {
          if let idx = leftover.firstIndex(of: 0x0A) {
              let msgData = leftover[leftover.startIndex..<idx]
              leftover = Data(leftover[(idx + 1)...])
              return try? JSONSerialization.jsonObject(with: msgData) as? [String: Any]
          }
          let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 65536)
          defer { buf.deallocate() }
          while true {
              let n = Darwin.read(fd, buf, 65536)
              if n <= 0 { return nil }
              leftover.append(buf, count: n)
              if let idx = leftover.firstIndex(of: 0x0A) {
                  let msgData = leftover[leftover.startIndex..<idx]
                  leftover = Data(leftover[(idx + 1)...])
                  return try? JSONSerialization.jsonObject(with: msgData) as? [String: Any]
              }
          }
      }

      guard sendLine("{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"safari-mcp-bridge\",\"version\":\"1.0.0\"}}}") else { return false }
      guard readNextLine() != nil else { return false }

      guard sendLine("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}") else { return false }
      usleep(50_000)

      // Remove read timeout for relay phase
      tv = timeval(tv_sec: 0, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

      fputs("bridge: session initialized\n", stderr)
      return true
  }
  ```

- [ ] **Step 4: Extract relay loop into a separate `relay()` method**

  Add a static `relay` method that contains the current stdin-to-socket and socket-to-stdout relay threads. Returns `RelayExitReason`:

  ```swift
  /// Run the stdin-to-socket relay. Returns the reason it stopped.
  private static func relay(stdinFD: Int32, stdoutFD: Int32, socketFD fd: Int32) -> RelayExitReason {
      let group = DispatchGroup()
      let reasonLock = NSLock()
      var exitReason: RelayExitReason = .socketError

      // stdin -> socket
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
          let bufSize = 65536
          let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
          defer { buf.deallocate() }
          while true {
              let n = Darwin.read(stdinFD, buf, bufSize)
              if n == 0 {
                  reasonLock.lock()
                  exitReason = .stdinEOF
                  reasonLock.unlock()
                  break
              }
              if n < 0 {
                  if errno == EINTR { continue }
                  fputs("Bridge: read from stdin failed: \(String(cString: strerror(errno)))\n", stderr)
                  reasonLock.lock()
                  exitReason = .stdinEOF
                  reasonLock.unlock()
                  break
              }
              var written = 0
              while written < n {
                  let w = Darwin.write(fd, buf.advanced(by: written), n - written)
                  if w < 0 {
                      if errno == EINTR { continue }
                      fputs("Bridge: write to socket failed: \(String(cString: strerror(errno)))\n", stderr)
                      reasonLock.lock()
                      exitReason = .socketError
                      reasonLock.unlock()
                      shutdown(fd, SHUT_WR)
                      group.leave()
                      return
                  }
                  if w == 0 { break }
                  written += w
              }
          }
          shutdown(fd, SHUT_WR)
          group.leave()
      }

      // socket -> stdout
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
          let bufSize = 65536
          let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
          defer { buf.deallocate() }
          while true {
              let n = Darwin.read(fd, buf, bufSize)
              if n == 0 { break }
              if n < 0 {
                  if errno == EINTR { continue }
                  fputs("Bridge: read from socket failed: \(String(cString: strerror(errno)))\n", stderr)
                  break
              }
              var written = 0
              while written < n {
                  let w = Darwin.write(stdoutFD, buf.advanced(by: written), n - written)
                  if w < 0 {
                      if errno == EINTR { continue }
                      fputs("Bridge: write to stdout failed: \(String(cString: strerror(errno)))\n", stderr)
                      group.leave()
                      return
                  }
                  if w == 0 { break }
                  written += w
              }
          }
          group.leave()
      }

      group.wait()
      return exitReason
  }
  ```

- [ ] **Step 5: Rewrite `run()` with the reconnect outer loop**

  ```swift
  static func run() -> Never {
      var fd = discoverSocket()

      guard fd >= 0 else {
          fputs("{\"error\": \"Claude in Safari is not running after waiting up to \(socketWaitTimeoutMs / 1000)s. Launch the app and try again.\"}\n", stderr)
          exit(1)
      }

      // Initial MCP handshake
      if !performHandshake(fd: fd) {
          fputs("{\"error\": \"MCP handshake failed after initial connection.\"}\n", stderr)
          close(fd)
          exit(1)
      }

      BridgeRelay.bridgeSessionStart = Date()
      let stdinFD = fileno(stdin)
      let stdoutFD = fileno(stdout)

      // Outer reconnect loop
      while true {
          let exitReason = relay(stdinFD: stdinFD, stdoutFD: stdoutFD, socketFD: fd)

          switch exitReason {
          case .stdinEOF:
              close(fd)
              exit(0)

          case .socketError:
              close(fd)
              fputs("bridge: connection lost, reconnecting...\n", stderr)
              BridgeRelay.bridgeReconnectCount += 1

              fd = discoverSocket(logPrefix: "bridge: ")
              guard fd >= 0 else {
                  fputs("bridge: reconnect failed after \(socketWaitTimeoutMs / 1000)s, exiting\n", stderr)
                  exit(1)
              }

              guard performHandshake(fd: fd) else {
                  fputs("bridge: MCP re-initialization failed after reconnect, exiting\n", stderr)
                  close(fd)
                  exit(1)
              }

              fputs("bridge: reconnected and session re-initialized\n", stderr)
          }
      }
  }
  ```

- [ ] **Step 6: Build and run all Swift tests**

  ```fish
  make test-swift
  ```

  Expected: all pass.

- [ ] **Step 7: Commit**

  ```fish
  echo "feat(bridge): auto-reconnect on socket loss with MCP re-initialization (Spec 029 Change 4)

  Transforms run() from a one-shot relay into a reconnecting state machine.
  On socket-side errors, the bridge re-discovers the socket with exponential
  backoff and performs a fresh MCP initialize handshake before resuming
  relay. Stdin EOF still triggers clean exit. 30s timeout per reconnect.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add safari-mcp-bridge/BridgeRelay.swift Tests/Swift/BridgeRelayTests.swift
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 5: Observability (Spec 029)

### Task 8: Extend `StatusReporter` with session metrics

**Files:**
- Modify: `safari-mcp-bridge/BridgeRelay.swift` (add session tracking vars)
- Modify: `safari-mcp-bridge/StatusReporter.swift`

- [ ] **Step 1: Add session metrics variables**

  In `BridgeRelay.swift`, add near the top (after `bridgeAppGroupId`). These must be `static` because `run()` and `StatusReporter.printStatus()` are both static:

  ```swift
  /// Session metrics - written by run(), read by StatusReporter.
  static var bridgeSessionStart: Date?
  static var bridgeReconnectCount: Int = 0
  ```

  Note: `BridgeRelay.bridgeSessionStart = Date()` and `BridgeRelay.bridgeReconnectCount += 1` should already be set in Task 7's `run()`. Verify they are.

- [ ] **Step 2: Add session info to StatusReporter**

  In `StatusReporter.swift`, add after the existing config output (before the final `}`):

  ```swift
  print("")

  // Session info
  if let start = BridgeRelay.bridgeSessionStart {
      let uptime = Int(Date().timeIntervalSince(start))
      print("Session uptime: \(uptime)s")
      print("Reconnections: \(BridgeRelay.bridgeReconnectCount)")
  } else {
      print("Session: not active (--status shows runtime metrics only when relaying)")
  }
  ```

- [ ] **Step 3: Build to verify it compiles**

  ```fish
  make build
  ```

- [ ] **Step 4: Commit**

  ```fish
  echo "feat(bridge): add session uptime and reconnect count to --status (Spec 029)

  StatusReporter now shows session uptime and reconnection count,
  surfaced via make bridge-status and make doctor.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add safari-mcp-bridge/BridgeRelay.swift safari-mcp-bridge/StatusReporter.swift
  git commit -F /tmp/commitmsg
  ```

---

## Final Verification

- [ ] **Run both test suites clean**

  ```fish
  npm test && make test-swift
  ```

  Expected: all tests pass.

- [ ] **Manual smoke test**

  ```fish
  make kill && make build && make run && make health
  ```

  Expected: health check passes.

- [ ] **Verify idle poll improvement**

  After health passes, wait 15 seconds (enough for old backoff to reach 5s), then:

  ```fish
  make send TOOL=read_page
  ```

  Check Console.app for: `"Poll: picked up request after Xms idle (interval was Yms)"` - Y should never exceed 500.

- [ ] **Verify bridge reconnect (if Change 4 implemented)**

  With the bridge running (via Claude Desktop or manual), restart the app:

  ```fish
  make kill && make run
  ```

  Check stderr output from the bridge process for:
  - `"bridge: connection lost, reconnecting..."`
  - `"bridge: connected in Xms (attempt N)"`
  - `"bridge: session re-initialized"`

  Then trigger a tool call to verify it works after reconnect.

- [ ] **Full manual regression (PRINCIPLES.md rule 8)**

  Run all sections of `docs/regression-tests.md`. Every checklist item must be confirmed before merge. Use the `/regression-test` skill for the structured walkthrough.

- [ ] **Bump version**

  ```fish
  scripts/bump-version.sh <next-version>
  git add -A && git commit -m "chore: bump version to <next-version>"
  ```

  Determine the next version based on current version (check `scripts/bump-version.sh` output or `package.json`).

- [ ] **Open the PR**

  Use the `/commit-push-pr` skill. PR title: `feat: responsive polling + bridge resilience (Spec 029)`.

---

## Deferred

The following Spec 029 observability items live in the ToolRouter (native app process) and cannot be surfaced via `safari-mcp-bridge --status` without additional IPC. Defer to a follow-up:

- Average response delivery latency (last 10 requests)
- Last response delivery method (notify vs fallback poll)

These could be added to `make doctor` output by reading a metrics file from the App Group container.
