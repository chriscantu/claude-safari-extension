# Agent Visual Indicator PR B — Native Notifications Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add macOS Notification Center integration — post debounced automation notifications and wire a "Stop Claude" action to cancel in-flight tool calls from both the extension and native handlers.

**Architecture:** A `NotificationCenterProtocol` wrapper makes `ToolRouter`'s notification posting unit-testable via injection. `AppDelegate` owns `UNUserNotificationCenterDelegate` conformance (avoids making `ToolRouter` `@objc`) and calls `ToolRouter.cancelCurrentRequest()` when the "stop-automation" action fires. Native tool cancellation (screenshot, gif_creator, resize_window) uses a `nativeCallCancelled` flag checked in each async completion handler — best-effort, no interruption of in-flight ScreenCaptureKit captures.

**Tech Stack:** Swift / XCTest, `UserNotifications` framework

**Spec:** `docs/specs/020-agent-visual-indicator.md` (§ macOS Notification Center Integration)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `ClaudeInSafari/App/AppDelegate.swift` | Modify | `requestAuthorization`, `UNNotificationCategory` + action registration, `UNUserNotificationCenterDelegate` conformance, forward Stop action to `ToolRouter` |
| `ClaudeInSafari/MCP/ToolRouter.swift` | Modify | `NotificationCenterProtocol`, `notificationCenter` injection, `lastNotificationDate`, `postAutomationNotification`, `nativeCallCancelled`, `cancelCurrentRequest()`, `injectPendingRequest` test hook, cancellation guards in native completion handlers |
| `Tests/Swift/ToolRouterNotificationTests.swift` | Create | TDD: T_notif1–T_notif5, T_cancel1–T_cancel2 |

---

## Chunk 1: Notification Infrastructure

### Task 1: Create feature branch

- [ ] **Create branch and verify clean state**

  ```fish
  git checkout -b feature/020-indicator-pr-b
  git status
  ```

  Expected: `On branch feature/020-indicator-pr-b`, clean working tree.

---

### Task 2: `NotificationCenterProtocol` + `ToolRouter` injection (TDD)

**Files:**
- Create: `Tests/Swift/ToolRouterNotificationTests.swift`
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift`

- [ ] **Create `Tests/Swift/ToolRouterNotificationTests.swift`**

  ```swift
  import XCTest
  import UserNotifications
  @testable import ClaudeInSafari

  // MARK: - MockNotificationCenter

  final class MockNotificationCenter: NotificationCenterProtocol {
      private(set) var addedRequests: [UNNotificationRequest] = []

      func add(_ request: UNNotificationRequest,
               withCompletionHandler completionHandler: ((Error?) -> Void)? = nil) {
          addedRequests.append(request)
          completionHandler?(nil)
      }
  }

  // MARK: - Local server mock
  // MockMCPSocketServer in ToolRouterTests.swift is `private` — redefine here.

  private class NotifTestMockServer: MCPSocketServer {
      init() { super.init(framer: MessageFramer()) }
      private(set) var sentData: [Data] = []
      override func send(data: Data, to clientId: String) { sentData.append(data) }
      func lastSentJSON() -> [String: Any]? {
          guard let last = sentData.last else { return nil }
          return try? JSONSerialization.jsonObject(with: last) as? [String: Any]
      }
  }

  // MARK: - ToolRouterNotificationTests

  final class ToolRouterNotificationTests: XCTestCase {

      private var mockCenter: MockNotificationCenter!
      private var router: ToolRouter!

      override func setUp() {
          super.setUp()
          mockCenter = MockNotificationCenter()
          router = ToolRouter(
              screenshotService: ScreenshotService(),
              gifService: GifService(),
              fileService: FileService(),
              notificationCenter: mockCenter
          )
      }

      // T_notif1 — first call posts notification with correct title/body
      func testFirstToolCallPostsNotification() {
          router.postAutomationNotification(toolName: "navigate")
          XCTAssertEqual(mockCenter.addedRequests.count, 1)
          let content = mockCenter.addedRequests[0].content
          XCTAssertEqual(content.title, "Claude is automating Safari")
          XCTAssertTrue(content.body.contains("navigate"))
      }

      // T_notif2 — second call within 10s is debounced (no second notification)
      func testSecondCallWithin10sIsDebounced() {
          router.postAutomationNotification(toolName: "navigate")
          router.postAutomationNotification(toolName: "find")
          XCTAssertEqual(mockCenter.addedRequests.count, 1)
      }

      // T_notif3 — second call after 10s posts again (debounce expired)
      func testSecondCallAfter10sPostsAgain() {
          router.postAutomationNotification(toolName: "navigate")
          router.lastNotificationDate = Date().addingTimeInterval(-11)
          router.postAutomationNotification(toolName: "find")
          XCTAssertEqual(mockCenter.addedRequests.count, 2)
      }

      // T_notif4 — stable identifier so notifications replace (not stack)
      func testNotificationUsesStableIdentifier() {
          router.postAutomationNotification(toolName: "navigate")
          XCTAssertEqual(mockCenter.addedRequests[0].identifier, "claude-automation-active")
      }

      // T_notif5 — handleToolCall triggers notification for extension-forwarded call
      // NOTE: In unit tests the App Group is unavailable, so enqueueToolRequest
      // returns false synchronously and sendError is called — no async work is
      // started. postAutomationNotification fires synchronously before that, so
      // the assertion below is safe without any async coordination.
      func testHandleToolCallTriggersNotification() {
          let server = NotifTestMockServer()
          router.setServer(server)

          let message: [String: Any] = [
              "jsonrpc": "2.0", "id": 1,
              "method": "tools/call",
              "params": [
                  "name": "navigate",
                  "arguments": ["url": "https://example.com", "tabId": 1]
              ]
          ]
          let data = try! JSONSerialization.data(withJSONObject: message)
          router.socketServer(server, didReceiveMessage: data, from: "client-1")

          XCTAssertEqual(mockCenter.addedRequests.count, 1)
          XCTAssertTrue(mockCenter.addedRequests[0].content.body.contains("navigate"))
      }
  }
  ```

- [ ] **Run tests to confirm they fail**

  ```fish
  make test-swift 2>&1 | tail -20
  ```

  Expected: FAIL — `NotificationCenterProtocol` not found, `postAutomationNotification` not found, testable init signature mismatch.

- [ ] **Add `import UserNotifications` + `NotificationCenterProtocol` to `ToolRouter.swift`**

  At the very top of `ClaudeInSafari/MCP/ToolRouter.swift`, add `import UserNotifications` after `import Foundation`:

  ```swift
  import Foundation
  import UserNotifications
  ```

  Then add the protocol immediately before `class ToolRouter`:

  ```swift
  /// Abstraction over UNUserNotificationCenter for notification posting.
  /// Enables injection of a mock in unit tests without hitting the real system.
  protocol NotificationCenterProtocol: AnyObject {
      func add(_ request: UNNotificationRequest, withCompletionHandler completionHandler: ((Error?) -> Void)?)
  }

  extension UNUserNotificationCenter: NotificationCenterProtocol {}
  ```

- [ ] **Add `notificationCenter` property to `ToolRouter`**

  In `ToolRouter`, after `private let fileService: FileService`, add:

  ```swift
  private let notificationCenter: NotificationCenterProtocol
  ```

- [ ] **Update the testable `init` to accept a `notificationCenter` parameter**

  Replace the existing testable `init` (currently: `init(screenshotService:gifService:fileService:)`) with:

  ```swift
  // Testable init — inject mock services and notification center for unit tests
  init(screenshotService: ScreenshotService, gifService: GifService, fileService: FileService,
       notificationCenter: NotificationCenterProtocol = UNUserNotificationCenter.current()) {
      self.screenshotService = screenshotService
      self.gifService = gifService
      self.fileService = fileService
      self.notificationCenter = notificationCenter
  }
  ```

  The `convenience init()` delegates to this and requires no changes.

- [ ] **Add `lastNotificationDate` state variable to `ToolRouter`**

  After the `pendingRequestsLock` declaration, add:

  ```swift
  // MARK: - Notification state
  /// Date of the last automation notification. Internal for testability (manipulated in tests).
  var lastNotificationDate: Date? = nil
  ```

- [ ] **Add `postAutomationNotification` to `ToolRouter`**

  Add a new `// MARK: - Notifications` section immediately before `// MARK: - MCPSocketServerDelegate`:

  ```swift
  // MARK: - Notifications

  /// Post a macOS Notification Center alert announcing that automation is active.
  /// Debounced: silently skipped if a notification was posted in the last 10 seconds
  /// so rapid back-to-back tool calls only show one notification per sequence.
  /// Internal for testability (called from handleToolCall).
  func postAutomationNotification(toolName: String) {
      if let last = lastNotificationDate, Date().timeIntervalSince(last) < 10 {
          return // debounce: within the 10-second window
      }
      lastNotificationDate = Date()

      let content = UNMutableNotificationContent()
      content.title = "Claude is automating Safari"
      content.body = "Running: \(toolName)"
      content.sound = nil
      content.categoryIdentifier = "claude-automation"

      let request = UNNotificationRequest(
          identifier: "claude-automation-active", // stable: replaces previous notification
          content: content,
          trigger: nil  // deliver immediately
      )
      notificationCenter.add(request, withCompletionHandler: nil)
  }
  ```

  Also add the optional T_notif6 edge-case test (covers the `guard let toolName` early-exit path):

  ```swift
  // T_notif6 — missing tool name in tools/call does not post notification
  func testMissingToolNameDoesNotPostNotification() {
      let server = NotifTestMockServer()
      router.setServer(server)

      // tools/call with no "name" key — handleToolCall returns after guard, before
      // postAutomationNotification is reached.
      let message: [String: Any] = [
          "jsonrpc": "2.0", "id": 1,
          "method": "tools/call",
          "params": ["arguments": [:]]  // no "name"
      ]
      let data = try! JSONSerialization.data(withJSONObject: message)
      router.socketServer(server, didReceiveMessage: data, from: "client-1")

      XCTAssertEqual(mockCenter.addedRequests.count, 0,
                     "No notification should be posted when tool name is missing")
  }
  ```

- [ ] **Run tests — T_notif1–T_notif4 and T_notif6 pass; T_notif5 still fails (not wired yet)**

  ```fish
  make test-swift 2>&1 | tail -20
  ```

- [ ] **Commit**

  ```fish
  echo "feat(notifications): NotificationCenterProtocol + postAutomationNotification + debounce (T_notif1-4)

  Wraps UNUserNotificationCenter behind a protocol for unit-test injection.
  Debounced to 10s so rapid tool calls only post one notification per sequence.
  Stable identifier 'claude-automation-active' replaces instead of stacking.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/MCP/ToolRouter.swift" "Tests/Swift/ToolRouterNotificationTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

### Task 3: Wire `postAutomationNotification` into `handleToolCall` (TDD)

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift`

- [ ] **Run T_notif5 to confirm it currently fails**

  ```fish
  make test-swift 2>&1 | grep "testHandleToolCall"
  ```

  Expected: FAIL — notification count is 0.

- [ ] **Add `postAutomationNotification` call at the top of `handleToolCall`**

  In `handleToolCall`, after the `guard let toolName` line and `let arguments` line, add:

  ```swift
  // Post automation notification (debounced 10s; fire-and-forget — never blocks tool execution)
  postAutomationNotification(toolName: toolName)
  ```

  The method should now read:

  ```swift
  private func handleToolCall(id: Any?, params: [String: Any]?, clientId: String) {
      guard let toolName = params?["name"] as? String else {
          sendError(id: id, code: -32602, message: "Missing tool name in tools/call", to: clientId)
          return
      }

      let arguments = (params?["arguments"] as? [String: Any]) ?? [:]

      // Post automation notification (debounced 10s; fire-and-forget — never blocks tool execution)
      postAutomationNotification(toolName: toolName)

      if toolName == "computer",
      // ... rest of dispatch unchanged
  ```

- [ ] **Run tests — T_notif1–T_notif6 all pass**

  ```fish
  make test-swift 2>&1 | tail -20
  ```

- [ ] **Commit**

  ```fish
  echo "feat(notifications): wire postAutomationNotification into handleToolCall (T_notif5-6)

  Fires once at the start of each automation sequence (debounced). Non-critical:
  never blocks tool execution regardless of notification system state.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/MCP/ToolRouter.swift"
  git commit -F /tmp/commitmsg
  ```

> **Deferred:** The spec also lists "automation error" notifications (post when a tool call fails with a user-visible error). Implementing this requires hooking `failPendingRequest` and the error branch of `deliverExtensionResponse`. Left for a follow-up PR to keep this one focused.

---

## Chunk 2: AppDelegate Wiring + Stop Action + Native Cancellation

### Task 4: AppDelegate — authorization, category, delegate conformance

**Files:**
- Modify: `ClaudeInSafari/App/AppDelegate.swift`

Authorization and delegate wiring require a running app — no automated test is written for these. Verification is manual in Task 6.

- [ ] **Replace `AppDelegate.swift`**

  ```swift
  import Cocoa
  import UserNotifications

  class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
      private var mcpServer: MCPSocketServer?
      private var toolRouter: ToolRouter?

      func applicationDidFinishLaunching(_ notification: Notification) {
          requestNotificationAuthorization()
          startMCPServer()
      }

      func applicationWillTerminate(_ notification: Notification) {
          mcpServer?.stop()
      }

      // MARK: - Notification Authorization + Category

      private func requestNotificationAuthorization() {
          let center = UNUserNotificationCenter.current()
          center.delegate = self
          center.requestAuthorization(options: [.alert, .sound]) { _, error in
              if let error = error {
                  NSLog("Notification authorization error: \(error.localizedDescription)")
              }
          }

          let stopAction = UNNotificationAction(
              identifier: "stop-automation",
              title: "Stop Claude",
              options: .destructive
          )
          let category = UNNotificationCategory(
              identifier: "claude-automation",
              actions: [stopAction],
              intentIdentifiers: [],
              options: []
          )
          center.setNotificationCategories([category])
      }

      // MARK: - UNUserNotificationCenterDelegate

      /// Called when the user taps a notification action (e.g. "Stop Claude").
      func userNotificationCenter(
          _ center: UNUserNotificationCenter,
          didReceive response: UNNotificationResponse,
          withCompletionHandler completionHandler: @escaping () -> Void
      ) {
          if response.actionIdentifier == "stop-automation" {
              toolRouter?.cancelCurrentRequest()
          }
          completionHandler()
      }

      /// Show notification banners even when the app is in the foreground.
      func userNotificationCenter(
          _ center: UNUserNotificationCenter,
          willPresent notification: UNNotification,
          withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
      ) {
          completionHandler([.banner])
      }

      // MARK: - MCP Server

      private func startMCPServer() {
          let framer = MessageFramer()
          mcpServer = MCPSocketServer(framer: framer)
          toolRouter = ToolRouter()

          mcpServer?.delegate = toolRouter
          if let server = mcpServer {
              toolRouter?.setServer(server)
          }

          do {
              try mcpServer?.start()
              NSLog("MCP Socket Server started at: \(mcpServer?.socketPath ?? "unknown")")
          } catch {
              NSLog("Failed to start MCP Socket Server: \(error)")
              let alert = NSAlert()
              alert.messageText = "Claude in Safari: MCP Server Failed to Start"
              alert.informativeText = "Could not start the MCP socket server:\n\(error.localizedDescription)\n\nThe extension will not function. Check Console for details."
              alert.alertStyle = .critical
              alert.runModal()
              NSApplication.shared.terminate(nil)
          }
      }
  }
  ```

- [ ] **Build to verify AppDelegate compiles cleanly**

  ```fish
  make build 2>&1 | tail -10
  ```

  Expected: `BUILD SUCCEEDED`. If `cancelCurrentRequest` is not yet defined on `ToolRouter`, the build will fail — proceed to Task 5 immediately.

- [ ] **Commit**

  ```fish
  echo "feat(notifications): AppDelegate — requestAuthorization + UNNotificationCategory + UNUserNotificationCenterDelegate

  Registers 'stop-automation' action so users can stop automation from
  Notification Center. Forwards action to ToolRouter.cancelCurrentRequest().

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/App/AppDelegate.swift"
  git commit -F /tmp/commitmsg
  ```

---

### Task 5: `cancelCurrentRequest()` + native tool cancellation flag (TDD)

**Files:**
- Modify: `Tests/Swift/ToolRouterNotificationTests.swift` — add T_cancel1, T_cancel2
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift` — add `nativeCallCancelled`, `injectPendingRequest`, `cancelCurrentRequest()`, cancellation guards

- [ ] **Add T_cancel1 and T_cancel2 to `ToolRouterNotificationTests.swift`**

  Append inside the `ToolRouterNotificationTests` class, after T_notif5:

  ```swift
  // T_cancel1 — cancelCurrentRequest sends error for any in-flight pending request
  func testCancelCurrentRequest_withInFlightRequest_sendsErrorResponse() {
      let server = NotifTestMockServer()
      router.setServer(server)

      // Inject a fake in-flight request (simulates a tool waiting for extension response)
      router.injectPendingRequest(requestId: "req-cancel-1", clientId: "client-1", jsonrpcId: 99)

      router.cancelCurrentRequest()

      XCTAssertFalse(server.sentData.isEmpty, "Expected an error response to be sent")
      let json = server.lastSentJSON()
      let error = json?["error"] as? [String: Any]
      let message = error?["message"] as? String ?? ""
      XCTAssertTrue(message.contains("Cancelled"), "Expected 'Cancelled' in: \(message)")
  }

  // T_cancel2 — cancelCurrentRequest with no in-flight request does nothing
  func testCancelCurrentRequest_noInFlightRequest_doesNotSend() {
      let server = NotifTestMockServer()
      router.setServer(server)

      router.cancelCurrentRequest()

      // No tool response should be sent — there is nothing to cancel
      XCTAssertTrue(server.sentData.isEmpty)
  }
  ```

- [ ] **Run tests to confirm they fail**

  ```fish
  make test-swift 2>&1 | grep "T_cancel\|testCancel"
  ```

  Expected: FAIL — `cancelCurrentRequest` not found, `injectPendingRequest` not found.

- [ ] **Add `nativeCallCancelled` state variable to `ToolRouter`**

  After `var lastNotificationDate: Date? = nil`, add:

  ```swift
  /// Set when a Stop action fires while a native tool is in-flight.
  /// Completion handlers check this flag and send an error response instead of the result.
  /// Best-effort: a race between flag set and completion-handler read is acceptable —
  /// worst case is the result is delivered instead of an error (PR A behavior).
  /// Reset to false at the end of cancelCurrentRequest() to prevent a sticky-true state
  /// when no native tool was in-flight at the time Stop was clicked.
  /// Internal for testability.
  var nativeCallCancelled = false
  ```

- [ ] **Add `injectPendingRequest` test hook to `ToolRouter`**

  In `// MARK: - Extension Forwarding`, after `setServer`, add:

  ```swift
  /// Test hook — injects a pending request entry so cancelCurrentRequest can be
  /// tested without standing up a real extension IPC channel.
  /// Internal (not private) for @testable access; has no effect in production.
  func injectPendingRequest(requestId: String, clientId: String, jsonrpcId: Any?) {
      pendingRequestsLock.lock()
      pendingRequests[requestId] = (clientId: clientId, jsonrpcId: jsonrpcId)
      pendingRequestsLock.unlock()
  }
  ```

- [ ] **Add `cancelCurrentRequest()` to the `// MARK: - Notifications` section**

  ```swift
  /// Cancel all in-flight requests — called by AppDelegate when the "Stop Claude"
  /// notification action fires.
  /// • Extension-forwarded calls: immediately fails all entries in `pendingRequests`
  ///   with a "Cancelled by user" error response.
  /// • Native calls (screenshot, gif, resize_window): sets `nativeCallCancelled` so
  ///   each completion handler sends an error instead of the result (best-effort).
  ///   The flag is reset to false after the loop so a Stop click with no in-flight
  ///   native tool does not poison the next call.
  func cancelCurrentRequest() {
      nativeCallCancelled = true

      pendingRequestsLock.lock()
      let toCancel = Array(pendingRequests.keys)
      pendingRequestsLock.unlock()

      for requestId in toCancel {
          failPendingRequest(requestId: requestId, message: "Cancelled by user")
      }

      // Reset: prevents sticky-true when no native tool was in-flight.
      // If a native completion handler fires after this reset, it sees false and
      // delivers the result — acceptable best-effort behaviour.
      nativeCallCancelled = false
  }
  ```

- [ ] **Run T_cancel1–T_cancel2 — both pass**

  ```fish
  make test-swift 2>&1 | tail -20
  ```

- [ ] **Add cancellation guard to `handleScreenshotAction` — screenshot branch**

  In the `captureScreenshot` callback, add a guard after `guard let self else { return }`:

  ```swift
  screenshotService.captureScreenshot(tabId: tabIdOpt) { [weak self] result in
      guard let self else { return }
      guard !self.nativeCallCancelled else {
          self.nativeCallCancelled = false
          self.sendError(id: id, code: -32000, message: "Cancelled by user", to: clientId)
          return
      }
      sendScreenshotResult(result, id: id, to: clientId)
      if case .success(_) = result {
          maybeAddGifFrame(tabId: tabId, action: "screenshot", coordinate: nil)
      }
  }
  ```

- [ ] **Add cancellation guard to `handleScreenshotAction` — zoom branch**

  ```swift
  screenshotService.captureZoom(tabId: tabIdOpt, region: region) { [weak self] result in
      guard let self else { return }
      guard !self.nativeCallCancelled else {
          self.nativeCallCancelled = false
          self.sendError(id: id, code: -32000, message: "Cancelled by user", to: clientId)
          return
      }
      sendScreenshotResult(result, region: region, id: id, to: clientId)
      if case .success(_) = result {
          maybeAddGifFrame(tabId: tabId, action: "zoom", coordinate: nil)
      }
  }
  ```

- [ ] **Add cancellation guard to `handleGifExport`**

  In the `DispatchQueue.global` block, after `guard let self else { ... return }`, add:

  ```swift
  guard !self.nativeCallCancelled else {
      self.nativeCallCancelled = false
      self.sendError(id: id, code: -32000, message: "Cancelled by user", to: clientId)
      return
  }
  switch self.gifService.exportGIF(tabId: tabId, options: options) {
  // ... rest unchanged
  ```

- [ ] **Add cancellation guard to `handleResizeWindow`**

  In the `resizeWindow` callback, after `guard let self else { return }`:

  ```swift
  appleScriptBridge.resizeWindow(width: Int(w), height: Int(h)) { [weak self] result in
      guard let self else { return }
      guard !self.nativeCallCancelled else {
          self.nativeCallCancelled = false
          self.sendError(id: id, code: -32000, message: "Cancelled by user", to: clientId)
          return
      }
      switch result {
      // ... rest unchanged
  ```

- [ ] **Run the full Swift test suite — all tests pass**

  ```fish
  make test-swift 2>&1 | tail -20
  ```

  Expected: all prior tests + T_notif1–T_notif5 + T_cancel1–T_cancel2 PASS.

- [ ] **Commit**

  ```fish
  echo "feat(notifications): cancelCurrentRequest() + native tool cancellation guards (T_cancel1-2)

  cancelCurrentRequest() is invoked by AppDelegate on 'stop-automation' action.
  Immediately fails all pending extension-forwarded requests. Sets nativeCallCancelled
  for best-effort cancellation of screenshot, gif_creator, and resize_window.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/MCP/ToolRouter.swift" "Tests/Swift/ToolRouterNotificationTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

### Task 6: Final Verification + PR

- [ ] **Run full Swift test suite**

  ```fish
  make test-swift 2>&1 | tail -20
  ```

  Expected: all tests pass (prior tests + T_notif1–T_notif5 + T_cancel1–T_cancel2 = 7 new tests).

- [ ] **Run JS test suite — no regressions**

  ```fish
  npm test 2>&1 | tail -10
  ```

  Expected: all existing JS tests pass. No JS files were changed.

- [ ] **Build cleanly**

  ```fish
  make build 2>&1 | tail -5
  ```

  Expected: `BUILD SUCCEEDED`.

- [ ] **Manual smoke test — notification appears**

  ```fish
  make dev
  ```

  Then from another terminal:

  ```fish
  make send TOOL=navigate ARGS='{"url":"https://example.com","tabId":1}'
  ```

  Expected: macOS notification "Claude is automating Safari / Running: navigate" appears.
  If no notification: open System Settings → Notifications → ClaudeInSafari and grant permission, then retry.

- [ ] **Manual smoke test — debounce**

  Send a second `navigate` call within 10 seconds. Expected: no second notification.
  Wait 11 seconds, send again. Expected: notification appears.

- [ ] **Manual smoke test — Stop action**

  Click "Stop Claude" in the notification banner (while a tool call is in-flight if possible, or after).
  Expected: no crash; `cancelCurrentRequest()` fires; any pending tool call returns a Cancelled error to the CLI.

- [ ] **Update ROADMAP.md**

  In `ROADMAP.md`, update the Phase 7 `agent-visual-indicator` refinement row from `📋` to `✅`:

  ```markdown
  | `agent-visual-indicator` refinement ([020](docs/specs/020-agent-visual-indicator.md)) | ✅ |
  ```

- [ ] **Commit ROADMAP update**

  ```fish
  echo "docs(roadmap): mark agent-visual-indicator refinement complete (Spec 020 PR B)

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add ROADMAP.md
  git commit -F /tmp/commitmsg
  ```

- [ ] **Push and open PR**

  ```fish
  git push -u origin feature/020-indicator-pr-b
  ```

  Then open PR with title:
  `feat(indicator): macOS notification integration (Spec 020, PR B)`

  Body summary:
  - Adds `postAutomationNotification` to `ToolRouter` — debounced (10s), stable identifier so notifications replace rather than stack
  - "Stop Claude" notification action wired to `cancelCurrentRequest()` via `AppDelegate` `UNUserNotificationCenterDelegate`
  - Best-effort cancellation for native tools (screenshot, gif_creator, resize_window) via `nativeCallCancelled` flag
  - `NotificationCenterProtocol` wrapper enables unit testing without the real system
  - 8 new Swift tests (T_notif1–T_notif6, T_cancel1–T_cancel2); all prior tests continue to pass

  Test plan:
  - `make test-swift` — all tests pass
  - `make build` — BUILD SUCCEEDED
  - Send a `navigate` tool call — verify notification appears
  - Send a second within 10s — verify no duplicate notification
  - Click "Stop Claude" in notification banner — verify no crash
