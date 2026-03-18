// Tests/Swift/OnboardingWindowControllerTests.swift
import XCTest
@testable import ClaudeInSafari

// MARK: - Helpers

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

/// Creates a controller with a mock checker (all permissions denied by default).
/// Caller is responsible for closing the window via `controller.window?.orderOut(nil)`.
private func makeController() -> (OnboardingWindowController, OnboardingMockChecker) {
    let checker = OnboardingMockChecker()
    let monitor = PermissionMonitor(checker: checker)
    let controller = OnboardingWindowController(monitor: monitor)
    return (controller, checker)
}

// MARK: - OnboardingWindowControllerTests

final class OnboardingWindowControllerTests: XCTestCase {

    // MARK: - T1: Initial state is .welcome

    func testInitialState_isWelcome() {
        let (controller, _) = makeController()
        XCTAssertEqual(controller.currentScreen, .welcome)
    }

    // MARK: - T2: advance() follows the full navigation sequence

    func testAdvance_followsCorrectSequence() {
        let (controller, _) = makeController()
        controller.showOnboarding(startingAt: nil)

        XCTAssertEqual(controller.currentScreen, .welcome)

        controller.advance()
        XCTAssertEqual(controller.currentScreen, .step(.safariExtension))

        controller.advance()
        XCTAssertEqual(controller.currentScreen, .step(.screenRecording))

        controller.advance()
        XCTAssertEqual(controller.currentScreen, .step(.accessibility))

        controller.advance()
        XCTAssertEqual(controller.currentScreen, .done)

        controller.window?.orderOut(nil)
    }

    // MARK: - T3: advance() from .done calls dismiss()

    func testAdvance_fromDone_dismisses() {
        let (controller, _) = makeController()
        var dismissFired = false
        controller.onDismiss = { dismissFired = true }

        controller.showOnboarding(startingAt: nil)

        // Navigate to .done: welcome → safari → screenRecording → accessibility → done (4 advances)
        for _ in 0..<4 { controller.advance() }
        XCTAssertEqual(controller.currentScreen, .done)
        XCTAssertFalse(dismissFired, "onDismiss should not fire until advance from .done")

        // One more advance triggers dismiss
        controller.advance()
        XCTAssertTrue(controller.dismissed)
        XCTAssertTrue(dismissFired)
    }

    // MARK: - T4: showOnboarding(startingAt:) jumps to the correct step

    func testShowOnboarding_startingAtStep_jumpsDirectly() {
        let (controller, _) = makeController()

        controller.showOnboarding(startingAt: .screenRecording)
        XCTAssertEqual(controller.currentScreen, .step(.screenRecording))

        controller.window?.orderOut(nil)
    }

    // MARK: - T5: showOnboarding(startingAt: nil) opens to welcome

    func testShowOnboarding_nil_opensToWelcome() {
        let (controller, _) = makeController()

        controller.showOnboarding(startingAt: nil)

        XCTAssertEqual(controller.currentScreen, .welcome)
        XCTAssertTrue(controller.window?.isVisible ?? false)

        controller.window?.orderOut(nil)
    }

    // MARK: - T6: dismiss() fires onDismiss exactly once (idempotent)

    func testDismiss_idempotent() {
        let (controller, _) = makeController()
        var dismissCount = 0
        controller.onDismiss = { dismissCount += 1 }

        controller.showOnboarding(startingAt: nil)

        controller.dismiss()
        controller.dismiss()
        controller.dismiss()

        XCTAssertEqual(dismissCount, 1, "onDismiss must fire exactly once regardless of repeated dismiss() calls")
        XCTAssertTrue(controller.dismissed)
    }

    // MARK: - T7: windowWillClose after dismiss() does not double-fire onDismiss

    func testWindowWillClose_afterDismiss_doesNotDoubleFire() {
        let (controller, _) = makeController()
        var dismissCount = 0
        controller.onDismiss = { dismissCount += 1 }

        controller.showOnboarding(startingAt: nil)
        controller.dismiss()

        // Simulate windowWillClose firing a second time (dismiss() already triggered it via close())
        if let window = controller.window {
            controller.windowWillClose(Notification(name: NSWindow.willCloseNotification, object: window))
        }

        XCTAssertEqual(dismissCount, 1, "windowWillClose after dismiss must not fire onDismiss a second time")
    }

    // MARK: - T8: windowWillClose without prior dismiss() fires onDismiss

    func testWindowWillClose_withoutPriorDismiss_firesOnDismiss() {
        let (controller, _) = makeController()
        var dismissFired = false
        controller.onDismiss = { dismissFired = true }

        controller.showOnboarding(startingAt: nil)

        // Simulate user clicking the window close button (X) directly
        controller.window?.close()

        XCTAssertTrue(dismissFired, "windowWillClose must fire onDismiss when dismiss() was not called first")
        XCTAssertTrue(controller.dismissed)
    }

    // MARK: - T9: showOnboarding mid-flow brings window to front without resetting

    func testShowOnboarding_midFlow_doesNotResetScreen() {
        let (controller, _) = makeController()

        controller.showOnboarding(startingAt: nil)
        // Advance to screenRecording step
        controller.advance() // → safariExtension
        controller.advance() // → screenRecording

        XCTAssertEqual(controller.currentScreen, .step(.screenRecording))

        // Call showOnboarding again mid-flow — entire call is a no-op (only brings
        // window to front), regardless of the startingAt argument
        controller.showOnboarding(startingAt: .safariExtension)

        XCTAssertEqual(controller.currentScreen, .step(.screenRecording),
                       "showOnboarding mid-flow must be a no-op regardless of startingAt argument")

        controller.window?.orderOut(nil)
    }
}
