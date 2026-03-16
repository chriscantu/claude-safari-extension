// Tests/Swift/MenuBarControllerTests.swift
import XCTest
@testable import ClaudeInSafari

final class MenuBarControllerTests: XCTestCase {

    // T1 — initial state is .notConnected
    func testInitialState_isNotConnected() {
        let controller = MenuBarController()
        XCTAssertEqual(controller.state, .notConnected)
    }

    // T2 — setState(.connected) updates state
    func testSetState_connected() {
        let controller = MenuBarController()
        controller.setState(.connected)
        XCTAssertEqual(controller.state, .connected)
    }

    // T3 — setState(.needsAttention) with message stores message
    func testSetState_needsAttention_storesMessage() {
        let controller = MenuBarController()
        controller.setState(.needsAttention("Screen Recording permission was removed"))
        if case .needsAttention(let msg) = controller.state {
            XCTAssertEqual(msg, "Screen Recording permission was removed")
        } else {
            XCTFail("Expected .needsAttention state")
        }
    }

    // T4 — menuBarState(from:) returns .connected when allGranted
    func testMenuBarState_allGranted_isConnected() {
        let status = PermissionStatus(extensionEnabled: true, screenRecording: true, accessibility: true)
        XCTAssertEqual(MenuBarController.menuBarState(from: status), .connected)
    }

    // T5 — menuBarState(from:) returns .needsAttention when screen recording revoked
    func testMenuBarState_screenRecordingRevoked_isNeedsAttention() {
        let status = PermissionStatus(extensionEnabled: true, screenRecording: false, accessibility: true)
        if case .needsAttention(let msg) = MenuBarController.menuBarState(from: status) {
            XCTAssertTrue(msg.contains("Screen Recording"), "Expected Screen Recording in message, got: \(msg)")
        } else {
            XCTFail("Expected .needsAttention state")
        }
    }

    // T6 — menuBarState(from:) returns .notConnected when extension not enabled
    func testMenuBarState_extensionNotEnabled_isNotConnected() {
        let status = PermissionStatus(extensionEnabled: false, screenRecording: true, accessibility: true)
        XCTAssertEqual(MenuBarController.menuBarState(from: status), .notConnected)
    }
}
