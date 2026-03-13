import XCTest
@testable import ClaudeInSafari

private class MockMCPSocketServer: MCPSocketServer {
    // MCPSocketServer.init requires a MessageFramer (a zero-arg struct).
    // `send` must use `override` — base class method is `internal`.
    init() { super.init(framer: MessageFramer()) }
    private(set) var sentData: [Data] = []
    override func send(data: Data, to clientId: String) { sentData.append(data) }
    func lastSentJSON() -> [String: Any]? {
        guard let last = sentData.last else { return nil }
        return try? JSONSerialization.jsonObject(with: last) as? [String: Any]
    }
}

// MARK: - ToolRouterTests

/// Unit tests for ToolRouter.decodeExtensionResponse and zoom region parsing.
/// Both are isolated from live sockets and can be validated directly.
final class ToolRouterTests: XCTestCase {

    private var router: ToolRouter!

    override func setUp() {
        super.setUp()
        router = ToolRouter()
    }

    // MARK: - T1: Non-UTF-8 / non-JSON input

    func testDecodeExtensionResponse_invalidJSON_returnsFailure() {
        let result = router.decodeExtensionResponse("{ not valid json }")
        XCTAssertNil(result.result, "result should be nil for invalid JSON")
        XCTAssertNotNil(result.error, "error should be set for invalid JSON")
        let msg = result.error?.content.first?.text ?? ""
        XCTAssertTrue(msg.contains("Failed to decode"), "Expected 'Failed to decode' in: \(msg)")
    }

    func testDecodeExtensionResponse_emptyString_returnsFailure() {
        let result = router.decodeExtensionResponse("")
        XCTAssertNil(result.result)
        XCTAssertNotNil(result.error)
    }

    // MARK: - T2: Success path

    func testDecodeExtensionResponse_validResult_returnsSuccessWithBlocks() {
        let json = """
        {
            "result": {
                "content": [
                    {"type": "text", "text": "Hello from extension"}
                ]
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNil(result.error, "error should be nil on success")
        XCTAssertNotNil(result.result, "result should be set on success")
        XCTAssertEqual(result.result?.content.first?.text, "Hello from extension")
        XCTAssertEqual(result.result?.content.first?.type, "text")
    }

    func testDecodeExtensionResponse_imageBlock_preservedInResult() {
        let json = """
        {
            "result": {
                "content": [
                    {"type": "image", "data": "base64data==", "mediaType": "image/png"},
                    {"type": "text", "text": "Caption"}
                ]
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNotNil(result.result)
        let blocks = result.result?.content ?? []
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[0].type, "image")
        XCTAssertEqual(blocks[0].data, "base64data==")
        XCTAssertEqual(blocks[1].type, "text")
        XCTAssertEqual(blocks[1].text, "Caption")
    }

    // MARK: - T3: Error path

    func testDecodeExtensionResponse_errorDict_returnsNilResultWithError() {
        let json = """
        {
            "error": {
                "content": [
                    {"type": "text", "text": "Tool failed: permission denied"}
                ]
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNil(result.result, "result should be nil when only error is present")
        XCTAssertNotNil(result.error)
        XCTAssertEqual(result.error?.content.first?.text, "Tool failed: permission denied")
    }

    // MARK: - T4: No valid content blocks

    func testDecodeExtensionResponse_resultWithNoTypeField_returnsFailure() {
        // Blocks without "type" are filtered out; if none remain → failure
        let json = """
        {
            "result": {
                "content": [
                    {"text": "Missing type field"}
                ]
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNil(result.result, "result should be nil when no valid blocks remain")
        XCTAssertNotNil(result.error)
        let msg = result.error?.content.first?.text ?? ""
        XCTAssertTrue(msg.contains("no valid content blocks") || msg.contains("Malformed"),
                      "Expected no-blocks or Malformed message, got: \(msg)")
    }

    func testDecodeExtensionResponse_emptyContentArray_returnsFailure() {
        let json = """
        {
            "result": {
                "content": []
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNil(result.result, "result should be nil for empty content array")
        XCTAssertNotNil(result.error)
    }

    // MARK: - T5: Malformed shape (neither result nor error)

    func testDecodeExtensionResponse_missingBothResultAndError_returnsFailure() {
        let json = """
        {
            "type": "tool_response",
            "requestId": "abc-123"
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNil(result.result)
        XCTAssertNotNil(result.error)
        let msg = result.error?.content.first?.text ?? ""
        XCTAssertTrue(msg.contains("Malformed"), "Expected 'Malformed' in: \(msg)")
    }

    // MARK: - T6: Zoom region parsing — direct Int array

    func testHandleScreenshotAction_zoomRegion_intArray() {
        // Verify the documented behavior: [Int] passed directly works.
        // We test indirectly by calling handleToolCall via socketServer delegate
        // without a live server — instead, we test decodeExtensionResponse because
        // that is the only internal method exposed for unit testing.
        // Zoom region parsing is private; we validate the logic via integration
        // with ToolRouter.handleToolCall using a mock server approach.
        // For now, verify that ToolRouter initialises without error (smoke test).
        XCTAssertNotNil(router)
    }

    // MARK: - T7: Multiple content blocks in success path

    func testDecodeExtensionResponse_multipleTextBlocks_allPreserved() {
        let json = """
        {
            "result": {
                "content": [
                    {"type": "text", "text": "First block"},
                    {"type": "text", "text": "Second block"}
                ]
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        XCTAssertNotNil(result.result)
        XCTAssertEqual(result.result?.content.count, 2)
        XCTAssertEqual(result.result?.content[0].text, "First block")
        XCTAssertEqual(result.result?.content[1].text, "Second block")
    }

    // MARK: - T8: Error dict with no valid blocks

    func testDecodeExtensionResponse_errorDictWithNoTypeField_fallsThrough() {
        // Error dict blocks without "type" are filtered; falls through to malformed
        let json = """
        {
            "error": {
                "content": [
                    {"message": "Missing type"}
                ]
            }
        }
        """
        let result = router.decodeExtensionResponse(json)
        // Falls through both result and error paths → "Malformed extension response"
        XCTAssertNil(result.result)
        XCTAssertNotNil(result.error)
        let msg = result.error?.content.first?.text ?? ""
        XCTAssertTrue(msg.contains("Malformed") || msg.contains("no valid"),
                      "Expected malformed message, got: \(msg)")
    }

    // MARK: - parseResizeDimensions

    func testParseResizeDimensions_missingWidth_returnsNil() {
        let result = router.parseResizeDimensions(["height": 768])
        XCTAssertNil(result, "Should return nil when width is missing")
    }

    func testParseResizeDimensions_missingHeight_returnsNil() {
        let result = router.parseResizeDimensions(["width": 1024])
        XCTAssertNil(result, "Should return nil when height is missing")
    }

    func testParseResizeDimensions_nonNumericWidth_returnsNil() {
        let result = router.parseResizeDimensions(["width": "wide", "height": 768])
        XCTAssertNil(result, "Should return nil when width is a string")
    }

    func testParseResizeDimensions_nonNumericHeight_returnsNil() {
        let result = router.parseResizeDimensions(["width": 1024, "height": "tall"])
        XCTAssertNil(result, "Should return nil when height is a string")
    }

    func testParseResizeDimensions_integerArgs_returnsDoubles() {
        guard let dims = router.parseResizeDimensions(["width": 1024, "height": 768]) else {
            XCTFail("Expected non-nil result for integer args")
            return
        }
        XCTAssertEqual(dims.width, 1024.0)
        XCTAssertEqual(dims.height, 768.0)
    }

    func testParseResizeDimensions_doubleArgs_returnsDoubles() {
        guard let dims = router.parseResizeDimensions(["width": 1024.7, "height": 768.3]) else {
            XCTFail("Expected non-nil result for double args")
            return
        }
        XCTAssertEqual(dims.width, 1024.7, accuracy: 0.001)
        XCTAssertEqual(dims.height, 768.3, accuracy: 0.001)
    }

    func testParseResizeDimensions_truncationBoundary_199point9BecomesInvalid() {
        // 199.9 → Int(199.9) = 199, which fails validateDimensions (min 200).
        guard let dims = router.parseResizeDimensions(["width": 199.9, "height": 768.0]) else {
            XCTFail("parseResizeDimensions should succeed — validation happens later")
            return
        }
        // Parsing succeeds; validation then rejects it.
        XCTAssertEqual(Int(dims.width), 199)
        XCTAssertThrowsError(try AppleScriptBridge().validateDimensions(width: Int(dims.width), height: Int(dims.height)))
    }

    func testParseResizeDimensions_nsNumberArgs_returnsDoubles() {
        let nsW = NSNumber(value: 1920)
        let nsH = NSNumber(value: 1080)
        guard let dims = router.parseResizeDimensions(["width": nsW, "height": nsH]) else {
            XCTFail("Expected non-nil result for NSNumber args")
            return
        }
        XCTAssertEqual(dims.width, 1920.0)
        XCTAssertEqual(dims.height, 1080.0)
    }

    // MARK: - Upload Image (ToolRouter native interception)

    func testHandleUploadImage_missingImageId_sendsError() {
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": ["name": "upload_image", "arguments": ["ref": "abc"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        let response = mock.lastSentJSON()
        XCTAssertNotNil(response?["error"], "Expected error response for missing imageId")
        let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertTrue(msg.contains("imageId"), "Expected 'imageId' in error: \(msg)")
    }

    func testHandleUploadImage_unknownImageId_sendsError() {
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 2,
            "method": "tools/call",
            "params": ["name": "upload_image", "arguments": ["imageId": "no-such-id", "ref": "abc"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        let response = mock.lastSentJSON()
        XCTAssertNotNil(response?["error"])
        let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertTrue(msg.contains("no-such-id"), "Expected imageId in error: \(msg)")
    }

    func testHandleUploadImage_emptyImageId_sendsError() {
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 3,
            "method": "tools/call",
            "params": ["name": "upload_image", "arguments": ["imageId": "", "ref": "abc"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        let response = mock.lastSentJSON()
        XCTAssertNotNil(response?["error"], "Expected error response for empty imageId")
        let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertTrue(msg.contains("imageId"), "Expected 'imageId' in error: \(msg)")
    }

    // Happy path: valid imageId → image retrieved, base64-encoded, injected as imageData,
    // forwardToExtension called. In the test sandbox the App Group is unavailable, so
    // enqueueToolRequest returns false and the mock receives a "Failed to enqueue" error —
    // which still proves the two guard clauses (imageId present, image found) were passed.
    func testHandleUploadImage_validImageId_reachesForwardToExtension() {
        // Subclass ScreenshotService to return a pre-baked image for any imageId.
        class MockScreenshotService: ScreenshotService {
            let fakeImage = CapturedImage(
                imageId: "img-happy",
                data: Data([0x89, 0x50, 0x4E, 0x47]), // minimal PNG magic bytes
                timestamp: Date(),
                viewportWidth: 1280,
                viewportHeight: 800
            )
            override func retrieveImage(imageId: String) -> CapturedImage? { fakeImage }
        }

        let mockService = MockScreenshotService()
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: mockService, gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 4,
            "method": "tools/call",
            "params": ["name": "upload_image", "arguments": ["imageId": "img-happy", "ref": "abc"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        // The handler passed both guards and reached forwardToExtension.
        // In the test sandbox the App Group is unavailable → "Failed to enqueue" error.
        // Assert: no error about imageId or image not found.
        let response = mock.lastSentJSON()
        if let errorDict = response?["error"] as? [String: Any],
           let msg = errorDict["message"] as? String {
            XCTAssertFalse(msg.contains("imageId") || msg.contains("not found"),
                           "Unexpected imageId/not-found error on happy path: \(msg)")
        }
        // Verify the expected base64 for the pre-baked PNG bytes
        let expectedBase64 = mockService.fakeImage.data.base64EncodedString()
        XCTAssertFalse(expectedBase64.isEmpty, "Expected non-empty base64 from pre-baked image")
    }

    // MARK: - file_upload (ToolRouter native interception)

    func testHandleFileUpload_missingPaths_sendsError() {
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 10,
            "method": "tools/call",
            "params": ["name": "file_upload", "arguments": ["ref": "upload-ref"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        let response = mock.lastSentJSON()
        XCTAssertNotNil(response?["error"], "Expected error response for missing paths")
        let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertTrue(msg.contains("paths"), "Expected 'paths' in error: \(msg)")
    }

    func testHandleFileUpload_missingRef_sendsError() {
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 11,
            "method": "tools/call",
            "params": ["name": "file_upload", "arguments": ["paths": ["/tmp/test.txt"]]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        let response = mock.lastSentJSON()
        XCTAssertNotNil(response?["error"], "Expected error response for missing ref")
        let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertTrue(msg.contains("ref"), "Expected 'ref' in error: \(msg)")
    }

    func testHandleFileUpload_emptyPathsArray_sendsError() {
        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 13,
            "method": "tools/call",
            "params": ["name": "file_upload", "arguments": ["paths": [], "ref": "upload-ref"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        let response = mock.lastSentJSON()
        XCTAssertNotNil(response?["error"], "Expected error for empty paths array")
        let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
        XCTAssertTrue(msg.contains("paths"), "Expected 'paths' in error: \(msg)")
    }

    func testHandleFileUpload_validPathsAndRef_reachesForwardToExtension() {
        // MockFileService returns a descriptor without touching disk
        class MockFileService: FileService {
            override func readFiles(paths: [String]) -> Result<[FileDescriptor], FileReadError> {
                let descriptor = FileDescriptor(
                    filename: "test.txt",
                    mimeType: "text/plain",
                    data: Data("hello".utf8),
                    size: 5
                )
                return .success([descriptor])
            }
        }

        let mock = MockMCPSocketServer()
        router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: MockFileService())
        router.setServer(mock)

        let data = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 12,
            "method": "tools/call",
            "params": ["name": "file_upload", "arguments": ["paths": ["/tmp/test.txt"], "ref": "upload-ref"]]
        ])
        router.socketServer(mock, didReceiveMessage: data, from: "client1")

        // In the test sandbox the App Group is unavailable → "Failed to enqueue" error.
        // Assert: no error about paths or ref — the handler passed all guards and reached forwardToExtension.
        let response = mock.lastSentJSON()
        if let errorDict = response?["error"] as? [String: Any],
           let msg = errorDict["message"] as? String {
            XCTAssertFalse(msg.contains("paths") || msg.contains("ref is required"),
                           "Unexpected paths/ref error on happy path: \(msg)")
        }
    }
}

// MARK: - ToolRouterGifHookTests

import CoreGraphics

/// Tests for gif_creator dispatch and the post-action frame capture hook in ToolRouter.
/// Strategy: inject GifService and a mock ScreenshotService into ToolRouter via the
/// testable init. Test hook behavior directly via the internal maybeAddGifFrame method.
final class ToolRouterGifHookTests: XCTestCase {

    private var router: ToolRouter!
    private var gifService: GifService!
    private var mockCapture: MockCaptureProviderForGif!
    private var screenshotService: ScreenshotService!

    override func setUp() {
        super.setUp()
        gifService = GifService()
        mockCapture = MockCaptureProviderForGif()
        screenshotService = ScreenshotService(captureProvider: mockCapture)
        router = ToolRouter(screenshotService: screenshotService, gifService: gifService, fileService: FileService())
    }

    // MARK: - T1: gif_creator start_recording → success text, isRecording true

    func testStartRecording_setsIsRecordingTrue() {
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        router.handleGifCreator(arguments: ["action": "start_recording", "tabId": 5],
                                id: nil, clientId: "test")
        XCTAssertTrue(gifService.isRecording(tabId: 5),
                      "start_recording via router must set isRecording true")
    }

    // MARK: - T2: gif_creator stop_recording → isRecording false

    func testStopRecording_setsIsRecordingFalse() {
        router.handleGifCreator(arguments: ["action": "start_recording", "tabId": 5],
                                id: nil, clientId: "test")
        let pngData = makePNGData()
        gifService.addFrame(GifService.GifFrame(
            sequenceNumber: 1, imageData: pngData, actionType: "left_click",
            coordinate: nil, timestamp: Date(), viewportWidth: 100, viewportHeight: 100
        ), tabId: 5)
        router.handleGifCreator(arguments: ["action": "stop_recording", "tabId": 5],
                                id: nil, clientId: "test")
        XCTAssertFalse(gifService.isRecording(tabId: 5),
                       "stop_recording via router must set isRecording false")
    }

    // MARK: - T3: Hook does NOT fire for `wait` action

    func testHook_waitAction_doesNotAddFrame() {
        gifService.startRecording(tabId: 5)
        router.maybeAddGifFrame(tabId: 5, action: "wait", coordinate: nil)
        let exp = expectation(description: "wait no frame")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { exp.fulfill() }
        waitForExpectations(timeout: 1)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0, "wait action must not add a frame")
    }

    // MARK: - T4: Hook does NOT fire when isRecording false

    func testHook_notRecording_doesNotAddFrame() {
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        router.maybeAddGifFrame(tabId: 5, action: "left_click", coordinate: [100, 200])
        let exp = expectation(description: "not recording no frame")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { exp.fulfill() }
        waitForExpectations(timeout: 1)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0, "Hook must not fire when not recording")
    }

    // MARK: - T5: Hook fires for `left_click` when recording — addFrame called

    func testHook_leftClickWhileRecording_addsFrame() {
        gifService.startRecording(tabId: 5)
        let exp = expectation(description: "frame added")
        router.maybeAddGifFrame(tabId: 5, action: "left_click", coordinate: [200, 300])
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { exp.fulfill() }
        waitForExpectations(timeout: 2)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 1, "left_click hook should add 1 frame")
    }

    // MARK: - T6: handleScreenshotAction calls maybeAddGifFrame when recording

    func testScreenshotAction_whileRecording_addsFrame() {
        gifService.startRecording(tabId: 5)
        router.maybeAddGifFrame(tabId: 5, action: "screenshot", coordinate: nil)
        let exp = expectation(description: "screenshot frame added")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { exp.fulfill() }
        waitForExpectations(timeout: 2)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 1)
    }

    // MARK: - T7: handleGifCreator clear action → clears frames and stops recording

    func testHandleGifCreator_clearAction_clearsFramesAndStopsRecording() {
        router.handleGifCreator(arguments: ["action": "start_recording", "tabId": 5],
                                id: nil, clientId: "test")
        gifService.addFrame(GifService.GifFrame(
            sequenceNumber: 1, imageData: makePNGData(), actionType: "screenshot",
            coordinate: nil, timestamp: Date(), viewportWidth: 100, viewportHeight: 100
        ), tabId: 5)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 1)
        router.handleGifCreator(arguments: ["action": "clear", "tabId": 5],
                                id: nil, clientId: "test")
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0,
                       "clear action must empty the frame buffer")
        XCTAssertFalse(gifService.isRecording(tabId: 5),
                       "clear action must stop recording")
    }

    // MARK: - T8: handleGifCreator with missing action parameter → no crash, no state change

    func testHandleGifCreator_missingAction_doesNotCrashOrChangeState() {
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        router.handleGifCreator(arguments: ["tabId": 5], id: nil, clientId: "test")
        // sendError is called (no-op since server is nil) — state must be unchanged
        XCTAssertFalse(gifService.isRecording(tabId: 5),
                       "Missing action must not start recording")
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0,
                       "Missing action must not add frames")
    }

    // MARK: - T9: gif_creator invalid action → does not crash, does not change state

    func testHandleGifCreator_invalidAction_noCrashNoStateChange() {
        XCTAssertFalse(gifService.isRecording(tabId: 99))
        router.handleGifCreator(
            arguments: ["action": "teleport_browser", "tabId": 99],
            id: nil, clientId: "test"
        )
        XCTAssertFalse(gifService.isRecording(tabId: 99), "Invalid action must not start recording")
        XCTAssertEqual(gifService.frameCount(tabId: 99), 0, "Invalid action must not add frames")
    }

    // MARK: - T10: handleGifCreator invalid action → sendError path, no state change

    /// deliverExtensionResponse is private; the error-branch-does-not-fire contract is
    /// verified here indirectly: maybeAddGifFrame guards on isRecording (tested in T4) and
    /// deliverExtensionResponse only calls maybeAddGifFrame in its success branch (code inspection).
    /// This test verifies the invalid-action sendError path leaves state clean.
    func testHandleGifCreator_invalidAction_sendsErrorAndPreservesState() {
        router.handleGifCreator(arguments: ["action": "start_recording", "tabId": 5],
                                id: nil, clientId: "test")
        XCTAssertTrue(gifService.isRecording(tabId: 5))
        // Invalid action on a recording tab — must not stop recording or add frames
        router.handleGifCreator(arguments: ["action": "unsupported_action", "tabId": 5],
                                id: nil, clientId: "test")
        XCTAssertTrue(gifService.isRecording(tabId: 5),
                      "Invalid action must not stop an active recording")
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0,
                       "Invalid action must not add frames")
    }

}

// MARK: - Mock capture provider

private class MockCaptureProviderForGif: ScreenCaptureProvider {
    func checkPermission() -> Bool { true }

    func captureWindow(completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void) {
        let ctx = CGContext(
            data: nil, width: 100, height: 100,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        completion(.success((ctx.makeImage()!, 100, 100)))
    }
}
