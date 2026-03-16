import XCTest
import UserNotifications
import CoreGraphics
@testable import ClaudeInSafari

// MARK: - MockNotificationCenter

private final class MockNotificationCenter: NotificationCenterProtocol {
    private(set) var addedRequests: [UNNotificationRequest] = []
    /// When non-nil, `add` calls the completion handler with this error instead of nil.
    var addError: Error? = nil

    func add(_ request: UNNotificationRequest,
             withCompletionHandler completionHandler: ((Error?) -> Void)? = nil) {
        addedRequests.append(request)
        completionHandler?(addError)
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

    // T_notif4b — categoryIdentifier matches AppDelegate's registered category "claude-automation"
    func testNotificationCategoryIdentifierMatchesRegisteredCategory() {
        router.postAutomationNotification(toolName: "navigate")
        XCTAssertEqual(mockCenter.addedRequests[0].content.categoryIdentifier, "claude-automation",
                       "categoryIdentifier must match the category registered in AppDelegate.requestNotificationAuthorization()")
    }

    // T_notif5 — handleToolCall triggers notification for extension-forwarded call
    // NOTE: In unit tests the App Group is unavailable, so enqueueToolRequest
    // returns false synchronously and sendError is called — no async work is
    // started. postAutomationNotification fires synchronously before that, so
    // the assertion below is safe without any async coordination.
    func testHandleToolCallTriggersNotification() {
        let server = MockMCPSocketServer()
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

    // T_notif6 — missing tool name in tools/call does not post notification
    func testMissingToolNameDoesNotPostNotification() {
        let server = MockMCPSocketServer()
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

    // T_cancel1 — cancelCurrentRequest sends error for any in-flight pending request
    func testCancelCurrentRequest_withInFlightRequest_sendsErrorResponse() {
        let server = MockMCPSocketServer()
        router.setServer(server)

        // Inject a fake in-flight request (simulates a tool waiting for extension response)
        router.injectPendingRequest(requestId: "req-cancel-1", clientId: "client-1", jsonrpcId: 99)

        router.cancelCurrentRequest()

        XCTAssertEqual(server.sentData.count, 1, "Expected exactly one error response to be sent")
        let json = server.lastSentJSON()
        let error = json?["error"] as? [String: Any]
        let message = error?["message"] as? String ?? ""
        XCTAssertTrue(message.contains("Cancelled"), "Expected 'Cancelled' in: \(message)")
        XCTAssertTrue(router.nativeCallCancelled, "nativeCallCancelled should be true after cancelCurrentRequest — flag stays set for any in-flight native handlers")
    }

    // T_cancel2 — cancelCurrentRequest with no in-flight request does nothing
    func testCancelCurrentRequest_noInFlightRequest_doesNotSend() {
        let server = MockMCPSocketServer()
        router.setServer(server)

        router.cancelCurrentRequest()

        // No tool response should be sent — there is nothing to cancel
        XCTAssertTrue(server.sentData.isEmpty)
        XCTAssertTrue(router.nativeCallCancelled, "nativeCallCancelled should be true after cancelCurrentRequest — flag stays set for any in-flight native handlers")
    }

    // T_cancel_native1 — handleToolCall resets a stale nativeCallCancelled flag so it
    // does not poison the next native call. A flag set before dispatch must be cleared
    // by handleToolCall before the screenshot completion handler fires.
    func testCancelledFlag_handleToolCallResetsStaleFlagBeforeScreenshot() {
        class SyncCaptureProvider: ScreenCaptureProvider {
            func checkPermission() -> Bool { true }
            func captureWindow(completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void) {
                let ctx = CGContext(
                    data: nil, width: 10, height: 10,
                    bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )!
                completion(.success((ctx.makeImage()!, 10, 10)))
            }
        }

        let server = MockMCPSocketServer()
        let screenshotSvc = ScreenshotService(captureProvider: SyncCaptureProvider())
        let localRouter = ToolRouter(
            screenshotService: screenshotSvc,
            gifService: GifService(),
            fileService: FileService(),
            notificationCenter: mockCenter
        )
        localRouter.setServer(server)

        // Simulate a stale flag left over from a previous Stop click with no native tool in-flight.
        // handleToolCall must reset it before dispatching the screenshot.
        localRouter.nativeCallCancelled = true

        let message: [String: Any] = [
            "jsonrpc": "2.0", "id": 50,
            "method": "tools/call",
            "params": [
                "name": "computer",
                "arguments": ["action": "screenshot", "tabId": 1]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: message)
        localRouter.socketServer(server, didReceiveMessage: data, from: "client-1")

        // The stale flag is reset at the start of handleToolCall, so the screenshot
        // completes normally (no "Cancelled" error). captureWindow is synchronous here.
        XCTAssertFalse(localRouter.nativeCallCancelled,
                       "handleToolCall must reset nativeCallCancelled before dispatching work")
        let json = server.lastSentJSON()
        let errorMsg = (json?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertFalse(errorMsg.contains("Cancelled"),
                       "Stale flag must not cause a Cancelled error for a fresh tool call: \(errorMsg)")
    }

    // T_cancel_native2 — handleToolCall resets a stale nativeCallCancelled flag so it
    // does not poison the next gif export call. A flag set before dispatch must be
    // cleared by handleToolCall before the gif completion handler fires.
    func testCancelledFlag_handleToolCallResetsStaleFlagBeforeGifExport() {
        let server = MockMCPSocketServer()
        let localRouter = ToolRouter(
            screenshotService: ScreenshotService(),
            gifService: GifService(),
            fileService: FileService(),
            notificationCenter: mockCenter
        )
        localRouter.setServer(server)

        // Simulate a stale flag left over from a previous Stop click with no native tool in-flight.
        // handleToolCall must reset it before dispatching the gif export.
        localRouter.nativeCallCancelled = true

        // gif_creator export dispatches to a global queue; use a semaphore to wait
        // for the response rather than a fixed wall-clock delay (avoids CI flakiness).
        let sem = DispatchSemaphore(value: 0)
        // Observe sentData growth instead of time — signal as soon as the router sends anything.
        let observer = DispatchQueue.global()
        var done = false

        let message: [String: Any] = [
            "jsonrpc": "2.0", "id": 51,
            "method": "tools/call",
            "params": [
                "name": "gif_creator",
                "arguments": ["action": "export", "tabId": 1]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: message)
        localRouter.socketServer(server, didReceiveMessage: data, from: "client-1")

        // Poll until the server has sent a response (export is async but fast in tests).
        observer.async {
            while !done {
                if !server.sentData.isEmpty { done = true; sem.signal() }
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        _ = sem.wait(timeout: .now() + 5)

        // The stale flag was reset by handleToolCall, so no "Cancelled" error is sent.
        // The export may send a different error (no frames, etc.) but not a cancellation error.
        XCTAssertFalse(localRouter.nativeCallCancelled,
                       "handleToolCall must reset nativeCallCancelled before dispatching work")
        let json = server.lastSentJSON()
        let errorMsg = (json?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertFalse(errorMsg.contains("Cancelled"),
                       "Stale flag must not cause a Cancelled error for a fresh gif export: \(errorMsg)")
    }

    // T_cancel_all — cancelCurrentRequest cancels ALL pending requests, not just one
    func testCancelCurrentRequest_multipleInFlightRequests_cancelsAll() {
        let server = MockMCPSocketServer()
        router.setServer(server)

        router.injectPendingRequest(requestId: "req-1", clientId: "client-1", jsonrpcId: 10)
        router.injectPendingRequest(requestId: "req-2", clientId: "client-1", jsonrpcId: 11)

        router.cancelCurrentRequest()

        XCTAssertEqual(server.sentData.count, 2, "cancelCurrentRequest must cancel all pending requests, not just one")
        for data in server.sentData {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let msg = (json?["error"] as? [String: Any])?["message"] as? String ?? ""
            XCTAssertTrue(msg.contains("Cancelled"), "Each pending request must receive a Cancelled error: \(msg)")
        }
    }

    // T_notif_boundary — second call at exactly the debounce boundary (10.0s) is NOT suppressed
    // (the comparison is strict less-than: timeIntervalSince < 10, so 10.0s is not debounced)
    func testDebounce_atExactBoundary_postsAgain() {
        router.postAutomationNotification(toolName: "navigate")
        router.lastNotificationDate = Date().addingTimeInterval(-10)
        router.postAutomationNotification(toolName: "find")
        XCTAssertEqual(mockCenter.addedRequests.count, 2,
                       "A call at exactly 10s should not be debounced (strict less-than comparison)")
    }

    // T_cancel_native3 — handleToolCall resets a stale nativeCallCancelled flag before zoom dispatch
    func testCancelledFlag_handleToolCallResetsStaleFlagBeforeZoom() {
        class SyncCaptureProvider: ScreenCaptureProvider {
            func checkPermission() -> Bool { true }
            func captureWindow(completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void) {
                let ctx = CGContext(
                    data: nil, width: 10, height: 10,
                    bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )!
                completion(.success((ctx.makeImage()!, 10, 10)))
            }
        }

        let server = MockMCPSocketServer()
        let screenshotSvc = ScreenshotService(captureProvider: SyncCaptureProvider())
        let localRouter = ToolRouter(
            screenshotService: screenshotSvc,
            gifService: GifService(),
            fileService: FileService(),
            notificationCenter: mockCenter
        )
        localRouter.setServer(server)
        localRouter.nativeCallCancelled = true

        let message: [String: Any] = [
            "jsonrpc": "2.0", "id": 52,
            "method": "tools/call",
            "params": [
                "name": "computer",
                "arguments": ["action": "zoom", "tabId": 1, "region": [0, 0, 100, 100]]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: message)
        localRouter.socketServer(server, didReceiveMessage: data, from: "client-1")

        XCTAssertFalse(localRouter.nativeCallCancelled,
                       "handleToolCall must reset nativeCallCancelled before dispatching zoom")
        let json = server.lastSentJSON()
        let errorMsg = (json?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertFalse(errorMsg.contains("Cancelled"),
                       "Stale flag must not cause a Cancelled error for a fresh zoom call: \(errorMsg)")
    }

    // T_notif_error1 — postAutomationNotification does not crash and does not retry when add fails
    func testPostAutomationNotification_addError_doesNotCrashOrRetry() {
        mockCenter.addError = NSError(domain: "UNErrorDomain", code: 1,
                                      userInfo: [NSLocalizedDescriptionKey: "Notifications not authorized"])
        router.postAutomationNotification(toolName: "navigate")

        // The request was still submitted (add was called); no retry or second request
        XCTAssertEqual(mockCenter.addedRequests.count, 1,
                       "add should be called exactly once even when it fails")
    }
}

