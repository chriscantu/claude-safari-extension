# Swift Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all meaningful Swift test coverage gaps — error classification, debounce logic, lifecycle coordination, zoom parsing, socket cleanup.

**Architecture:** Five independent chunks: (1) extract+test AppleScriptBridge error classification, (2) extend mock+test PermissionMonitor debounce, (3) new AppDelegateTests for notification routing and lifecycle, (4) extract+test ToolRouter zoom region parsing, (5) test MCPSocketServer stale socket cleanup. Each chunk is its own commit.

**Tech Stack:** Swift / XCTest

---

## Chunk 1: AppleScriptBridge — error classification

### Task 1: Extract `classifyScriptError` and add tests

**Files:**
- Modify: `ClaudeInSafari/Services/AppleScriptBridge.swift:146-209`
- Modify: `Tests/Swift/AppleScriptBridgeTests.swift`

- [ ] **Step 1: Extract `classifyScriptError` from `runAppleScript`**

  Add this `internal` method to `AppleScriptBridge`, immediately before `runAppleScript`:

  ```swift
  /// Classifies an osascript failure into a typed ResizeError.
  /// Extracted from runAppleScript() for testability — the matching logic
  /// is the most fragile part (depends on macOS error code formats).
  func classifyScriptError(terminationReason: Process.TerminationReason,
                           exitCode: Int32, stderr: String) -> ResizeError {
      if terminationReason == .uncaughtSignal {
          return .executionFailed("osascript was killed by signal \(exitCode)")
      }

      let message = stderr.trimmingCharacters(in: .whitespacesAndNewlines)

      if message.contains("(9001)") { return .noWindowFound }
      if message.contains("(9002)") { return .fullscreen }

      if message.contains("-1743") || message.contains("-25212")
          || message.lowercased().contains("not authorized") {
          return .permissionDenied
      }

      return .executionFailed(
          message.isEmpty ? "osascript exited with status \(exitCode)" : message
      )
  }
  ```

  Then replace the classification logic in `runAppleScript` (lines 180–208) with a call to this method. The new `runAppleScript` ending should be:

  ```swift
      process.waitUntilExit()
      group.wait()

      guard process.terminationStatus == 0 else {
          let message = String(data: stderrData, encoding: .utf8) ?? ""
          throw classifyScriptError(
              terminationReason: process.terminationReason,
              exitCode: process.terminationStatus,
              stderr: message
          )
      }
  }
  ```

  Note: the `trimmingCharacters` call moves into `classifyScriptError` so both paths (direct call and runAppleScript) trim consistently.

- [ ] **Step 2: Write the 9 failing tests**

  Add these test methods to `AppleScriptBridgeTests.swift` before the final `}`:

  ```swift
  // MARK: - classifyScriptError

  func testClassifyScriptError_sentinel9001_returnsNoWindowFound() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "execution error: RESIZE_NO_WINDOW (9001)")
      guard case .noWindowFound = error else {
          XCTFail("Expected .noWindowFound, got \(error)")
          return
      }
  }

  func testClassifyScriptError_sentinel9002_returnsFullscreen() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "execution error: RESIZE_FULLSCREEN (9002)")
      guard case .fullscreen = error else {
          XCTFail("Expected .fullscreen, got \(error)")
          return
      }
  }

  func testClassifyScriptError_tcc1743_returnsPermissionDenied() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "execution error: Not authorized to send Apple events (-1743)")
      guard case .permissionDenied = error else {
          XCTFail("Expected .permissionDenied, got \(error)")
          return
      }
  }

  func testClassifyScriptError_tcc25212_returnsPermissionDenied() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "System Events got an error: osascript is not allowed (-25212)")
      guard case .permissionDenied = error else {
          XCTFail("Expected .permissionDenied, got \(error)")
          return
      }
  }

  func testClassifyScriptError_notAuthorizedCaseInsensitive_returnsPermissionDenied() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "Not Authorized to perform this action")
      guard case .permissionDenied = error else {
          XCTFail("Expected .permissionDenied, got \(error)")
          return
      }
  }

  func testClassifyScriptError_signalKill_returnsExecutionFailed() {
      let error = bridge.classifyScriptError(
          terminationReason: .uncaughtSignal, exitCode: 9,
          stderr: "")
      guard case .executionFailed(let detail) = error else {
          XCTFail("Expected .executionFailed, got \(error)")
          return
      }
      XCTAssertTrue(detail.contains("signal"), "Expected signal info in: \(detail)")
      XCTAssertTrue(detail.contains("9"), "Expected signal number in: \(detail)")
  }

  func testClassifyScriptError_genericNonZero_returnsExecutionFailedWithStderr() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "some unexpected error")
      guard case .executionFailed(let detail) = error else {
          XCTFail("Expected .executionFailed, got \(error)")
          return
      }
      XCTAssertEqual(detail, "some unexpected error")
  }

  func testClassifyScriptError_emptyStderr_returnsExecutionFailedWithExitCode() {
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 42,
          stderr: "")
      guard case .executionFailed(let detail) = error else {
          XCTFail("Expected .executionFailed, got \(error)")
          return
      }
      XCTAssertTrue(detail.contains("42"), "Expected exit code in: \(detail)")
  }

  func testClassifyScriptError_sentinelTakesPriorityOverTCC() {
      // stderr contains both (9001) and -1743 — sentinel should match first
      let error = bridge.classifyScriptError(
          terminationReason: .exit, exitCode: 1,
          stderr: "error (9001) also -1743")
      guard case .noWindowFound = error else {
          XCTFail("Expected .noWindowFound (sentinel priority), got \(error)")
          return
      }
  }
  ```

- [ ] **Step 3: Run tests — all 9 should pass**

  ```fish
  make test-swift
  ```

  Expected: all tests pass including 9 new `classifyScriptError` tests.

- [ ] **Step 4: Commit**

  ```fish
  echo "test(AppleScriptBridge): extract and test classifyScriptError

  Extracts error classification from runAppleScript() into a testable
  internal method. Adds 9 tests covering sentinel codes, TCC denial
  codes, signal kills, and priority ordering. No behavior change.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/Services/AppleScriptBridge.swift" "Tests/Swift/AppleScriptBridgeTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 2: PermissionMonitor — debounce logic

### Task 2: Extend mock and add debounce tests

**Files:**
- Modify: `Tests/Swift/PermissionMonitorTests.swift`

- [ ] **Step 1: Extend MockPermissionChecker with sequence support**

  In `Tests/Swift/PermissionMonitorTests.swift`, add a `extensionEnabledSequence` property to `MockPermissionChecker` and update `getExtensionEnabled`:

  Replace:
  ```swift
  func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
      completion(extensionEnabled)
  }
  ```

  With:
  ```swift
  var extensionEnabledSequence: [Bool] = []

  func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
      if !extensionEnabledSequence.isEmpty {
          completion(extensionEnabledSequence.removeFirst())
      } else {
          completion(extensionEnabled)
      }
  }
  ```

- [ ] **Step 2: Write the 5 debounce tests**

  Add these test methods before the final `}` of `PermissionMonitorTests`:

  ```swift
  // MARK: - Debounce logic

  // D1 — First call reports raw value via fallback (lastExtensionEnabled is nil)
  func testDebounce_firstCallReportsRawValue() {
      let checker = MockPermissionChecker()
      checker.extensionEnabledSequence = [true]
      let monitor = PermissionMonitor(checker: checker)

      let exp = expectation(description: "firstCall")
      monitor.checkAll { status in
          XCTAssertTrue(status.extensionEnabled, "First call should report raw value")
          exp.fulfill()
      }
      waitForExpectations(timeout: 1)
  }

  // D2 — Single flicker is suppressed: stable true, then one false → still true
  func testDebounce_singleFlickerSuppressed() {
      let checker = MockPermissionChecker()
      // First two calls return true (establishes stable state), third returns false (flicker)
      checker.extensionEnabledSequence = [true, true, false]
      let monitor = PermissionMonitor(checker: checker)

      let exp1 = expectation(description: "call1")
      let exp2 = expectation(description: "call2")
      let exp3 = expectation(description: "call3")

      // Call 1: true (first read, adopted via fallback)
      monitor.checkAll { status in
          XCTAssertTrue(status.extensionEnabled)
          exp1.fulfill()
      }
      waitForExpectations(timeout: 1)

      // Call 2: true (matches pending → adopted as lastExtensionEnabled)
      monitor.checkAll { status in
          XCTAssertTrue(status.extensionEnabled)
          exp2.fulfill()
      }
      waitForExpectations(timeout: 1)

      // Call 3: false (single flicker → buffered, reports last stable = true)
      monitor.checkAll { status in
          XCTAssertTrue(status.extensionEnabled, "Single flicker should be suppressed")
          exp3.fulfill()
      }
      waitForExpectations(timeout: 1)
  }

  // D3 — Two consecutive false → adopts false
  func testDebounce_twoConsecutiveAdopts() {
      let checker = MockPermissionChecker()
      // First two calls return true (stable), then two false (should adopt)
      checker.extensionEnabledSequence = [true, true, false, false]
      let monitor = PermissionMonitor(checker: checker)

      let exp1 = expectation(description: "call1")
      let exp2 = expectation(description: "call2")
      let exp3 = expectation(description: "call3")
      let exp4 = expectation(description: "call4")

      monitor.checkAll { _ in exp1.fulfill() }
      waitForExpectations(timeout: 1)
      monitor.checkAll { _ in exp2.fulfill() }
      waitForExpectations(timeout: 1)
      monitor.checkAll { _ in exp3.fulfill() }
      waitForExpectations(timeout: 1)

      // Call 4: second consecutive false → adopted
      monitor.checkAll { status in
          XCTAssertFalse(status.extensionEnabled, "Two consecutive false should adopt")
          exp4.fulfill()
      }
      waitForExpectations(timeout: 1)
  }

  // D4 — Alternating values never change from initial
  func testDebounce_alternatingNeverChanges() {
      let checker = MockPermissionChecker()
      // true, false, true, false — never two in a row
      checker.extensionEnabledSequence = [true, false, true, false]
      let monitor = PermissionMonitor(checker: checker)

      var results: [Bool] = []
      for i in 0..<4 {
          let exp = expectation(description: "call\(i)")
          monitor.checkAll { status in
              results.append(status.extensionEnabled)
              exp.fulfill()
          }
          waitForExpectations(timeout: 1)
      }

      // All should report true (initial value never overridden)
      XCTAssertEqual(results, [true, true, true, true],
                     "Alternating values should never change reported state")
  }

  // D5 — Dealloc mid-check delivers safe default
  func testDebounce_deallocMidCheck_deliversSafeDefault() {
      let checker = MockPermissionChecker()
      checker.accessibilityGranted = true
      checker.screenRecordingGranted = true

      // Use async getExtensionEnabled to create a window where monitor can be deallocated
      let asyncChecker = AsyncMockPermissionChecker()
      asyncChecker.accessibilityGranted = true
      asyncChecker.screenRecordingGranted = true
      asyncChecker.extensionEnabled = true

      var monitor: PermissionMonitor? = PermissionMonitor(checker: asyncChecker)

      let exp = expectation(description: "dealloc")
      monitor?.checkAll { status in
          // Monitor was deallocated before completion — should get safe default
          XCTAssertFalse(status.extensionEnabled, "Dealloc should deliver false")
          XCTAssertFalse(status.screenRecording, "Dealloc should deliver false")
          XCTAssertFalse(status.accessibility, "Dealloc should deliver false")
          exp.fulfill()
      }
      // Deallocate before the async completion fires
      monitor = nil

      waitForExpectations(timeout: 2)
  }
  ```

- [ ] **Step 3: Add `AsyncMockPermissionChecker` for the dealloc test**

  Add this class after `MockPermissionChecker` in the same file:

  ```swift
  /// Mock that delivers getExtensionEnabled asynchronously (on a background queue)
  /// to create a window for deallocation testing.
  final class AsyncMockPermissionChecker: PermissionChecking {
      var accessibilityGranted = false
      var screenRecordingGranted = false
      var extensionEnabled = false

      func isAccessibilityGranted() -> Bool { accessibilityGranted }
      func isScreenRecordingGranted() -> Bool { screenRecordingGranted }
      func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
          DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [extensionEnabled] in
              completion(extensionEnabled)
          }
      }
      func registerAccessibility() {}
      func requestAccessibility() {}
      func registerScreenRecording() {}
  }
  ```

- [ ] **Step 4: Run tests**

  ```fish
  make test-swift
  ```

  Expected: all tests pass including 5 new debounce tests.

- [ ] **Step 5: Commit**

  ```fish
  echo "test(PermissionMonitor): add debounce logic tests

  Extends MockPermissionChecker with sequence-based returns to test the
  two-consecutive-reads debounce that guards against SFSafariExtensionManager
  flickering. Also tests weak-self dealloc path. No production changes.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "Tests/Swift/PermissionMonitorTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 3: AppDelegate — notification routing & lifecycle

### Task 3: Extract `handleNotificationAction` and add tests

**Files:**
- Modify: `ClaudeInSafari/App/AppDelegate.swift:146-161`
- Create: `Tests/Swift/AppDelegateTests.swift`

- [ ] **Step 1: Extract `handleNotificationAction` and widen access**

  In `AppDelegate.swift`, change `toolRouter` from `private` to `internal`:

  ```swift
  // Change this line:
  private var toolRouter: ToolRouter?
  // To:
  var toolRouter: ToolRouter?
  ```

  Add this method after the `userNotificationCenter(_:willPresent:)` method:

  ```swift
  /// Routes a notification action identifier to the appropriate handler.
  /// Extracted from userNotificationCenter(_:didReceive:) for testability.
  func handleNotificationAction(_ identifier: String) {
      if identifier == "stop-automation" {
          if let router = toolRouter {
              router.cancelCurrentRequest()
          } else {
              NSLog("AppDelegate: received stop-automation but toolRouter is nil")
          }
      } else if identifier != UNNotificationDefaultActionIdentifier {
          NSLog("AppDelegate: unhandled notification action identifier '%@'", identifier)
      }
  }
  ```

  Then update `userNotificationCenter(_:didReceive:)` to call it:

  ```swift
  func userNotificationCenter(
      _ center: UNUserNotificationCenter,
      didReceive response: UNNotificationResponse,
      withCompletionHandler completionHandler: @escaping () -> Void
  ) {
      handleNotificationAction(response.actionIdentifier)
      completionHandler()
  }
  ```

- [ ] **Step 2: Create `AppDelegateTests.swift`**

  Create `Tests/Swift/AppDelegateTests.swift`:

  ```swift
  import XCTest
  import UserNotifications
  @testable import ClaudeInSafari

  final class AppDelegateTests: XCTestCase {

      // MARK: - handleNotificationAction

      func testHandleNotificationAction_stopAutomation_callsCancelOnRouter() {
          let delegate = AppDelegate()
          let mockServer = MockMCPSocketServer()
          let router = ToolRouter()
          router.setServer(mockServer)
          delegate.toolRouter = router

          // Should not crash; cancelCurrentRequest logs "cancelling 0 extension request(s)"
          delegate.handleNotificationAction("stop-automation")
      }

      func testHandleNotificationAction_stopAutomation_nilRouter_doesNotCrash() {
          let delegate = AppDelegate()
          delegate.toolRouter = nil
          // Should log but not crash
          delegate.handleNotificationAction("stop-automation")
      }

      func testHandleNotificationAction_defaultAction_isNoOp() {
          let delegate = AppDelegate()
          // Should not crash or log warnings
          delegate.handleNotificationAction(UNNotificationDefaultActionIdentifier)
      }

      func testHandleNotificationAction_unknownAction_isNoOp() {
          let delegate = AppDelegate()
          // Should log but not crash
          delegate.handleNotificationAction("unknown-action-id")
      }

      // MARK: - applicationWillTerminate

      func testApplicationWillTerminate_nilState_doesNotCrash() {
          let delegate = AppDelegate()
          // Call without prior applicationDidFinishLaunching — all properties are nil
          delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
      }
  }
  ```

- [ ] **Step 3: Add `AppDelegateTests.swift` to the Xcode project**

  The test file must be added to the test target in the Xcode project. Check if other test files are auto-discovered or if they need manual project membership.

  ```fish
  # Verify existing test files are picked up — if make test-swift already finds
  # tests in Tests/Swift/ without manual project membership, no action needed.
  make test-swift
  ```

  If the new file isn't found, add it to the Xcode project's test target manually.

- [ ] **Step 4: Run tests**

  ```fish
  make test-swift
  ```

  Expected: all tests pass including 5 new AppDelegate tests.

- [ ] **Step 5: Commit**

  ```fish
  echo "test(AppDelegate): add notification routing and lifecycle tests

  Extracts handleNotificationAction() for testability. Tests stop-automation
  action routing, nil-router safety, default/unknown actions, and terminate
  nil-safety. Widens toolRouter access to internal for test injection.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/App/AppDelegate.swift" "Tests/Swift/AppDelegateTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 4: ToolRouter — zoom region parsing

### Task 4: Extract `parseZoomRegion` and add tests

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift:282-296`
- Modify: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Extract `parseZoomRegion` from `handleScreenshotAction`**

  Add this `internal` method to `ToolRouter`, near `parseResizeDimensions` (around line 533).

  **Note:** The original `[Int]` fast path (`if let ints = raw as? [Int] { return ints }`) does NOT
  check `.count == 4`, while the `[Any]` fallback does. This is a latent bug — a 2-element `[Int]`
  would pass through unchecked. The extracted method adds `.count == 4` on both paths, fixing this
  inconsistency. This is a minor behavior tightening, not a pure extraction.

  ```swift
  /// Parses a zoom region from tool arguments.
  /// Expects `region` key containing a 4-element array of integers [x, y, width, height].
  /// Tolerates JSON numbers arriving as Double or NSNumber (common via native bridge).
  /// Returns nil if `region` is missing, wrong length, or contains non-numeric elements.
  func parseZoomRegion(_ arguments: [String: Any]) -> (x: Int, y: Int, width: Int, height: Int)? {
      guard let raw = arguments["region"] else { return nil }
      if let ints = raw as? [Int], ints.count == 4 {
          return (ints[0], ints[1], ints[2], ints[3])
      }
      if let any = raw as? [Any] {
          let converted = any.compactMap { v -> Int? in
              if let i = v as? Int { return i }
              if let d = v as? Double { return Int(d) }
              if let n = v as? NSNumber { return n.intValue }
              return nil
          }
          if converted.count == 4 { return (converted[0], converted[1], converted[2], converted[3]) }
      }
      return nil
  }
  ```

  Then replace the inline closure in `handleScreenshotAction` (lines 283-296) with:

  ```swift
  // zoom — parse region
  let regionTuple = parseZoomRegion(arguments)
  let region: [Int]? = regionTuple.map { [$0.x, $0.y, $0.width, $0.height] }
  ```

- [ ] **Step 2: Write the 3 tests**

  Add to `ToolRouterTests.swift` before the final `}`:

  ```swift
  // MARK: - parseZoomRegion

  func testParseZoomRegion_validIntArray_returnsTuple() {
      let result = router.parseZoomRegion(["region": [100, 200, 300, 400]])
      XCTAssertNotNil(result)
      XCTAssertEqual(result?.x, 100)
      XCTAssertEqual(result?.y, 200)
      XCTAssertEqual(result?.width, 300)
      XCTAssertEqual(result?.height, 400)
  }

  func testParseZoomRegion_wrongLength_returnsNil() {
      XCTAssertNil(router.parseZoomRegion(["region": [100, 200]]))
  }

  func testParseZoomRegion_nonNumericElements_returnsNil() {
      XCTAssertNil(router.parseZoomRegion(["region": ["a", "b", "c", "d"]]))
  }
  ```

  Also add tests for the NSNumber/Double coercion paths (same pattern as `parseResizeDimensions`):

  ```swift
  func testParseZoomRegion_doubleElements_convertsToInt() {
      let result = router.parseZoomRegion(["region": [100.5, 200.7, 300.0, 400.9]])
      XCTAssertNotNil(result)
      XCTAssertEqual(result?.x, 100)  // truncated
      XCTAssertEqual(result?.y, 200)
      XCTAssertEqual(result?.width, 300)
      XCTAssertEqual(result?.height, 400)
  }

  func testParseZoomRegion_missingRegion_returnsNil() {
      XCTAssertNil(router.parseZoomRegion([:]))
  }
  ```

- [ ] **Step 3: Run tests**

  ```fish
  make test-swift
  ```

  Expected: all tests pass including 5 new `parseZoomRegion` tests.

- [ ] **Step 4: Commit**

  ```fish
  echo "refactor(ToolRouter): extract and test parseZoomRegion

  Extracts zoom region parsing from handleScreenshotAction into a testable
  internal method, matching the pattern of parseResizeDimensions. Adds
  .count==4 guard to the [Int] fast path (was only on the [Any] fallback —
  latent bug). Adds 5 tests covering valid arrays, wrong length, non-numeric
  elements, Double coercion, and missing region.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/MCP/ToolRouter.swift" "Tests/Swift/ToolRouterTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 5: MCPSocketServer — stale socket cleanup

### Task 5: Add socket cleanup tests

**Files:**
- Modify: `Tests/Swift/MCPSocketServerTests.swift`

- [ ] **Step 1: Write the 2 tests**

  Add to `MCPSocketServerTests.swift` before the final `}`:

  ```swift
  // MARK: - Stale socket cleanup

  func testStart_removesExistingSockFilesFromDirectory() throws {
      let username = NSUserName()
      let directory = "/tmp/claude-mcp-browser-bridge-\(username)"

      // Ensure directory exists
      try FileManager.default.createDirectory(
          atPath: directory,
          withIntermediateDirectories: true,
          attributes: nil
      )

      // Create a dummy stale socket file
      let stalePath = "\(directory)/99999.sock"
      FileManager.default.createFile(atPath: stalePath, contents: nil)
      XCTAssertTrue(FileManager.default.fileExists(atPath: stalePath), "Precondition: stale file exists")

      // Start the server — it should clean up stale .sock files
      let server = MCPSocketServer(framer: MessageFramer())
      try server.start()
      defer { server.stop() }

      XCTAssertFalse(FileManager.default.fileExists(atPath: stalePath),
                     "Stale .sock file should be removed on start")
  }

  func testStart_preservesNonSockFilesInDirectory() throws {
      let username = NSUserName()
      let directory = "/tmp/claude-mcp-browser-bridge-\(username)"

      // Ensure directory exists
      try FileManager.default.createDirectory(
          atPath: directory,
          withIntermediateDirectories: true,
          attributes: nil
      )

      // Create a non-.sock file
      let otherPath = "\(directory)/keepme.txt"
      FileManager.default.createFile(atPath: otherPath, contents: Data("hello".utf8))

      let server = MCPSocketServer(framer: MessageFramer())
      try server.start()
      defer { server.stop() }

      XCTAssertTrue(FileManager.default.fileExists(atPath: otherPath),
                    "Non-.sock files should be preserved")

      // Cleanup
      try? FileManager.default.removeItem(atPath: otherPath)
  }
  ```

- [ ] **Step 2: Run tests**

  ```fish
  make test-swift
  ```

  Expected: all tests pass including 2 new socket cleanup tests.

- [ ] **Step 3: Commit**

  ```fish
  echo "test(MCPSocketServer): add stale socket cleanup tests

  Verifies that start() removes existing .sock files from the socket
  directory while preserving non-.sock files. No production changes.

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add "Tests/Swift/MCPSocketServerTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

## Final Verification

- [ ] **Run full test suite**

  ```fish
  make test-swift
  ```

  Expected: all tests pass — existing + 26 new tests.

- [ ] **Update STRUCTURE.md**

  Add `AppDelegateTests.swift` to the test file listing in `STRUCTURE.md` (alphabetically, after `AppleScriptBridgeTests.swift`):

  ```
  │       │   ├── AppDelegateTests.swift
  ```

- [ ] **Commit STRUCTURE.md update**

  ```fish
  echo "docs(structure): add AppDelegateTests.swift to project layout

  Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" > /tmp/commitmsg
  git add STRUCTURE.md
  git commit -F /tmp/commitmsg
  ```

- [ ] **Open the PR**

  ```fish
  git push -u origin test/swift-coverage
  ```

  PR title: `test: full Swift test coverage (Spec 022)`
