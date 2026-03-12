import XCTest
@testable import ClaudeInSafari

// MARK: - AppleScriptBridgeTests

/// Unit tests for AppleScriptBridge dimension validation and error messages.
/// Tests that require a live Safari window must be run manually
/// since they depend on a running GUI application.
final class AppleScriptBridgeTests: XCTestCase {

    private var bridge: AppleScriptBridge!

    override func setUp() {
        super.setUp()
        bridge = AppleScriptBridge()
    }

    // MARK: - Zero and negative dimensions

    func testValidateDimensions_zeroWidth_throwsNotPositive() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 0, height: 1024)) { error in
            guard case AppleScriptBridge.ResizeError.notPositive = error else {
                XCTFail("Expected notPositive, got \(error)")
                return
            }
        }
    }

    func testValidateDimensions_negativeWidth_throwsNotPositive() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: -100, height: 500)) { error in
            guard case AppleScriptBridge.ResizeError.notPositive = error else {
                XCTFail("Expected notPositive, got \(error)")
                return
            }
        }
    }

    func testValidateDimensions_zeroHeight_throwsNotPositive() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 1024, height: 0)) { error in
            guard case AppleScriptBridge.ResizeError.notPositive = error else {
                XCTFail("Expected notPositive, got \(error)")
                return
            }
        }
    }

    // MARK: - Below minimum per axis

    func testValidateDimensions_widthBelowMin_throwsBelowMinimumWidth() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 100, height: 500)) { error in
            guard case AppleScriptBridge.ResizeError.belowMinimum(let axis) = error else {
                XCTFail("Expected belowMinimum, got \(error)")
                return
            }
            XCTAssertEqual(axis, "Width")
        }
    }

    func testValidateDimensions_heightBelowMin_throwsBelowMinimumHeight() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 500, height: 100)) { error in
            guard case AppleScriptBridge.ResizeError.belowMinimum(let axis) = error else {
                XCTFail("Expected belowMinimum, got \(error)")
                return
            }
            XCTAssertEqual(axis, "Height")
        }
    }

    func testValidateDimensions_bothBelowMin_throwsBelowMinimumWidth() throws {
        // Width is checked first.
        XCTAssertThrowsError(try bridge.validateDimensions(width: 100, height: 100)) { error in
            guard case AppleScriptBridge.ResizeError.belowMinimum(let axis) = error else {
                XCTFail("Expected belowMinimum, got \(error)")
                return
            }
            XCTAssertEqual(axis, "Width")
        }
    }

    // MARK: - Exceeds 8K limit per axis

    func testValidateDimensions_exceedsMaxWidth_throwsExceedsMaximumWidth() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 10000, height: 1080)) { error in
            guard case AppleScriptBridge.ResizeError.exceedsMaximum(let axis) = error else {
                XCTFail("Expected exceedsMaximum, got \(error)")
                return
            }
            XCTAssertEqual(axis, "Width")
        }
    }

    func testValidateDimensions_exceedsMaxHeight_throwsExceedsMaximumHeight() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 1920, height: 10000)) { error in
            guard case AppleScriptBridge.ResizeError.exceedsMaximum(let axis) = error else {
                XCTFail("Expected exceedsMaximum, got \(error)")
                return
            }
            XCTAssertEqual(axis, "Height")
        }
    }

    // MARK: - Valid dimensions (validation only — no live Safari required)

    func testValidateDimensions_1024x768_doesNotThrow() throws {
        XCTAssertNoThrow(try bridge.validateDimensions(width: 1024, height: 768))
    }

    func testValidateDimensions_375x812_doesNotThrow() throws {
        XCTAssertNoThrow(try bridge.validateDimensions(width: 375, height: 812))
    }

    func testValidateDimensions_1920x1080_doesNotThrow() throws {
        XCTAssertNoThrow(try bridge.validateDimensions(width: 1920, height: 1080))
    }

    func testValidateDimensions_exactMinimum_doesNotThrow() throws {
        XCTAssertNoThrow(try bridge.validateDimensions(width: 200, height: 200))
    }

    func testValidateDimensions_exactMaximum_doesNotThrow() throws {
        XCTAssertNoThrow(try bridge.validateDimensions(
            width: AppleScriptBridge.maxWidth,
            height: AppleScriptBridge.maxHeight
        ))
    }

    // MARK: - Error messages

    func testResizeError_notPositive_userMessage() {
        let error = AppleScriptBridge.ResizeError.notPositive
        XCTAssertEqual(error.userMessage, "Width and height must be positive numbers")
    }

    func testResizeError_belowMinimumWidth_userMessage() {
        let error = AppleScriptBridge.ResizeError.belowMinimum("Width")
        XCTAssertTrue(error.userMessage.contains("Width"))
        XCTAssertTrue(error.userMessage.contains("200"))
    }

    func testResizeError_belowMinimumHeight_userMessage() {
        let error = AppleScriptBridge.ResizeError.belowMinimum("Height")
        XCTAssertTrue(error.userMessage.contains("Height"))
        XCTAssertTrue(error.userMessage.contains("200"))
    }

    func testResizeError_exceedsMaximumWidth_userMessage() {
        let error = AppleScriptBridge.ResizeError.exceedsMaximum("Width")
        XCTAssertTrue(error.userMessage.contains("Width"))
        XCTAssertTrue(error.userMessage.contains("8K"))
    }

    func testResizeError_exceedsMaximumHeight_userMessage() {
        let error = AppleScriptBridge.ResizeError.exceedsMaximum("Height")
        XCTAssertTrue(error.userMessage.contains("Height"))
        XCTAssertTrue(error.userMessage.contains("8K"))
    }

    func testResizeError_noWindowFound_userMessage() {
        let error = AppleScriptBridge.ResizeError.noWindowFound
        XCTAssertEqual(error.userMessage, "No Safari window found")
    }

    func testResizeError_fullscreen_userMessage() {
        let error = AppleScriptBridge.ResizeError.fullscreen
        XCTAssertEqual(error.userMessage, "Cannot resize a fullscreen window. Exit fullscreen first.")
    }

    func testResizeError_permissionDenied_userMessage() {
        let error = AppleScriptBridge.ResizeError.permissionDenied
        XCTAssertTrue(error.userMessage.contains("Automation"))
        XCTAssertTrue(error.userMessage.contains("Accessibility"))
        XCTAssertTrue(error.userMessage.contains("System Settings"))
    }

    func testResizeError_executionFailed_userMessage() {
        let error = AppleScriptBridge.ResizeError.executionFailed("some detail")
        XCTAssertTrue(error.userMessage.contains("Failed to resize window"))
        XCTAssertTrue(error.userMessage.contains("some detail"))
    }

    // MARK: - Float truncation (documents ToolRouter behavior)

    func testTruncation_floatDimensionsBecomeSmallerIntegers() {
        // ToolRouter passes Int(w) to resizeWindow — Swift truncates toward zero.
        // 1024.7 → 1024, 768.3 → 768 (both valid; no error expected).
        XCTAssertEqual(Int(1024.7), 1024)
        XCTAssertEqual(Int(768.3), 768)
        XCTAssertNoThrow(try bridge.validateDimensions(width: Int(1024.7), height: Int(768.3)))
    }

    func testTruncation_nearMinimumTruncatesDown_throwsBelowMinimum() throws {
        // 199.9 truncates to 199, which is below the 200-pixel minimum.
        XCTAssertEqual(Int(199.9), 199)
        XCTAssertThrowsError(try bridge.validateDimensions(width: Int(199.9), height: 768)) { error in
            guard case AppleScriptBridge.ResizeError.belowMinimum(let axis) = error else {
                XCTFail("Expected belowMinimum, got \(error)")
                return
            }
            XCTAssertEqual(axis, "Width")
        }
    }

    // MARK: - Constants

    func testConstants_minDimension() {
        XCTAssertEqual(AppleScriptBridge.minDimension, 200)
    }

    func testConstants_maxDimensions() {
        XCTAssertEqual(AppleScriptBridge.maxWidth, 7680)
        XCTAssertEqual(AppleScriptBridge.maxHeight, 4320)
    }

    // MARK: - Manual-only tests (require live Safari)
    // T1–T3, T9–T11, T13: resizeWindow() end-to-end — must be run manually.
    // These tests launch osascript and require a running Safari window.
}
