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
        XCTExpectFailure("postAutomationNotification not yet wired into handleToolCall — Task 3 will fix this") {
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
            guard !mockCenter.addedRequests.isEmpty else { return }
            XCTAssertTrue(mockCenter.addedRequests[0].content.body.contains("navigate"))
        }
    }

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
}
