import XCTest
@testable import ClaudeInSafari

// MARK: - AppleScriptBridgeTests

/// Unit tests for AppleScriptBridge dimension validation and error messages.
/// Tests that require a live Safari window (T1–T3, T9–T11, T13) must be run manually
/// since they depend on a running GUI application.
final class AppleScriptBridgeTests: XCTestCase {

    private var bridge: AppleScriptBridge!

    override func setUp() {
        super.setUp()
        bridge = AppleScriptBridge()
    }

    // MARK: - T6: Negative dimensions

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

    // MARK: - T8 / T14: Below minimum per axis

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

    // MARK: - T7: Exceeds 8K limit

    func testValidateDimensions_exceedsMaxWidth_throwsExceedsMaximum() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 10000, height: 1080)) { error in
            guard case AppleScriptBridge.ResizeError.exceedsMaximum = error else {
                XCTFail("Expected exceedsMaximum, got \(error)")
                return
            }
        }
    }

    func testValidateDimensions_exceedsMaxHeight_throwsExceedsMaximum() throws {
        XCTAssertThrowsError(try bridge.validateDimensions(width: 1920, height: 10000)) { error in
            guard case AppleScriptBridge.ResizeError.exceedsMaximum = error else {
                XCTFail("Expected exceedsMaximum, got \(error)")
                return
            }
        }
    }

    // MARK: - T1 / T2 / T3: Valid dimensions (validation only)

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

    func testResizeError_exceedsMaximum_userMessage() {
        let error = AppleScriptBridge.ResizeError.exceedsMaximum
        XCTAssertTrue(error.userMessage.contains("8K"))
    }

    func testResizeError_noWindowFound_userMessage() {
        let error = AppleScriptBridge.ResizeError.noWindowFound
        XCTAssertEqual(error.userMessage, "No Safari window found")
    }

    func testResizeError_fullscreen_userMessage() {
        let error = AppleScriptBridge.ResizeError.fullscreen
        XCTAssertTrue(error.userMessage.contains("fullscreen"))
    }

    func testResizeError_accessibilityDenied_userMessage() {
        let error = AppleScriptBridge.ResizeError.accessibilityDenied
        XCTAssertTrue(error.userMessage.contains("Accessibility"))
        XCTAssertTrue(error.userMessage.contains("System Settings"))
    }

    func testResizeError_executionFailed_userMessage() {
        let error = AppleScriptBridge.ResizeError.executionFailed("some detail")
        XCTAssertTrue(error.userMessage.contains("Failed to resize window"))
        XCTAssertTrue(error.userMessage.contains("some detail"))
    }

    // MARK: - T12: Float truncation (documents ToolRouter behaviour)

    func testTruncation_floatDimensionsBecomeSmallerIntegers() {
        // ToolRouter passes Int(w) to resizeWindow — Swift truncates toward zero.
        // 1024.7 → 1024, 768.3 → 768 (both valid; no error expected).
        XCTAssertEqual(Int(1024.7), 1024)
        XCTAssertEqual(Int(768.3), 768)
        XCTAssertNoThrow(try bridge.validateDimensions(width: Int(1024.7), height: Int(768.3)))
    }

    // MARK: - Constants

    func testConstants_minDimension() {
        XCTAssertEqual(AppleScriptBridge.minDimension, 200)
    }

    func testConstants_maxDimensions() {
        XCTAssertEqual(AppleScriptBridge.maxWidth, 7680)
        XCTAssertEqual(AppleScriptBridge.maxHeight, 4320)
    }
}
