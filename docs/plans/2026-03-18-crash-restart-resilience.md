# Crash/Restart Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native app ↔ extension IPC layer resilient to app crashes, restarts, and background page reloads (Spec 023: H1, H2, M1).

**Architecture:** Three independent changes: (1) startup cleanup that truncates stale queue and response files, (2) extension generation marker that detects background page reloads within 50ms, (3) response file cleanup on timeout/failure. All use file-based IPC through the existing App Group container.

**Tech Stack:** Swift / XCTest (native side), JavaScript / Jest (extension side)

---

## Chunk 1: Constants + Startup Cleanup (H1 + M1 startup)

### Task 1: Add `extensionGenerationURL` to Constants.swift

**Files:**
- Modify: `Shared/Constants.swift:21-28`

- [ ] **Step 1: Add the computed property**

  In `Constants.swift`, add after `responseFileURL(for:)` (line 28):

  ```swift
  /// URL for the extension generation marker file (written by SafariWebExtensionHandler on extension_ready).
  static var extensionGenerationURL: URL? {
      appGroupContainerURL?.appendingPathComponent("extension_generation")
  }
  ```

- [ ] **Step 2: Build to verify it compiles**

  ```fish
  make build
  ```

- [ ] **Step 3: Commit**

  ```fish
  echo "feat(constants): add extensionGenerationURL for generation marker

  Supports Spec 023 H2 — background page reload detection via file-based
  generation marker in the App Group container root.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add Shared/Constants.swift
  git commit -F /tmp/commitmsg
  ```

---

### Task 2: Add `performStartupCleanup()` to ToolRouter

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift` (add method after init, ~line 38)
- Test: `Tests/Swift/ToolRouterTests.swift` (add tests at end of file)

- [ ] **Step 1: Write the three failing tests**

  Add at the end of `ToolRouterTests.swift`, before the final `}` of the class:

  ```swift
  // MARK: - Startup Cleanup (Spec 023 H1 + M1)

  func testPerformStartupCleanup_truncatesQueue() throws {
      // Setup: write a non-empty queue file
      guard let url = AppConstants.pendingRequestsQueueURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      let dir = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try JSONEncoder().encode(["stale-request-1", "stale-request-2"]).write(to: url, options: .atomic)

      let router = ToolRouter()
      router.performStartupCleanup()

      let data = try Data(contentsOf: url)
      let queue = try JSONDecoder().decode([String].self, from: data)
      XCTAssertEqual(queue, [], "Queue should be empty after startup cleanup")
  }

  func testPerformStartupCleanup_deletesResponseFiles() throws {
      guard let dir = AppConstants.responsesDirectoryURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      // Create two orphaned response files
      try "{}".data(using: .utf8)!.write(to: dir.appendingPathComponent("orphan-1.json"), options: .atomic)
      try "{}".data(using: .utf8)!.write(to: dir.appendingPathComponent("orphan-2.json"), options: .atomic)

      let router = ToolRouter()
      router.performStartupCleanup()

      let remaining = try FileManager.default.contentsOfDirectory(atPath: dir.path)
      XCTAssertEqual(remaining.count, 0, "All response files should be deleted after startup cleanup")
  }

  func testPerformStartupCleanup_appGroupUnavailable_doesNotCrash() {
      // This test verifies that cleanup is best-effort.
      // If App Group is unavailable, performStartupCleanup should not throw or crash.
      // We can't easily make the App Group nil in tests, so we just verify the method
      // is callable and returns without error on a fresh router.
      let router = ToolRouter()
      router.performStartupCleanup()
      // No assertion needed — test passes if no crash occurs
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```fish
  make test-swift 2>&1 | grep -E "(testPerformStartupCleanup|FAIL|PASS)"
  ```

  Expected: FAIL — `performStartupCleanup` does not exist yet.

- [ ] **Step 3: Implement `performStartupCleanup()`**

  In `ToolRouter.swift`, add after the closing `}` of the testable `init` (line 38):

  ```swift
  /// One-time startup cleanup: truncate stale pending requests and delete orphaned response files.
  /// Called by AppDelegate before the socket server starts accepting connections.
  /// All operations are best-effort — if the App Group is unavailable, cleanup is skipped.
  func performStartupCleanup() {
      // H1: Truncate pending request queue — any entries are from a dead session
      if let queueURL = AppConstants.pendingRequestsQueueURL {
          let dir = queueURL.deletingLastPathComponent()
          try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
          try? JSONEncoder().encode([String]()).write(to: queueURL, options: .atomic)
      }

      // M1: Delete all orphaned response files
      if let responsesDir = AppConstants.responsesDirectoryURL {
          if let files = try? FileManager.default.contentsOfDirectory(atPath: responsesDir.path) {
              for file in files where file.hasSuffix(".json") {
                  try? FileManager.default.removeItem(atPath: responsesDir.appendingPathComponent(file).path)
              }
          }
      }

      NSLog("ToolRouter: startup cleanup complete")
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```fish
  make test-swift 2>&1 | grep -E "(testPerformStartupCleanup|FAIL|PASS)"
  ```

  Expected: all three PASS.

- [ ] **Step 5: Commit**

  ```fish
  echo "feat(toolrouter): add performStartupCleanup for crash resilience (Spec 023 H1)

  Truncates stale pending_requests.json and deletes orphaned response files
  on startup. Safe because no CLI client is connected before the socket
  server starts.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
  git commit -F /tmp/commitmsg
  ```

---

### Task 3: Call `performStartupCleanup()` from AppDelegate

**Files:**
- Modify: `ClaudeInSafari/App/AppDelegate.swift:187-189`

- [ ] **Step 1: Add the cleanup call**

  In `AppDelegate.startMCPServer()`, insert after `toolRouter?.setServer(server)` (line 186) and before the `do { try mcpServer?.start()` block (line 189):

  ```swift
  toolRouter?.performStartupCleanup()
  ```

  The method should now read:

  ```swift
  private func startMCPServer() {
      let framer = MessageFramer()
      mcpServer = MCPSocketServer(framer: framer)
      toolRouter = ToolRouter()

      mcpServer?.delegate = toolRouter
      if let server = mcpServer {
          toolRouter?.setServer(server)
      }

      toolRouter?.performStartupCleanup()

      do {
          try mcpServer?.start()
  ```

- [ ] **Step 2: Build to verify it compiles**

  ```fish
  make build
  ```

- [ ] **Step 3: Commit**

  ```fish
  echo "feat(appdelegate): call performStartupCleanup before server start (Spec 023 H1)

  Ensures stale IPC state from a prior crash is cleared before the socket
  server accepts new CLI connections.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/App/AppDelegate.swift
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 2: Extension Generation Marker (H2)

### Task 4: Handle `extension_ready` in SafariWebExtensionHandler

**Files:**
- Modify: `ClaudeInSafari Extension/SafariWebExtensionHandler.swift:20-29`

- [ ] **Step 1: Add the `extension_ready` case**

  In the `switch messageType` block (line 20), add a new case before `default:`:

  ```swift
  case "extension_ready":
      handleExtensionReady(message: message, context: context)
  ```

- [ ] **Step 2: Add the handler method**

  Add after `handleStatusRequest` (line 91):

  ```swift
  private func handleExtensionReady(message: [String: Any], context: NSExtensionContext) {
      let generation = message["generation"] as? String ?? ""
      if let url = AppConstants.extensionGenerationURL {
          try? generation.data(using: .utf8)?.write(to: url, options: .atomic)
      }
      respond(with: ["status": "ok"], context: context)
  }
  ```

- [ ] **Step 3: Build to verify it compiles**

  ```fish
  make build
  ```

- [ ] **Step 4: Commit**

  ```fish
  echo "feat(handler): handle extension_ready message — write generation marker (Spec 023 H2)

  The extension sends this on background page load. SafariWebExtensionHandler
  writes the generation string to the App Group container so ToolRouter can
  detect background page reloads during poll.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari Extension/SafariWebExtensionHandler.swift"
  git commit -F /tmp/commitmsg
  ```

---

### Task 5: Add generation check to ToolRouter poll loop

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift:664-716` (forwardToExtension + pollForExtensionResponse)
- Test: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Write the two failing tests**

  Add at the end of `ToolRouterTests.swift`:

  ```swift
  // MARK: - Extension Generation Detection (Spec 023 H2)

  func testReadExtensionGeneration_returnsFileContents() throws {
      guard let url = AppConstants.extensionGenerationURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      let dir = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try "test-gen-abc".data(using: .utf8)!.write(to: url, options: .atomic)

      let router = ToolRouter()
      let gen = router.readExtensionGeneration()
      XCTAssertEqual(gen, "test-gen-abc")

      // Cleanup
      try? FileManager.default.removeItem(at: url)
  }

  func testReadExtensionGeneration_returnsNilWhenFileAbsent() throws {
      // Ensure no generation file exists
      if let url = AppConstants.extensionGenerationURL {
          try? FileManager.default.removeItem(at: url)
      }

      let router = ToolRouter()
      let gen = router.readExtensionGeneration()
      XCTAssertNil(gen, "Should return nil when generation file does not exist")
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```fish
  make test-swift 2>&1 | grep -E "(testReadExtensionGeneration|FAIL|PASS)"
  ```

  Expected: FAIL — `readExtensionGeneration` does not exist yet.

- [ ] **Step 3: Add `readExtensionGeneration()` method**

  In `ToolRouter.swift`, add after `performStartupCleanup()`:

  ```swift
  /// Read the current extension generation marker from the App Group file.
  /// Returns nil if the file does not exist or is unreadable.
  func readExtensionGeneration() -> String? {
      guard let url = AppConstants.extensionGenerationURL,
            let data = try? Data(contentsOf: url) else { return nil }
      return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```fish
  make test-swift 2>&1 | grep -E "(testReadExtensionGeneration|FAIL|PASS)"
  ```

  Expected: PASS.

- [ ] **Step 5: Write generation-mismatch poll tests**

  These tests drive the generation check indirectly via the end-to-end tool call path. Add at the end of `ToolRouterTests.swift`:

  ```swift
  func testPollForExtensionResponse_generationMismatch_failsImmediately() throws {
      guard let genURL = AppConstants.extensionGenerationURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      guard let dir = AppConstants.responsesDirectoryURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      // Write initial generation
      try "gen-A".data(using: .utf8)!.write(to: genURL, options: .atomic)

      let mockServer = MockMCPSocketServer()
      let router = ToolRouter(
          screenshotService: ScreenshotService(),
          gifService: GifService(),
          fileService: FileService()
      )
      router.setServer(mockServer)

      // Inject a pending request and call pollForExtensionResponse indirectly
      // by using forwardToExtensionForTest (which we'll add as a test hook)
      let requestId = "gen-mismatch-test"
      router.injectPendingRequest(requestId: requestId, clientId: "test-client", jsonrpcId: 42)

      // Now change the generation to simulate a background page reload
      try "gen-B".data(using: .utf8)!.write(to: genURL, options: .atomic)

      // Call pollForExtensionResponse via test hook with snapshot "gen-A"
      router.pollForExtensionResponseForTest(requestId: requestId, deadline: Date().addingTimeInterval(30),
                                              generationSnapshot: "gen-A")

      // Give the poll one tick to detect the mismatch (it's synchronous on first check)
      let expectation = XCTestExpectation(description: "Poll detects generation mismatch")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { expectation.fulfill() }
      wait(for: [expectation], timeout: 1.0)

      // The error response should contain "Extension reloaded"
      let json = mockServer.lastSentJSON()
      let errorMsg = (json?["error"] as? [String: Any])?["message"] as? String ?? ""
      XCTAssertTrue(errorMsg.contains("Extension reloaded"), "Expected generation mismatch error, got: \(errorMsg)")

      // Cleanup
      try? FileManager.default.removeItem(at: genURL)
  }

  func testPollForExtensionResponse_nilGeneration_doesNotFail() throws {
      guard let dir = AppConstants.responsesDirectoryURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      // Ensure NO generation file exists
      if let genURL = AppConstants.extensionGenerationURL {
          try? FileManager.default.removeItem(at: genURL)
      }

      let mockServer = MockMCPSocketServer()
      let router = ToolRouter(
          screenshotService: ScreenshotService(),
          gifService: GifService(),
          fileService: FileService()
      )
      router.setServer(mockServer)

      let requestId = "nil-gen-test"
      router.injectPendingRequest(requestId: requestId, clientId: "test-client", jsonrpcId: 43)

      // Poll with nil generation snapshot — should NOT fail immediately
      router.pollForExtensionResponseForTest(requestId: requestId, deadline: Date().addingTimeInterval(0.15),
                                              generationSnapshot: nil)

      // Wait just past deadline for the timeout to fire
      let expectation = XCTestExpectation(description: "Poll times out normally")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
      wait(for: [expectation], timeout: 1.0)

      // The error should be a timeout, NOT a generation mismatch
      let json = mockServer.lastSentJSON()
      let errorMsg = (json?["error"] as? [String: Any])?["message"] as? String ?? ""
      XCTAssertTrue(errorMsg.contains("timeout"), "Expected timeout error, got: \(errorMsg)")
  }
  ```

- [ ] **Step 6: Add `pollForExtensionResponseForTest` hook**

  In `ToolRouter.swift`, add after `failPendingRequestForTest` (or after `injectPendingRequest` if Task 6 hasn't been done yet):

  ```swift
  /// Test-only: call pollForExtensionResponse from tests.
  func pollForExtensionResponseForTest(requestId: String, deadline: Date, generationSnapshot: String?) {
      pollForExtensionResponse(requestId: requestId, deadline: deadline, generationSnapshot: generationSnapshot)
  }
  ```

  Note: This must be added AFTER Step 8 below (which creates `pollForExtensionResponse` with the `generationSnapshot` parameter). During TDD, Steps 5–6 will initially fail with a build error ("method does not exist"), which resolves after Step 8 implements the method.

- [ ] **Step 7: Modify `forwardToExtension` to snapshot generation**

  In `forwardToExtension` (line 664), add generation snapshot and pass it to `pollForExtensionResponse`. Replace the method:

  ```swift
  private func forwardToExtension(_ queued: QueuedToolRequest, id: Any?, clientId: String,
                                   arguments: [String: Any] = [:]) {
      guard enqueueToolRequest(queued) else {
          sendError(id: id, code: -32000, message: "Failed to enqueue tool request", to: clientId)
          return
      }

      let generationSnapshot = readExtensionGeneration()

      pendingRequestsLock.lock()
      pendingRequests[queued.requestId] = (clientId: clientId, jsonrpcId: id)
      pendingToolContext[queued.requestId] = (toolName: queued.tool, arguments: arguments)
      pendingRequestsLock.unlock()

      pollForExtensionResponse(requestId: queued.requestId, deadline: Date().addingTimeInterval(30),
                               generationSnapshot: generationSnapshot)
  }
  ```

- [ ] **Step 8: Modify `pollForExtensionResponse` to check generation**

  Replace the method signature and add the generation check after the response-file check (per spec: check generation only when no response file is found):

  ```swift
  private func pollForExtensionResponse(requestId: String, deadline: Date,
                                         generationSnapshot: String?) {
      guard let fileURL = AppConstants.responseFileURL(for: requestId) else {
          failPendingRequest(requestId: requestId, message: "App Group unavailable")
          return
      }

      // Check for response file first — a valid response takes priority over generation changes
      if let data = try? Data(contentsOf: fileURL),
         let responseString = String(data: data, encoding: .utf8) {
          // Delete the file so it isn't processed twice.
          try? FileManager.default.removeItem(at: fileURL)
          pendingRequestsLock.lock()
          let pending = pendingRequests.removeValue(forKey: requestId)
          let toolCtx = pendingToolContext.removeValue(forKey: requestId)
          pendingRequestsLock.unlock()
          if let pending = pending {
              deliverExtensionResponse(
                  responseString, id: pending.jsonrpcId, to: pending.clientId,
                  toolName: toolCtx?.toolName ?? "",
                  arguments: toolCtx?.arguments ?? [:]
              )
          }
          return
      }

      // H2: Check for extension generation mismatch (background page reloaded)
      // Only check when we have a snapshot — nil means extension hadn't sent
      // extension_ready yet, so we can't detect a reload.
      if let snapshot = generationSnapshot {
          let current = readExtensionGeneration()
          if let current = current, current != snapshot {
              NSLog("ToolRouter: extension generation changed (\(snapshot) → \(current)), failing request \(requestId)")
              failPendingRequest(requestId: requestId, message: "Extension reloaded during tool execution")
              return
          }
      }

      guard Date() < deadline else {
          failPendingRequest(requestId: requestId, message: "Extension response timeout (30s)")
          return
      }

      pendingRequestsLock.lock()
      let isActive = pendingRequests[requestId] != nil
      pendingRequestsLock.unlock()
      guard isActive else { return }

      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) { [weak self] in
          self?.pollForExtensionResponse(requestId: requestId, deadline: deadline,
                                          generationSnapshot: generationSnapshot)
      }
  }
  ```

- [ ] **Step 9: Build and run full test suite (including generation-mismatch tests)**

  ```fish
  make test-swift
  ```

  Expected: all tests pass.

- [ ] **Step 10: Commit**

  ```fish
  echo "feat(toolrouter): add generation-based background page reload detection (Spec 023 H2)

  forwardToExtension snapshots the extension generation marker from the App
  Group file. pollForExtensionResponse re-reads it on each tick and fails
  immediately on mismatch instead of waiting the full 30s timeout.
  Generation check is skipped when snapshot is nil (first call before
  extension_ready arrives).

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 3: Response File Cleanup on Failure (M1 ongoing)

### Task 6: Delete response file in `failPendingRequest`

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift:718-726` (failPendingRequest)
- Test: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Write the failing test**

  Add at the end of `ToolRouterTests.swift`:

  ```swift
  // MARK: - Response File Cleanup (Spec 023 M1)

  func testFailPendingRequest_deletesResponseFile() throws {
      guard let dir = AppConstants.responsesDirectoryURL else {
          throw XCTSkip("App Group unavailable in test environment")
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      let requestId = "test-cleanup-req"
      let responseFile = dir.appendingPathComponent("\(requestId).json")
      try "{}".data(using: .utf8)!.write(to: responseFile, options: .atomic)
      XCTAssertTrue(FileManager.default.fileExists(atPath: responseFile.path), "Precondition: file exists")

      let mockServer = MockMCPSocketServer()
      let router = ToolRouter(
          screenshotService: ScreenshotService(),
          gifService: GifService(),
          fileService: FileService()
      )
      router.setServer(mockServer)

      // Inject a pending request so failPendingRequest has something to fail
      router.injectPendingRequest(requestId: requestId, clientId: "test-client", jsonrpcId: 1)
      router.failPendingRequestForTest(requestId: requestId, message: "test timeout")

      XCTAssertFalse(FileManager.default.fileExists(atPath: responseFile.path),
                      "Response file should be deleted after failPendingRequest")
  }
  ```

- [ ] **Step 2: Add `failPendingRequestForTest` test hook**

  In `ToolRouter.swift`, add after `failPendingRequest`. Note: `injectPendingRequest` already exists at line 85 — do NOT add a duplicate.

  ```swift
  /// Test-only: call failPendingRequest from tests.
  func failPendingRequestForTest(requestId: String, message: String) {
      failPendingRequest(requestId: requestId, message: message)
  }
  ```

- [ ] **Step 3: Add response file deletion to `failPendingRequest`**

  In `failPendingRequest`, add the file deletion before the existing logic:

  ```swift
  private func failPendingRequest(requestId: String, message: String) {
      // M1: Delete the response file to prevent orphans
      if let url = AppConstants.responseFileURL(for: requestId) {
          try? FileManager.default.removeItem(at: url)
      }

      pendingRequestsLock.lock()
      let pending = pendingRequests.removeValue(forKey: requestId)
      pendingToolContext.removeValue(forKey: requestId)
      pendingRequestsLock.unlock()
      if let pending = pending {
          sendError(id: pending.jsonrpcId, code: -32000, message: message, to: pending.clientId)
      }
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```fish
  make test-swift 2>&1 | grep -E "(testFailPendingRequest|FAIL|PASS)"
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```fish
  echo "fix(toolrouter): delete response file on timeout/failure (Spec 023 M1)

  failPendingRequest now removes the response file for the failed requestId.
  Prevents orphaned response files when the extension writes a response after
  the native side has already timed out.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 4: Extension Side (H2 JS)

### Task 7: Send `extension_ready` on background page load

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/background.js:365-368`
- Test: `Tests/JS/background.test.js`

- [ ] **Step 1: Write the failing test**

  Add at the end of `background.test.js`, before the final closing:

  Inside the existing `describe("background.js poll loop", ...)` block, add after the last test:

  ```js
  // T13 — extension_ready: sends generation marker on load (Spec 023 H2)
  test("T13 — sends extension_ready with generation on load", () => {
      const mock = makeBrowserMock();
      loadBackground({ browser: mock });

      // Find the extension_ready call among all sendNativeMessage calls
      const readyCalls = mock.runtime.sendNativeMessage.mock.calls.filter(
          (call) => call[1] && call[1].type === "extension_ready"
      );
      expect(readyCalls.length).toBe(1);
      expect(readyCalls[0][1].generation).toBeDefined();
      expect(typeof readyCalls[0][1].generation).toBe("string");
      expect(readyCalls[0][1].generation.length).toBeGreaterThan(0);
  });
  ```

  This uses the existing `loadBackground` helper and runs inside the `describe` block's `beforeEach`/`afterEach` lifecycle (fake timers, console spies, global cleanup).

- [ ] **Step 2: Run tests to verify it fails**

  ```fish
  npm test -- --testPathPattern=background.test.js 2>&1 | grep -E "(T13|FAIL|PASS)"
  ```

  Expected: FAIL — no `extension_ready` message is sent yet.

- [ ] **Step 3: Add `extension_ready` send to background.js**

  In `background.js`, add before `pollForRequests();` (line 366):

  ```js
  // H2 (Spec 023): Send generation marker so the native app can detect background page reloads.
  // Fire-and-forget — if the native app is not running, this fails silently.
  var extensionGeneration = Date.now() + "-" + Math.random();
  browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
      type: "extension_ready",
      generation: extensionGeneration,
  }).catch(function (e) {
      console.warn("extension_ready: failed to send generation marker (non-critical):", e && e.message);
  });
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```fish
  npm test -- --testPathPattern=background.test.js
  ```

  Expected: all tests pass including T13.

- [ ] **Step 5: Commit**

  ```fish
  echo "feat(background): send extension_ready generation marker on load (Spec 023 H2)

  The background page sends its generation string to the native app on load.
  ToolRouter uses this to detect background page reloads and fail in-flight
  requests immediately instead of waiting the full 30s timeout.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari Extension/Resources/background.js" Tests/JS/background.test.js
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

  Expected: health check passes. Verify in Console.app that `"ToolRouter: startup cleanup complete"` appears on launch.

- [ ] **Open the PR**

  ```fish
  git push -u origin fix/crash-restart-resilience
  ```

  Use the `/commit-push-pr` skill or open manually. PR title: `fix: crash/restart resilience — startup cleanup, generation detection, response file cleanup (Spec 023)`.
