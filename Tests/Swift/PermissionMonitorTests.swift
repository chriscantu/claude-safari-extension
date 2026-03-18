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
    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        completion(extensionEnabled)
    }
    func registerAccessibility() {}
    func requestAccessibility() { requestAccessibilityCalled = true }
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
}
