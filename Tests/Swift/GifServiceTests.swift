// Tests/Swift/GifServiceTests.swift
import XCTest
import CoreGraphics
import ImageIO
@testable import ClaudeInSafari

final class GifServiceTests: XCTestCase {

    private var service: GifService!

    override func setUp() {
        super.setUp()
        service = GifService()
    }

    // MARK: - Helpers

    private func makePNGData(width: Int = 10, height: Int = 10) -> Data {
        let ctx = CGContext(
            data: nil, width: width, height: height,
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

    private func makeFrame(seq: Int, action: String = "left_click",
                           coord: [Int]? = [100, 200],
                           timestamp: Date = Date()) -> GifService.GifFrame {
        GifService.GifFrame(
            sequenceNumber: seq,
            imageData: makePNGData(),
            actionType: action,
            coordinate: coord,
            timestamp: timestamp,
            viewportWidth: 1280,
            viewportHeight: 800
        )
    }

    // MARK: - T1: start/stop recording state

    func testStartStopRecording_stateTransitions() {
        XCTAssertFalse(service.isRecording(tabId: 1))
        let startMsg = service.startRecording(tabId: 1)
        XCTAssertTrue(service.isRecording(tabId: 1))
        XCTAssertTrue(startMsg.lowercased().contains("started"), "Got: \(startMsg)")
        let stopMsg = service.stopRecording(tabId: 1)
        XCTAssertFalse(service.isRecording(tabId: 1))
        XCTAssertTrue(stopMsg.lowercased().contains("stopped"), "Got: \(stopMsg)")
    }

    // MARK: - T2: startRecording twice → "already active"

    func testStartRecording_twice_returnsAlreadyActive() {
        service.startRecording(tabId: 2)
        let msg = service.startRecording(tabId: 2)
        XCTAssertTrue(service.isRecording(tabId: 2), "Should still be recording")
        XCTAssertTrue(msg.lowercased().contains("already"), "Got: \(msg)")
    }

    // MARK: - T3: stopRecording when not recording → "not active"

    func testStopRecording_whenNotRecording_returnsNotActive() {
        XCTAssertFalse(service.isRecording(tabId: 3))
        let msg = service.stopRecording(tabId: 3)
        XCTAssertTrue(msg.lowercased().contains("not"), "Got: \(msg)")
    }

    // MARK: - T4: 50-frame ring buffer eviction

    func testAddFrame_50thFrame_ringBufferFull() {
        service.startRecording(tabId: 4)
        for i in 1...50 {
            service.addFrame(makeFrame(seq: i), tabId: 4)
        }
        XCTAssertEqual(service.frameCount(tabId: 4), 50)
    }

    func testAddFrame_51stFrame_evictsOldest() {
        service.startRecording(tabId: 4)
        for i in 1...51 {
            service.addFrame(makeFrame(seq: i), tabId: 4)
        }
        XCTAssertEqual(service.frameCount(tabId: 4), 50, "Ring buffer should hold exactly 50 frames")
    }

    // MARK: - T8: clearFrames stops recording and empties buffer

    func testClearFrames_stopsRecordingAndClearsBuffer() {
        service.startRecording(tabId: 8)
        service.addFrame(makeFrame(seq: 1), tabId: 8)
        XCTAssertEqual(service.frameCount(tabId: 8), 1)
        let msg = service.clearFrames(tabId: 8)
        XCTAssertEqual(service.frameCount(tabId: 8), 0)
        XCTAssertFalse(service.isRecording(tabId: 8))
        XCTAssertTrue(msg.lowercased().contains("clear"), "Got: \(msg)")
    }

    // MARK: - T9: concurrent addFrame → no crash

    func testConcurrentAddFrame_noCrash() {
        service.startRecording(tabId: 9)
        let group = DispatchGroup()
        for i in 1...20 {
            group.enter()
            DispatchQueue.global().async {
                self.service.addFrame(self.makeFrame(seq: i), tabId: 9)
                group.leave()
            }
        }
        group.wait()
        XCTAssertLessThanOrEqual(service.frameCount(tabId: 9), 20)
    }

    // MARK: - T5: exportGIF with zero frames → .failure

    func testExportGIF_noFrames_returnsFailure() {
        let result = service.exportGIF(tabId: 5, options: .init(), filename: "test.gif")
        if case .failure(let err) = result {
            XCTAssertTrue(err.localizedDescription.lowercased().contains("no frames"), "Got: \(err.localizedDescription)")
        } else {
            XCTFail("Expected failure for empty buffer")
        }
    }

    // MARK: - T6: exportGIF produces valid GIF magic bytes ("GIF8")

    func testExportGIF_producesGIFMagicBytes() {
        service.startRecording(tabId: 6)
        service.addFrame(makeFrame(seq: 1), tabId: 6)
        let result = service.exportGIF(tabId: 6, options: .init(), filename: "test.gif")
        guard case .success(let data) = result else {
            XCTFail("Expected success, got \(result)"); return
        }
        XCTAssertGreaterThan(data.count, 6, "GIF should have more than 6 bytes")
        let header = String(bytes: data.prefix(4), encoding: .ascii)
        XCTAssertEqual(header, "GIF8", "GIF magic bytes missing, got: \(header ?? "nil")")
    }

    // MARK: - T7: mid-sequence delay = elapsed time clamped to [0.3, 3.0]s

    func testExportGIF_midSequenceDelay_usesElapsedTime() {
        let now = Date()
        service.startRecording(tabId: 71)
        service.addFrame(makeFrame(seq: 1, timestamp: now), tabId: 71)
        service.addFrame(makeFrame(seq: 2, timestamp: now.addingTimeInterval(1.0)), tabId: 71)
        service.addFrame(makeFrame(seq: 3, timestamp: now.addingTimeInterval(1.5)), tabId: 71)

        guard case .success(let data) = service.exportGIF(tabId: 71, options: .init(), filename: "t.gif"),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            XCTFail("Export failed"); return
        }
        // Frame 0 (→ frame 1): elapsed 1.0s
        if let delay = gifDelay(source: source, index: 0) {
            XCTAssertEqual(delay, 1.0, accuracy: 0.05, "Frame 0 delay should be ~1.0s")
        } else {
            XCTFail("Could not read frame 0 delay")
        }
        // Frame 1 (→ frame 2): elapsed 0.5s
        if let delay = gifDelay(source: source, index: 1) {
            XCTAssertEqual(delay, 0.5, accuracy: 0.05, "Frame 1 delay should be ~0.5s")
        }
    }

    func testExportGIF_midSequenceDelay_clampedToMinimum() {
        let now = Date()
        service.startRecording(tabId: 72)
        service.addFrame(makeFrame(seq: 1, timestamp: now), tabId: 72)
        // 0.05s elapsed < 0.3s minimum → clamped to 0.3
        service.addFrame(makeFrame(seq: 2, timestamp: now.addingTimeInterval(0.05)), tabId: 72)
        service.addFrame(makeFrame(seq: 3, timestamp: now.addingTimeInterval(1.0)), tabId: 72)

        guard case .success(let data) = service.exportGIF(tabId: 72, options: .init(), filename: "t.gif"),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            XCTFail("Export failed"); return
        }
        if let delay = gifDelay(source: source, index: 0) {
            XCTAssertEqual(delay, 0.3, accuracy: 0.05, "Should clamp 0.05s to 0.3s minimum")
        }
    }

    // MARK: - T7b: last frame always uses 3.0s delay

    func testExportGIF_lastFrame_alwaysThreeSeconds() {
        let now = Date()
        service.startRecording(tabId: 7)
        service.addFrame(makeFrame(seq: 1, timestamp: now), tabId: 7)
        service.addFrame(makeFrame(seq: 2, timestamp: now.addingTimeInterval(0.5)), tabId: 7)

        guard case .success(let data) = service.exportGIF(tabId: 7, options: .init(), filename: "t.gif"),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            XCTFail("Export failed"); return
        }
        let lastIndex = CGImageSourceGetCount(source) - 1
        if let delay = gifDelay(source: source, index: lastIndex) {
            XCTAssertEqual(delay, 3.0, accuracy: 0.05, "Last frame delay must be 3.0s")
        } else {
            XCTFail("Could not read last frame delay")
        }
    }

    // MARK: - T7c: single-frame export uses last-frame 3.0s rule

    func testExportGIF_singleFrame_usesLastFrameDelay() {
        service.startRecording(tabId: 73)
        service.addFrame(makeFrame(seq: 1, action: "screenshot"), tabId: 73)

        guard case .success(let data) = service.exportGIF(tabId: 73, options: .init(), filename: "t.gif"),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            XCTFail("Export failed"); return
        }
        // Single frame = last frame → always 3.0s (last-frame hold overrides all other rules)
        if let delay = gifDelay(source: source, index: 0) {
            XCTAssertEqual(delay, 3.0, accuracy: 0.05, "Single frame should use last-frame 3.0s hold")
        }
    }

    // MARK: - T10: exportGIF concurrent with addFrame → no data race

    func testExportGIF_concurrentWithAddFrame_noDataRace() {
        service.startRecording(tabId: 10)
        for i in 1...10 {
            service.addFrame(makeFrame(seq: i), tabId: 10)
        }
        let group = DispatchGroup()
        var exportResult: Result<Data, Error>?

        group.enter()
        DispatchQueue.global().async {
            exportResult = self.service.exportGIF(tabId: 10, options: .init(), filename: "t.gif")
            group.leave()
        }
        for i in 11...20 {
            group.enter()
            DispatchQueue.global().async {
                self.service.addFrame(self.makeFrame(seq: i), tabId: 10)
                group.leave()
            }
        }
        group.wait()
        if case .success(let data) = exportResult {
            let header = String(bytes: data.prefix(4), encoding: .ascii)
            XCTAssertEqual(header, "GIF8")
        } else {
            XCTFail("Concurrent export should succeed")
        }
    }

    // MARK: - T11: out-of-order sequenceNumbers sorted correctly

    func testExportGIF_outOfOrderSequenceNumbers_sortedInExport() {
        service.startRecording(tabId: 11)
        // Add frames out of order (seq 3, 1, 2)
        service.addFrame(makeFrame(seq: 3, action: "screenshot"), tabId: 11)
        service.addFrame(makeFrame(seq: 1, action: "left_click"), tabId: 11)
        service.addFrame(makeFrame(seq: 2, action: "scroll"), tabId: 11)

        guard case .success(let data) = service.exportGIF(tabId: 11, options: .init(), filename: "t.gif") else {
            XCTFail("Expected success"); return
        }
        let header = String(bytes: data.prefix(4), encoding: .ascii)
        XCTAssertEqual(header, "GIF8")
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return }
        XCTAssertEqual(CGImageSourceGetCount(source), 3)
    }

    // MARK: - T12: exportGIF with showClicks:false → no crash

    func testExportGIF_showClicksFalse_noCrash() {
        service.startRecording(tabId: 12)
        service.addFrame(makeFrame(seq: 1, coord: [500, 300]), tabId: 12)
        var opts = GifService.GifOptions()
        opts.showClicks = false
        let result = service.exportGIF(tabId: 12, options: opts, filename: "t.gif")
        guard case .success(let data) = result else {
            XCTFail("Expected success"); return
        }
        let header = String(bytes: data.prefix(4), encoding: .ascii)
        XCTAssertEqual(header, "GIF8")
    }

    // MARK: - Helper: read GIF frame delay from CGImageSource

    private func gifDelay(source: CGImageSource, index: Int) -> Double? {
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [String: Any],
              let gifProps = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] else {
            return nil
        }
        return gifProps[kCGImagePropertyGIFUnclampedDelayTime as String] as? Double
            ?? gifProps[kCGImagePropertyGIFDelayTime as String] as? Double
    }
}
