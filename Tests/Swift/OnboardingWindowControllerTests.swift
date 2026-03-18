// Tests/Swift/OnboardingWindowControllerTests.swift
import XCTest
@testable import ClaudeInSafari

// MARK: - Helpers

private final class OnboardingMockChecker: PermissionChecking {
    var accessibilityGranted = false
    var screenRecordingGranted = false
    var extensionEnabled = false
    var registerAccessibilityCallCount = 0
    var requestAccessibilityCallCount = 0
    var registerScreenRecordingCallCount = 0

    func isAccessibilityGranted() -> Bool { accessibilityGranted }
    func isScreenRecordingGranted() -> Bool { screenRecordingGranted }
    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        completion(extensionEnabled)
    }
    func registerAccessibility() { registerAccessibilityCallCount += 1 }
    func requestAccessibility() { requestAccessibilityCallCount += 1 }
    func registerScreenRecording() { registerScreenRecordingCallCount += 1 }
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

    // MARK: - T5b: showOnboarding(allComplete: true) skips to done

    func testShowOnboarding_allComplete_skipsToDone() {
        let (controller, _) = makeController()

        controller.showOnboarding(startingAt: nil, allComplete: true)

        XCTAssertEqual(controller.currentScreen, .done,
                       "When allComplete is true, should skip directly to done screen")
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

    // MARK: - Category B: Polling-driven auto-advance

    // MARK: - T10: Permission granted mid-step triggers advance

    func testCheckStepCompletion_permissionGranted_advances() {
        let (controller, checker) = makeController()
        controller.showOnboarding(startingAt: .safariExtension)
        XCTAssertEqual(controller.currentScreen, .step(.safariExtension))

        // Grant the extension permission
        checker.extensionEnabled = true

        // Call checkStepCompletion — the mock's getExtensionEnabled completes synchronously,
        // but checkAll re-dispatches to main queue, so we need to drain it
        controller.checkStepCompletion(.safariExtension)

        let exp = expectation(description: "advance after permission granted")
        DispatchQueue.main.async {
            XCTAssertEqual(controller.currentScreen, .step(.screenRecording),
                           "Should auto-advance to screenRecording after extension is enabled")
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)

        controller.window?.orderOut(nil)
    }

    // MARK: - T11: Permission not granted does not advance

    func testCheckStepCompletion_permissionNotGranted_staysOnStep() {
        let (controller, checker) = makeController()
        controller.showOnboarding(startingAt: .screenRecording)
        XCTAssertEqual(controller.currentScreen, .step(.screenRecording))

        // Screen recording still denied
        checker.extensionEnabled = true
        checker.screenRecordingGranted = false

        controller.checkStepCompletion(.screenRecording)

        let exp = expectation(description: "no advance")
        DispatchQueue.main.async {
            XCTAssertEqual(controller.currentScreen, .step(.screenRecording),
                           "Should stay on screenRecording when permission is not granted")
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)

        controller.window?.orderOut(nil)
    }

    // MARK: - T12: checkInFlight guard prevents stacking

    func testCheckStepCompletion_checkInFlight_skips() {
        let (controller, checker) = makeController()
        controller.showOnboarding(startingAt: .safariExtension)
        checker.extensionEnabled = true

        // First call sets checkInFlight = true
        controller.checkStepCompletion(.safariExtension)
        XCTAssertTrue(controller.checkInFlight, "checkInFlight should be true while checkAll is pending")

        // Second call while first is in-flight should be a no-op — screen unchanged
        // (The first call hasn't delivered its callback yet because main queue hasn't drained)
        controller.checkStepCompletion(.safariExtension)

        // Drain to let the first callback deliver
        let exp = expectation(description: "first callback delivers")
        DispatchQueue.main.async {
            XCTAssertEqual(controller.currentScreen, .step(.screenRecording),
                           "Only the first call should advance — second was skipped")
            XCTAssertFalse(controller.checkInFlight, "checkInFlight should reset after callback")
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)

        controller.window?.orderOut(nil)
    }

    // MARK: - T13: Stale callback after screen change is ignored

    func testCheckStepCompletion_staleCallback_ignored() {
        let (controller, checker) = makeController()
        controller.showOnboarding(startingAt: .safariExtension)
        checker.extensionEnabled = true

        // Fire checkStepCompletion for safariExtension
        controller.checkStepCompletion(.safariExtension)

        // Before the callback delivers, manually advance past safariExtension
        controller.advance() // → screenRecording
        controller.advance() // → accessibility
        XCTAssertEqual(controller.currentScreen, .step(.accessibility))

        // Now drain — the stale safariExtension callback should be ignored
        let exp = expectation(description: "stale callback ignored")
        DispatchQueue.main.async {
            XCTAssertEqual(controller.currentScreen, .step(.accessibility),
                           "Stale callback for safariExtension must not advance from accessibility")
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)

        controller.window?.orderOut(nil)
    }

    // MARK: - T14: Callback after dismiss is ignored

    func testCheckStepCompletion_afterDismiss_ignored() {
        let (controller, checker) = makeController()
        var dismissCount = 0
        controller.onDismiss = { dismissCount += 1 }

        controller.showOnboarding(startingAt: .safariExtension)
        checker.extensionEnabled = true

        // Fire checkStepCompletion then dismiss before callback delivers
        controller.checkStepCompletion(.safariExtension)
        controller.dismiss()
        XCTAssertTrue(controller.dismissed)
        XCTAssertEqual(dismissCount, 1)

        // Drain — callback should see dismissed flag and bail
        let exp = expectation(description: "post-dismiss callback ignored")
        DispatchQueue.main.async {
            // Should still be on safariExtension (no advance after dismiss)
            XCTAssertEqual(controller.currentScreen, .step(.safariExtension),
                           "Callback after dismiss must not advance the screen")
            XCTAssertEqual(dismissCount, 1, "No additional onDismiss from post-dismiss callback")
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T15: pollTimer is nil after dismiss

    func testDismiss_stopsPollTimer() {
        let (controller, _) = makeController()
        controller.showOnboarding(startingAt: .safariExtension)

        // Entering a step starts polling — timer should exist
        XCTAssertNotNil(controller.pollTimer, "pollTimer should be running on a step screen")
        XCTAssertTrue(controller.pollTimer?.isValid ?? false)

        controller.dismiss()

        XCTAssertNil(controller.pollTimer, "pollTimer must be nil after dismiss")
    }

    // MARK: - Done screen "Try this" card

    // MARK: - T16: Done screen contains the example prompt text

    func testDoneScreen_containsExamplePrompt() {
        let (controller, _) = makeController()
        controller.showOnboarding(startingAt: nil)
        for _ in 0..<4 { controller.advance() }
        XCTAssertEqual(controller.currentScreen, .done)

        // Walk the view hierarchy to find a text field containing the example prompt
        let contentView = controller.window?.contentView
        let promptField = findTextField(in: contentView, matching: OnboardingWindowController.examplePrompt)
        XCTAssertNotNil(promptField, "Done screen must contain a text field with the example prompt")
        XCTAssertTrue(promptField?.isSelectable ?? false, "Example prompt must be selectable for copy")

        controller.window?.orderOut(nil)
    }

    // MARK: - T17: Done screen contains "Try this" label

    func testDoneScreen_containsTryThisLabel() {
        let (controller, _) = makeController()
        controller.showOnboarding(startingAt: nil)
        for _ in 0..<4 { controller.advance() }

        let contentView = controller.window?.contentView
        let tryLabel = findTextField(in: contentView, matching: "Try this in Claude Code:")
        XCTAssertNotNil(tryLabel, "Done screen must contain a 'Try this in Claude Code:' label")

        controller.window?.orderOut(nil)
    }

    // MARK: - T18: Done screen contains a Copy button

    func testDoneScreen_containsCopyButton() {
        let (controller, _) = makeController()
        controller.showOnboarding(startingAt: nil)
        for _ in 0..<4 { controller.advance() }

        let contentView = controller.window?.contentView
        let copyButton = findButton(in: contentView, titled: "Copy")
        XCTAssertNotNil(copyButton, "Done screen must contain a 'Copy' button")

        controller.window?.orderOut(nil)
    }

    // MARK: - T19: Copy button places example prompt on pasteboard

    func testCopyButton_placesPromptOnPasteboard() {
        let (controller, _) = makeController()
        controller.showOnboarding(startingAt: nil)
        for _ in 0..<4 { controller.advance() }
        defer { NSPasteboard.general.clearContents() }

        let contentView = controller.window?.contentView
        let copyButton = findButton(in: contentView, titled: "Copy")
        XCTAssertNotNil(copyButton)

        // Simulate clicking the Copy button
        copyButton?.performClick(nil)

        let pasteboardString = NSPasteboard.general.string(forType: .string)
        XCTAssertEqual(pasteboardString, OnboardingWindowController.examplePrompt,
                       "Clicking Copy must place the example prompt on the pasteboard")

        // Button should show "Copied!" feedback
        XCTAssertEqual(copyButton?.title, "Copied!",
                       "Copy button must show 'Copied!' after successful copy")

        // Dismiss cancels the pending 1.5s reset work item, preventing async leaks
        controller.dismiss()
    }

    // MARK: - View hierarchy helpers

    private func findTextField(in view: NSView?, matching text: String) -> NSTextField? {
        guard let view = view else { return nil }
        if let tf = view as? NSTextField, tf.stringValue == text { return tf }
        for sub in view.subviews {
            if let found = findTextField(in: sub, matching: text) { return found }
        }
        return nil
    }

    private func findButton(in view: NSView?, titled title: String) -> NSButton? {
        guard let view = view else { return nil }
        if let btn = view as? NSButton, btn.title == title { return btn }
        for sub in view.subviews {
            if let found = findButton(in: sub, titled: title) { return found }
        }
        return nil
    }

    // MARK: - T20: Step entry silently registers in TCC but does not show system dialogs

    func testStepEntry_registersButDoesNotPrompt() {
        let (controller, checker) = makeController()

        // Enter the Screen Recording step
        controller.showOnboarding(startingAt: .screenRecording)

        // Silent registration SHOULD happen on step entry (so app appears in System Settings)
        XCTAssertEqual(checker.registerScreenRecordingCallCount, 1,
                       "registerScreenRecording must be called on step entry for TCC registration")

        // Advance to Accessibility step
        controller.advance()

        // Silent registration SHOULD happen on step entry
        XCTAssertEqual(checker.registerAccessibilityCallCount, 1,
                       "registerAccessibility must be called on step entry for TCC registration")

        // The prompt-dialog version must NOT be called on step entry — it shows a
        // system TCC dialog that competes with our "Open System Settings" button.
        XCTAssertEqual(checker.requestAccessibilityCallCount, 0,
                       "requestAccessibility (with prompt) must not be called on step entry — defer to button tap")

        controller.window?.orderOut(nil)
    }
}
