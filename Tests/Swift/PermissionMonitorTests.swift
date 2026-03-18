// Tests/Swift/PermissionMonitorTests.swift
import XCTest
@testable import ClaudeInSafari

// MARK: - Mock

final class MockPermissionChecker: PermissionChecking {
    var accessibilityGranted = false
    var screenRecordingGranted = false
    var extensionEnabled = false

    var requestAccessibilityCalled = false

    func isAccessibilityGranted() -> Bool { accessibilityGranted }
    func isScreenRecordingGranted() -> Bool { screenRecordingGranted }
    var extensionEnabledSequence: [Bool] = []

    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        if !extensionEnabledSequence.isEmpty {
            completion(extensionEnabledSequence.removeFirst())
        } else {
            completion(extensionEnabled)
        }
    }
    func registerAccessibility() {}
    func requestAccessibility() { requestAccessibilityCalled = true }
    func registerScreenRecording() {}
}

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

// MARK: - Tests

final class PermissionMonitorTests: XCTestCase {

    // T1 — allGranted returns true when all three are granted
    func testAllGranted_whenAllPermissionsGranted() {
        let checker = MockPermissionChecker()
        checker.accessibilityGranted = true
        checker.screenRecordingGranted = true
        checker.extensionEnabled = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "allGranted")
        monitor.checkAll { status in
            XCTAssertTrue(Thread.isMainThread, "checkAll must deliver on the main thread")
            XCTAssertTrue(status.allGranted)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T2 — allGranted returns false when accessibility is missing
    func testAllGranted_falseWhenAccessibilityMissing() {
        let checker = MockPermissionChecker()
        checker.screenRecordingGranted = true
        checker.extensionEnabled = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "notAllGranted")
        monitor.checkAll { status in
            XCTAssertTrue(Thread.isMainThread, "checkAll must deliver on the main thread")
            XCTAssertFalse(status.allGranted)
            XCTAssertFalse(status.accessibility)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T3 — firstIncompleteStep returns .safariExtension when extension is not enabled
    func testFirstIncompleteStep_extensionNotEnabled() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = false
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "firstStep")
        monitor.checkAll { status in
            XCTAssertTrue(Thread.isMainThread, "checkAll must deliver on the main thread")
            XCTAssertEqual(status.firstIncompleteStep, .safariExtension)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T4 — firstIncompleteStep returns .screenRecording when extension is enabled but recording is not
    func testFirstIncompleteStep_screenRecordingNotGranted() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = true
        checker.screenRecordingGranted = false
        checker.accessibilityGranted = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "screenRecording")
        monitor.checkAll { status in
            XCTAssertTrue(Thread.isMainThread, "checkAll must deliver on the main thread")
            XCTAssertEqual(status.firstIncompleteStep, .screenRecording)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T5 — firstIncompleteStep returns .accessibility when only accessibility is missing
    func testFirstIncompleteStep_accessibilityNotGranted() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = true
        checker.screenRecordingGranted = true
        checker.accessibilityGranted = false
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "accessibility")
        monitor.checkAll { status in
            XCTAssertTrue(Thread.isMainThread, "checkAll must deliver on the main thread")
            XCTAssertEqual(status.firstIncompleteStep, .accessibility)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T6 — firstIncompleteStep returns nil when all granted
    func testFirstIncompleteStep_nilWhenAllGranted() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = true
        checker.screenRecordingGranted = true
        checker.accessibilityGranted = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "noIncomplete")
        monitor.checkAll { status in
            XCTAssertTrue(Thread.isMainThread, "checkAll must deliver on the main thread")
            XCTAssertNil(status.firstIncompleteStep)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

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

        // Call 1: true (first read, adopted via fallback)
        let exp1 = expectation(description: "call1")
        monitor.checkAll { status in
            XCTAssertTrue(status.extensionEnabled)
            exp1.fulfill()
        }
        waitForExpectations(timeout: 1)

        // Call 2: true (matches pending → adopted as lastExtensionEnabled)
        let exp2 = expectation(description: "call2")
        monitor.checkAll { status in
            XCTAssertTrue(status.extensionEnabled)
            exp2.fulfill()
        }
        waitForExpectations(timeout: 1)

        // Call 3: false (single flicker → buffered, reports last stable = true)
        let exp3 = expectation(description: "call3")
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
        monitor.checkAll { _ in exp1.fulfill() }
        waitForExpectations(timeout: 1)

        let exp2 = expectation(description: "call2")
        monitor.checkAll { _ in exp2.fulfill() }
        waitForExpectations(timeout: 1)

        let exp3 = expectation(description: "call3")
        monitor.checkAll { _ in exp3.fulfill() }
        waitForExpectations(timeout: 1)

        // Call 4: second consecutive false → adopted
        let exp4 = expectation(description: "call4")
        monitor.checkAll { status in
            XCTAssertFalse(status.extensionEnabled, "Two consecutive false should adopt")
            exp4.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // D4 — Alternating values never change from established stable state
    func testDebounce_alternatingNeverChanges() {
        let checker = MockPermissionChecker()
        // First two true establish stable state, then alternating false/true/false/true
        checker.extensionEnabledSequence = [true, true, false, true, false, true]
        let monitor = PermissionMonitor(checker: checker)

        // Establish stable true (two consecutive reads)
        let setup1 = expectation(description: "setup1")
        monitor.checkAll { _ in setup1.fulfill() }
        waitForExpectations(timeout: 1)
        let setup2 = expectation(description: "setup2")
        monitor.checkAll { _ in setup2.fulfill() }
        waitForExpectations(timeout: 1)

        // Now alternate: false, true, false, true — no two consecutive, so stable stays true
        var results: [Bool] = []
        for i in 0..<4 {
            let exp = expectation(description: "call\(i)")
            monitor.checkAll { status in
                results.append(status.extensionEnabled)
                exp.fulfill()
            }
            waitForExpectations(timeout: 1)
        }

        // All should report true (alternating never overrides established stable state)
        XCTAssertEqual(results, [true, true, true, true],
                       "Alternating values should never change reported state")
    }

    // D5 — Dealloc mid-check delivers safe default
    func testDebounce_deallocMidCheck_deliversSafeDefault() {
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
}
