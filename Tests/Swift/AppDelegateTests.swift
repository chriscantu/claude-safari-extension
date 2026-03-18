import XCTest
import UserNotifications
@testable import ClaudeInSafari

final class AppDelegateTests: XCTestCase {

    // MARK: - handleNotificationAction

    func testHandleNotificationAction_stopAutomation_withRouter_doesNotCrash() {
        let delegate = AppDelegate()
        let mockServer = MockMCPSocketServer()
        let router = ToolRouter()
        router.setServer(mockServer)
        delegate.toolRouter = router

        // Exercises the stop-automation → cancelCurrentRequest path with a live router
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
