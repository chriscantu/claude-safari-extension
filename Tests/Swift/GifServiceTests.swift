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
}
