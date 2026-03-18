// Tests/Swift/OnboardingWindowControllerTests.swift
import XCTest
@testable import ClaudeInSafari

// MARK: - Helpers

/// MockPermissionChecker defined in PermissionMonitorTests.swift is in the same test target,
/// so we can reuse it. If the build system compiles each file independently, we define a local
/// alias below. To avoid redeclaration errors the local type is named distinctly.
private final class OnboardingMockChecker: PermissionChecking {
    var accessibilityGranted = false
    var screenRecordingGranted = false
    var extensionEnabled = false

    func isAccessibilityGranted() -> Bool { accessibilityGranted }
    func isScreenRecordingGranted() -> Bool { screenRecordingGranted }
    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        completion(extensionEnabled)
    }
    func requestAccessibility() {}
}

// MARK: - OnboardingWindowControllerTests

final class OnboardingWindowControllerTests: XCTestCase {

    // All AppKit operations require the main thread.
    // XCTest runs test methods on the main thread by default, so no extra dispatch
    // is needed here, but we use @MainActor annotations where clarity helps.

    // MARK: - T1: showOnboarding(startingAt: nil) makes the window visible

    /// Verifies that calling showOnboarding(startingAt: nil) orders the window front.
    /// currentScreen is private, so we verify the observable side effect: the window
    /// is key and ordered front (i.e., isVisible == true).
    func testShowOnboarding_nil_makesWindowVisible() {
        let checker = OnboardingMockChecker()
        let monitor = PermissionMonitor(checker: checker)
        let controller = OnboardingWindowController(monitor: monitor)

        XCTAssertFalse(controller.window?.isVisible ?? true,
                       "Window should start hidden before showOnboarding is called")

        controller.showOnboarding(startingAt: nil)

        XCTAssertTrue(controller.window?.isVisible ?? false,
                      "Window must be visible after showOnboarding(startingAt: nil)")

        // Clean up: close without triggering onDismiss cascade.
        controller.window?.orderOut(nil)
    }

    // MARK: - T2: showOnboarding(startingAt: .safariExtension) makes the window visible

    /// Verifies that passing a specific OnboardingStep still shows the window.
    /// Since OnboardingScreen is private we cannot inspect currentScreen directly;
    /// we confirm the window is presented and does not crash.
    func testShowOnboarding_withStep_makesWindowVisible() {
        let checker = OnboardingMockChecker()
        let monitor = PermissionMonitor(checker: checker)
        let controller = OnboardingWindowController(monitor: monitor)

        controller.showOnboarding(startingAt: .safariExtension)

        XCTAssertTrue(controller.window?.isVisible ?? false,
                      "Window must be visible after showOnboarding(startingAt: .safariExtension)")

        controller.window?.orderOut(nil)
    }

    // MARK: - T3: dismiss is idempotent — onDismiss fires exactly once

    /// Simulates two dismiss paths firing: the Done button action and the
    /// windowWillClose notification. Verifies onDismiss is called exactly once.
    func testDismiss_idempotent_onDismissFiredOnce() {
        let checker = OnboardingMockChecker()
        let monitor = PermissionMonitor(checker: checker)
        let controller = OnboardingWindowController(monitor: monitor)

        var dismissCount = 0
        controller.onDismiss = { dismissCount += 1 }

        controller.showOnboarding(startingAt: nil)

        // Advance to the done screen via manualAdvance (which calls advance() three times):
        // welcome → safariExtension → screenRecording → accessibility → done
        // Then doneTapped() calls dismiss().
        controller.perform(NSSelectorFromString("manualAdvance"))  // welcome → safariExtension
        controller.perform(NSSelectorFromString("manualAdvance"))  // safariExtension → screenRecording
        controller.perform(NSSelectorFromString("manualAdvance"))  // screenRecording → accessibility
        controller.perform(NSSelectorFromString("manualAdvance"))  // accessibility → done
        controller.perform(NSSelectorFromString("doneTapped"))      // done → dismiss()

        // Now post willClose, which would double-fire if dismissed flag is not set.
        if let window = controller.window {
            NotificationCenter.default.post(
                name: NSWindow.willCloseNotification,
                object: window
            )
        }

        XCTAssertEqual(dismissCount, 1,
                       "onDismiss must fire exactly once regardless of how many dismiss paths are triggered")
    }

    // MARK: - T4: windowWillClose after normal dismiss does not double-fire onDismiss

    /// The later-tapped path (which calls dismiss() directly via laterTapped)
    /// sets the dismissed flag. A subsequent windowWillClose must be a no-op.
    func testWindowWillClose_doesNotDouble_fireOnDismiss() {
        let checker = OnboardingMockChecker()
        let monitor = PermissionMonitor(checker: checker)
        let controller = OnboardingWindowController(monitor: monitor)

        var dismissCount = 0
        controller.onDismiss = { dismissCount += 1 }

        controller.showOnboarding(startingAt: nil)

        // "I'll set this up later" button calls dismiss() via laterTapped.
        controller.perform(NSSelectorFromString("laterTapped"))

        // Simulate the window closing event (which fires from close() inside dismiss(),
        // but also could fire again from external close).
        if let window = controller.window {
            NotificationCenter.default.post(
                name: NSWindow.willCloseNotification,
                object: window
            )
        }

        XCTAssertEqual(dismissCount, 1,
                       "windowWillClose after laterTapped must not fire onDismiss a second time")
    }

    // MARK: - T5: advance() from safariExtension goes to screenRecording (via polling)

    /// When the checker reports extensionEnabled = true, the polling timer fires
    /// checkStepCompletion which calls advance(). We verify the side effect: the
    /// window content view changes (a new view is installed for the next step).
    /// Since the polling interval is 0.5 s we use an expectation with a generous timeout.
    func testAdvance_fromSafariExtension_goesToScreenRecording() {
        let checker = OnboardingMockChecker()
        // Extension is enabled so the first poll should auto-advance.
        checker.extensionEnabled = true
        checker.screenRecordingGranted = false
        checker.accessibilityGranted = false
        let monitor = PermissionMonitor(checker: checker)
        let controller = OnboardingWindowController(monitor: monitor)

        controller.showOnboarding(startingAt: .safariExtension)

        // Capture the initial content view installed for safariExtension step.
        let initialContentView = controller.window?.contentView

        // Wait up to 2 s for the polling timer to fire and advance to the next screen.
        let exp = expectation(description: "advance from safariExtension to screenRecording")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) {
            let newContentView = controller.window?.contentView
            // The content view should have been replaced when the screen changed.
            XCTAssertFalse(newContentView === initialContentView,
                           "Content view must change after auto-advance from safariExtension step")
            exp.fulfill()
        }
        waitForExpectations(timeout: 3)

        // Clean up open window.
        controller.window?.orderOut(nil)
    }
}
