// Tests/Swift/ToolRouterGifHookTests.swift
import XCTest
import CoreGraphics
@testable import ClaudeInSafari

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
        router = ToolRouter(screenshotService: screenshotService, gifService: gifService)
    }

    // MARK: - T1: gif_creator start_recording → success text, isRecording true

    func testStartRecording_setsIsRecordingTrue() {
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        let msg = gifService.startRecording(tabId: 5)
        XCTAssertTrue(gifService.isRecording(tabId: 5))
        XCTAssertTrue(msg.lowercased().contains("started"), "Got: \(msg)")
    }

    // MARK: - T2: gif_creator stop_recording → "Stopped. Captured N frames."

    func testStopRecording_returnsFrameCount() {
        gifService.startRecording(tabId: 5)
        let pngData = makePNGData()
        gifService.addFrame(GifService.GifFrame(
            sequenceNumber: 1, imageData: pngData, actionType: "left_click",
            coordinate: nil, timestamp: Date(), viewportWidth: 100, viewportHeight: 100
        ), tabId: 5)
        gifService.addFrame(GifService.GifFrame(
            sequenceNumber: 2, imageData: pngData, actionType: "scroll",
            coordinate: nil, timestamp: Date(), viewportWidth: 100, viewportHeight: 100
        ), tabId: 5)
        let msg = gifService.stopRecording(tabId: 5)
        XCTAssertTrue(msg.contains("2 frame"), "Got: \(msg)")
        XCTAssertFalse(gifService.isRecording(tabId: 5))
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

    // MARK: - T7: gif_creator export → produces image/gif data

    func testExportGIF_withFrames_producesGIFData() {
        gifService.startRecording(tabId: 5)
        gifService.addFrame(GifService.GifFrame(
            sequenceNumber: 1, imageData: makePNGData(), actionType: "left_click",
            coordinate: [100, 100], timestamp: Date(), viewportWidth: 100, viewportHeight: 100
        ), tabId: 5)
        let result = gifService.exportGIF(tabId: 5, options: .init(), filename: "test.gif")
        guard case .success(let data) = result else {
            XCTFail("Export should succeed with frames"); return
        }
        let header = String(bytes: data.prefix(4), encoding: .ascii)
        XCTAssertEqual(header, "GIF8")
    }

    // MARK: - T8: gif_creator export with no frames → isError: true

    func testExportGIF_noFrames_returnsFailure() {
        let result = gifService.exportGIF(tabId: 5, options: .init(), filename: "test.gif")
        if case .failure(let err) = result {
            XCTAssertTrue(err.localizedDescription.lowercased().contains("no frames"))
        } else {
            XCTFail("Expected failure")
        }
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

    // MARK: - T10: Hook does NOT fire when isRecording false (mirrors error-response path)

    func testHook_isRecordingFalse_doesNotCapture() {
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        router.maybeAddGifFrame(tabId: 5, action: "left_click", coordinate: nil)
        let exp = expectation(description: "no capture")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { exp.fulfill() }
        waitForExpectations(timeout: 1)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0)
    }

    // MARK: - PNG helper

    private func makePNGData() -> Data {
        let ctx = CGContext(
            data: nil, width: 10, height: 10,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        let image = ctx.makeImage()!
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)
        return data as Data
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
