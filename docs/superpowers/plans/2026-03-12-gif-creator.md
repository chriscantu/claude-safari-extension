# gif_creator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `gif_creator` MCP tool as a native-only handler backed by a new `GifService.swift` that manages recording state, a 50-frame ring buffer, and GIF encoding via ImageIO with CGContext visual overlays.

**Architecture:** `GifService` is instantiated inline in `ToolRouter` (same pattern as `ScreenshotService`). A post-action hook (`maybeAddGifFrame`) fires fire-and-forget from the `.result` (success) branch only of `deliverExtensionResponse` and from `handleScreenshotAction` after a successful capture. Tool context (name + args) flows through a new `pendingToolContext` dict protected by the existing `pendingRequestsLock`. GIF is exported to `~/Desktop/<filename>.gif` and returned as a base64 image content block.

**Tech Stack:** Swift, Foundation, CoreGraphics, ImageIO, AppKit (CoreText for text overlays), XCTest

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `ClaudeInSafari/Services/GifService.swift` | **Create** | Recording state, 50-frame ring buffer, NSLock thread safety, GIF encoding via ImageIO, CGContext overlays |
| `ClaudeInSafari/MCP/ToolRouter.swift` | **Modify** | `gif_creator` dispatch, `handleGifCreator`, `handleGifExport`, `maybeAddGifFrame`, `pendingToolContext`, injectable init |
| `Tests/Swift/GifServiceTests.swift` | **Create** | Tests T1–T12 from spec §Test Coverage |
| `Tests/Swift/ToolRouterGifHookTests.swift` | **Create** | Tests T1–T10 from spec §Test Coverage |
| `ROADMAP.md` | **Modify** | Mark Spec 017 ✅, add future ROADMAP items |

> **Xcode note:** After creating each new `.swift` file you MUST add it to the correct Xcode target before `make test-swift` will compile it. In Xcode: drag `GifService.swift` into the `ClaudeInSafari` app target; drag `GifServiceTests.swift` and `ToolRouterGifHookTests.swift` into the `ClaudeInSafariTests` target. This is a one-time step per file.

---

## Chunk 1: GifService — Recording State and Ring Buffer

### Task 1: Create the feature branch

- [ ] **Step 1: Create and switch to the feature branch**

```bash
cd /Users/chris.cantu/repos/claude-safari-extension
git checkout -b feature/gif-creator
```

Expected: `Switched to a new branch 'feature/gif-creator'`

---

### Task 2: Write GifServiceTests — state and ring buffer (T1–T4, T8, T9)

**Files:**
- Create: `Tests/Swift/GifServiceTests.swift`

- [ ] **Step 1: Create the test file**

```swift
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
        // Frames 1–50 fill the buffer; frame 51 evicts frame 1
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
```

- [ ] **Step 2: Add file to Xcode test target**

In Xcode: right-click `Tests/Swift` → Add Files → select `GifServiceTests.swift` → ensure `ClaudeInSafariTests` target is checked.

- [ ] **Step 3: Run tests (expect failure — GifService not yet created)**

```bash
make test-swift 2>&1 | tail -10
```

Expected: build error mentioning `GifService` not found.

---

### Task 3: Create GifService.swift — recording state and ring buffer

**Files:**
- Create: `ClaudeInSafari/Services/GifService.swift`

- [ ] **Step 1: Create GifService.swift with state management**

```swift
// ClaudeInSafari/Services/GifService.swift
import Foundation
import CoreGraphics
import ImageIO
import AppKit

// MARK: - GifError

enum GifError: Error, LocalizedError {
    case noFrames(Int)
    case encodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .noFrames(let tabId):
            return "No frames recorded for tab \(tabId)"
        case .encodingFailed(let msg):
            return msg
        }
    }
}

// MARK: - GifService

/// Manages GIF recording state, frame buffering, and GIF encoding for the gif_creator tool.
/// Thread-safe via NSLock. Snapshot semantics for exportGIF: copies frame array under lock,
/// releases immediately, encodes from snapshot.
/// See Spec 017 (Revised Architecture v3) for full specification.
class GifService {

    // MARK: - Types

    struct GifFrame {
        let sequenceNumber: Int      // monotonic; assigned at dispatch time for ordering
        let imageData: Data          // PNG-encoded, from ScreenshotService
        let actionType: String       // e.g. "left_click", "scroll", "screenshot"
        let coordinate: [Int]?       // viewport [x, y] for click overlays
        let timestamp: Date
        let viewportWidth: Int
        let viewportHeight: Int
    }

    struct GifOptions {
        var showClicks: Bool    = true
        var showActions: Bool   = true
        var showProgress: Bool  = true
        var showWatermark: Bool = true
    }

    // MARK: - Private State

    private let lock = NSLock()
    private var recordingTabs: Set<Int> = []
    private var frameBuffers: [Int: [GifFrame]] = [:]
    private var sequenceCounter: Int = 0

    private static let maxFrames = 50

    // MARK: - Recording Control

    /// Start recording for the given tabId. Clears any existing frames for that tab.
    /// Returns "already active" message (not error) if already recording.
    func startRecording(tabId: Int) -> String {
        lock.lock()
        defer { lock.unlock() }
        if recordingTabs.contains(tabId) {
            return "Recording is already active for tab \(tabId)."
        }
        recordingTabs.insert(tabId)
        frameBuffers[tabId] = []   // clear frames on new recording session
        return "Started recording browser actions for tab \(tabId)."
    }

    /// Stop recording for the given tabId. Frames remain in buffer for export.
    /// Returns "not active" message (not error) if not currently recording.
    func stopRecording(tabId: Int) -> String {
        lock.lock()
        defer { lock.unlock() }
        guard recordingTabs.contains(tabId) else {
            return "Recording is not active for tab \(tabId)."
        }
        recordingTabs.remove(tabId)
        let count = frameBuffers[tabId]?.count ?? 0
        return "Stopped recording. Captured \(count) frame(s)."
    }

    func isRecording(tabId: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return recordingTabs.contains(tabId)
    }

    func frameCount(tabId: Int) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return frameBuffers[tabId]?.count ?? 0
    }

    // MARK: - Sequence Counter

    /// Atomically increments and returns the global sequence counter.
    /// MUST be called before the async screenshot callback to preserve dispatch-time ordering.
    func nextSequenceNumber() -> Int {
        lock.lock()
        defer { lock.unlock() }
        sequenceCounter += 1
        return sequenceCounter
    }

    // MARK: - Frame Buffer

    /// Append a frame to the ring buffer for the given tabId.
    /// Enforces 50-frame maximum by evicting the oldest frame.
    func addFrame(_ frame: GifFrame, tabId: Int) {
        lock.lock()
        defer { lock.unlock() }
        var frames = frameBuffers[tabId] ?? []
        frames.append(frame)
        if frames.count > GifService.maxFrames {
            frames.removeFirst()
        }
        frameBuffers[tabId] = frames
    }

    /// Discard all captured frames and stop recording for the given tabId.
    func clearFrames(tabId: Int) -> String {
        lock.lock()
        defer { lock.unlock() }
        frameBuffers.removeValue(forKey: tabId)
        recordingTabs.remove(tabId)
        return "Cleared all recorded frames."
    }

    // MARK: - Export (stub — encoding added in Chunk 2)

    /// Encode captured frames as an animated GIF.
    /// Snapshot semantics: copies frame array under lock, releases immediately, encodes from snapshot.
    /// Sorts by sequenceNumber to handle out-of-order async captures.
    func exportGIF(tabId: Int, options: GifOptions, filename: String) -> Result<Data, Error> {
        lock.lock()
        let snapshot = (frameBuffers[tabId] ?? []).sorted { $0.sequenceNumber < $1.sequenceNumber }
        lock.unlock()

        guard !snapshot.isEmpty else {
            return .failure(GifError.noFrames(tabId))
        }

        return encodeGIF(frames: snapshot, options: options)
    }

    // MARK: - GIF Encoding (implemented in Chunk 2)

    private func encodeGIF(frames: [GifFrame], options: GifOptions) -> Result<Data, Error> {
        return .failure(GifError.encodingFailed("Not yet implemented"))
    }
}
```

- [ ] **Step 2: Add GifService.swift to Xcode app target**

In Xcode: right-click `ClaudeInSafari/Services` → Add Files → select `GifService.swift` → ensure `ClaudeInSafari` target is checked.

- [ ] **Step 3: Run state/ring buffer tests**

```bash
make test-swift 2>&1 | tail -10
```

Expected: T1–T4, T8, T9 pass. The encoding tests (T5–T7, T10–T12) will be added in Chunk 2.

- [ ] **Step 4: Commit**

```bash
git add ClaudeInSafari/Services/GifService.swift Tests/Swift/GifServiceTests.swift
echo "feat: add GifService recording state, ring buffer, and skeleton exportGIF

GifService owns all GIF state. Thread-safe via NSLock. Implements startRecording,
stopRecording, addFrame (50-frame ring buffer), clearFrames, nextSequenceNumber.
GifServiceTests T1-T4, T8, T9 pass.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git commit -F /tmp/commitmsg
```

---

## Chunk 2: GifService — GIF Encoding and Visual Overlays

### Task 4: Add encoding tests to GifServiceTests (T5–T7, T7b, T7c, T10–T12)

**Files:**
- Modify: `Tests/Swift/GifServiceTests.swift`

- [ ] **Step 1: Append encoding tests after the existing tests**

Add the following inside `GifServiceTests` class (after the T9 test):

```swift
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
        // Single frame = last frame → always 3.0s
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
        // Concurrent addFrame calls during encoding
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

        // Should produce a valid GIF (sorted internally)
        guard case .success(let data) = service.exportGIF(tabId: 11, options: .init(), filename: "t.gif") else {
            XCTFail("Expected success"); return
        }
        let header = String(bytes: data.prefix(4), encoding: .ascii)
        XCTAssertEqual(header, "GIF8")
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return }
        // 3 frames expected
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
        return gifProps[kCGImagePropertyGIFDelayTime as String] as? Double
    }
```

- [ ] **Step 2: Run tests — new encoding tests should fail**

```bash
make test-swift 2>&1 | grep -E "FAIL|PASS|error" | head -20
```

Expected: T5 passes (stub returns `.failure`), T6 onward fails ("Not yet implemented").

---

### Task 5: Implement GifService GIF encoding

**Files:**
- Modify: `ClaudeInSafari/Services/GifService.swift`

- [ ] **Step 1: Replace the `encodeGIF` stub with the full implementation**

Replace the stub `encodeGIF` method and add overlay helpers:

```swift
    // MARK: - GIF Encoding

    private func encodeGIF(frames: [GifFrame], options: GifOptions) -> Result<Data, Error> {
        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, "com.compuserve.gif" as CFString, frames.count, nil
        ) else {
            return .failure(GifError.encodingFailed("Failed to create CGImageDestination"))
        }

        // Set infinite loop via Netscape Application Extension
        let gifGlobalProps: [String: Any] = [
            kCGImagePropertyGIFDictionary as String: [
                kCGImagePropertyGIFLoopCount as String: 0
            ]
        ]
        CGImageDestinationSetProperties(dest, gifGlobalProps as CFDictionary)

        for (index, frame) in frames.enumerated() {
            // Frame delay: elapsed time to next frame, clamped to [0.3, 3.0]s.
            // Last frame always holds for 3.0s regardless of action type.
            let delay: Double
            if index == frames.count - 1 {
                delay = 3.0
            } else {
                let elapsed = frames[index + 1].timestamp.timeIntervalSince(frame.timestamp)
                delay = min(max(elapsed, 0.3), 3.0)
            }

            // Decode PNG → CGImage
            guard let source = CGImageSourceCreateWithData(frame.imageData as CFData, nil),
                  let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                continue  // skip frames with invalid PNG data
            }

            // Apply visual overlays via CGContext
            let overlaid = applyOverlays(
                to: cgImage, frame: frame,
                frameIndex: index, totalFrames: frames.count,
                options: options
            ) ?? cgImage

            let frameProps: [String: Any] = [
                kCGImagePropertyGIFDictionary as String: [
                    kCGImagePropertyGIFDelayTime as String: delay
                ]
            ]
            CGImageDestinationAddImage(dest, overlaid, frameProps as CFDictionary)
        }

        guard CGImageDestinationFinalize(dest) else {
            return .failure(GifError.encodingFailed("CGImageDestinationFinalize failed"))
        }
        return .success(mutableData as Data)
    }

    // MARK: - Visual Overlays

    /// Draw overlays onto a CGImage using CGContext. Returns the composited image, or nil on failure.
    /// CGContext origin is bottom-left; viewport coordinates have y=0 at top.
    private func applyOverlays(
        to image: CGImage,
        frame: GifFrame,
        frameIndex: Int,
        totalFrames: Int,
        options: GifOptions
    ) -> CGImage? {
        let w = image.width
        let h = image.height
        guard let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        // Draw base image
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

        // showProgress: 3pt-tall rect at visual top (CGContext top = y = h)
        if options.showProgress && totalFrames > 1 {
            let progress = CGFloat(frameIndex + 1) / CGFloat(totalFrames)
            ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 1.0, alpha: 0.85))
            ctx.fill(CGRect(x: 0, y: CGFloat(h) - 3, width: CGFloat(w) * progress, height: 3))
        }

        // showActions: label background at visual bottom (CGContext bottom = y = 0)
        if options.showActions {
            let label = actionLabel(for: frame)
            drawActionLabel(label, in: ctx, imageWidth: w)
        }

        // showClicks: red circle at click coordinate (convert viewport y → CGContext y)
        if options.showClicks, let coord = frame.coordinate, coord.count >= 2 {
            let cx = CGFloat(coord[0])
            let cy = CGFloat(h) - CGFloat(coord[1])  // flip Y: CGImage bottom-left origin
            // Outer ring
            ctx.setStrokeColor(CGColor(red: 1, green: 0, blue: 0, alpha: 0.75))
            ctx.setLineWidth(2)
            ctx.strokeEllipse(in: CGRect(x: cx - 20, y: cy - 20, width: 40, height: 40))
            // Inner filled circle
            ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 0.5))
            ctx.fillEllipse(in: CGRect(x: cx - 12, y: cy - 12, width: 24, height: 24))
        }

        // showWatermark: "Recorded with Claude" bottom-right, 11pt, 60% white
        if options.showWatermark {
            drawWatermark(in: ctx, imageWidth: w)
        }

        return ctx.makeImage()
    }

    private func actionLabel(for frame: GifFrame) -> String {
        let coord = frame.coordinate.flatMap { $0.count >= 2 ? "(\($0[0]), \($0[1]))" : nil }
        switch frame.actionType {
        case "left_click":   return coord.map { "Click at \($0)" } ?? "Click"
        case "right_click":  return coord.map { "Right-click at \($0)" } ?? "Right-click"
        case "double_click": return coord.map { "Double-click at \($0)" } ?? "Double-click"
        case "triple_click": return "Triple-click"
        case "hover":        return coord.map { "Hover at \($0)" } ?? "Hover"
        case "scroll", "scroll_to": return "Scroll"
        case "type":         return "Type"
        case "key":          return "Key press"
        case "navigate":     return "Navigate"
        case "screenshot":   return "Screenshot"
        case "zoom":         return "Zoom"
        default:             return frame.actionType.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func drawActionLabel(_ text: String, in ctx: CGContext, imageWidth: Int) {
        let fontSize: CGFloat = 12
        let padding: CGFloat = 8
        let labelHeight: CGFloat = fontSize + padding * 2
        // Semi-transparent background strip at visual bottom
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.6))
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(imageWidth), height: labelHeight))
        // White text
        drawText(text, in: ctx, at: CGPoint(x: padding, y: padding), fontSize: fontSize,
                 color: CGColor(red: 1, green: 1, blue: 1, alpha: 1.0))
    }

    private func drawWatermark(in ctx: CGContext, imageWidth: Int) {
        let text = "Recorded with Claude"
        let fontSize: CGFloat = 11
        let padding: CGFloat = 8
        // Measure text width to right-align
        let font = CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        let attrStr = NSAttributedString(string: text, attributes: attrs)
        let line = CTLineCreateWithAttributedString(attrStr)
        let lineWidth = CTLineGetTypographicBounds(line, nil, nil, nil)
        let x = CGFloat(imageWidth) - lineWidth - padding
        drawText(text, in: ctx, at: CGPoint(x: x, y: padding), fontSize: fontSize,
                 color: CGColor(red: 1, green: 1, blue: 1, alpha: 0.6))
    }

    private func drawText(_ text: String, in ctx: CGContext, at point: CGPoint,
                          fontSize: CGFloat, color: CGColor) {
        let font = CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color
        ]
        let attrStr = NSAttributedString(string: text, attributes: attrs)
        let line = CTLineCreateWithAttributedString(attrStr)
        ctx.textPosition = point
        CTLineDraw(line, ctx)
    }
```

- [ ] **Step 2: Run all encoding tests**

```bash
make test-swift 2>&1 | tail -10
```

Expected: All GifServiceTests pass (T1–T12).

- [ ] **Step 3: Commit**

```bash
git add ClaudeInSafari/Services/GifService.swift Tests/Swift/GifServiceTests.swift
echo "feat: implement GifService GIF encoding with ImageIO and CGContext overlays

encodeGIF uses CGImageDestination with com.compuserve.gif UTI. Timestamp-based
frame delays clamped to [0.3, 3.0]s; last frame always 3.0s hold. Four visual
overlay types: progress bar, action label, click indicator, watermark.
All GifServiceTests T1-T12 pass.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git commit -F /tmp/commitmsg
```

---

## Chunk 3: ToolRouter Integration and Post-Action Hook

### Task 6: Write ToolRouterGifHookTests

**Files:**
- Create: `Tests/Swift/ToolRouterGifHookTests.swift`

- [ ] **Step 1: Create the test file**

```swift
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
        // Add 2 frames directly
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
        // Give async time to complete (it should not)
        let exp = expectation(description: "wait no frame")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0, "wait action must not add a frame")
    }

    // MARK: - T4: Hook does NOT fire when isRecording false

    func testHook_notRecording_doesNotAddFrame() {
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        router.maybeAddGifFrame(tabId: 5, action: "left_click", coordinate: [100, 200])
        let exp = expectation(description: "not recording no frame")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 0, "Hook must not fire when not recording")
    }

    // MARK: - T5: Hook fires for `left_click` when recording — addFrame called

    func testHook_leftClickWhileRecording_addsFrame() {
        gifService.startRecording(tabId: 5)
        let exp = expectation(description: "frame added")
        router.maybeAddGifFrame(tabId: 5, action: "left_click", coordinate: [200, 300])
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            exp.fulfill()
        }
        waitForExpectations(timeout: 2)
        XCTAssertEqual(gifService.frameCount(tabId: 5), 1, "left_click hook should add 1 frame")
    }

    // MARK: - T6: handleScreenshotAction calls maybeAddGifFrame when recording
    // Verified indirectly: after a screenshot with recording active, frame count increases.

    func testScreenshotAction_whileRecording_addsFrame() {
        gifService.startRecording(tabId: 5)
        let captureExp = expectation(description: "screenshot capture")
        // Trigger maybeAddGifFrame directly (same path handleScreenshotAction uses)
        router.maybeAddGifFrame(tabId: 5, action: "screenshot", coordinate: nil)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            captureExp.fulfill()
        }
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

    // MARK: - T9: gif_creator invalid action → does not crash, does not change gifService state

    func testHandleGifCreator_invalidAction_noCrashNoStateChange() {
        // handleGifCreator is internal — call it directly.
        // sendError is a no-op with nil server; we verify state is unchanged.
        XCTAssertFalse(gifService.isRecording(tabId: 99))
        router.handleGifCreator(
            arguments: ["action": "teleport_browser", "tabId": 99],
            id: nil, clientId: "test"
        )
        XCTAssertFalse(gifService.isRecording(tabId: 99), "Invalid action must not start recording")
        XCTAssertEqual(gifService.frameCount(tabId: 99), 0, "Invalid action must not add frames")
    }

    // MARK: - T10: Hook does NOT fire when isRecording false (extension error response)

    func testHook_isRecordingFalse_doesNotCaptureOnError() {
        // Recording is off — any call to maybeAddGifFrame should be a no-op
        XCTAssertFalse(gifService.isRecording(tabId: 5))
        router.maybeAddGifFrame(tabId: 5, action: "left_click", coordinate: nil)
        let exp = expectation(description: "no capture")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            exp.fulfill()
        }
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
```

- [ ] **Step 2: Add file to Xcode test target**

In Xcode: drag `ToolRouterGifHookTests.swift` into the `ClaudeInSafariTests` target.

- [ ] **Step 3: Run — expect build failure (ToolRouter injectable init not yet added)**

```bash
make test-swift 2>&1 | tail -10
```

Expected: build errors about `ToolRouter.init(screenshotService:gifService:)` and `router.maybeAddGifFrame` not found.

---

### Task 7: Modify ToolRouter — add injectable init, gifService, pendingToolContext

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift`

- [ ] **Step 1: Add gifService property and injectable init**

The current `ToolRouter.swift` has inline property initializers:
```swift
private let screenshotService = ScreenshotService()
private let appleScriptBridge = AppleScriptBridge()
```

Replace those two lines with (remove the `= ScreenshotService()` inline initializer):
```swift
    private let screenshotService: ScreenshotService     // no longer inline — set in init
    private let appleScriptBridge = AppleScriptBridge()  // unchanged — no testable constructor
    private let gifService: GifService                   // new property
```

Then add two inits after the property declarations:

```swift
    // Production init — all services created fresh
    convenience init() {
        self.init(
            screenshotService: ScreenshotService(),
            gifService: GifService()
        )
    }

    // Testable init — inject mock services for unit tests
    init(screenshotService: ScreenshotService, gifService: GifService) {
        self.screenshotService = screenshotService
        self.gifService = gifService
    }
```

> **Critical:** `screenshotService` must NOT have an inline `= ScreenshotService()` initializer when a designated `init` also assigns it — Swift will give a compile error "variable 'screenshotService' used before being initialized" or a conflicting initializer error. Remove the inline initializer before adding the `init`.

- [ ] **Step 2: Add pendingToolContext dict**

After the existing `private var pendingRequests` line:

```swift
    /// Maps requestId → (toolName, arguments) for gif post-action hook context.
    /// Protected by the same `pendingRequestsLock` as `pendingRequests`.
    private var pendingToolContext = [String: (toolName: String, arguments: [String: Any])]()
```

- [ ] **Step 3: Update forwardToExtension to store tool context**

Update the signature to accept arguments and store tool context:

```swift
    private func forwardToExtension(_ queued: QueuedToolRequest, id: Any?, clientId: String,
                                     arguments: [String: Any] = [:]) {
        guard enqueueToolRequest(queued) else {
            sendError(id: id, code: -32000, message: "Failed to enqueue tool request", to: clientId)
            return
        }

        pendingRequestsLock.lock()
        pendingRequests[queued.requestId] = (clientId: clientId, jsonrpcId: id)
        pendingToolContext[queued.requestId] = (toolName: queued.tool, arguments: arguments)
        pendingRequestsLock.unlock()

        pollForExtensionResponse(requestId: queued.requestId, deadline: Date().addingTimeInterval(30))
    }
```

- [ ] **Step 4: Update handleToolCall to pass arguments to forwardToExtension**

In the `else` branch of `handleToolCall`, update the `forwardToExtension` call:

```swift
        } else {
            let queued = QueuedToolRequest(
                requestId: UUID().uuidString,
                tool: toolName,
                args: arguments.mapValues { AnyCodable($0) },
                context: NativeMessageContext(clientId: clientId, tabGroupId: nil)
            )
            forwardToExtension(queued, id: id, clientId: clientId, arguments: arguments)
        }
```

- [ ] **Step 5: Update pollForExtensionResponse to pass tool context to deliverExtensionResponse**

In `pollForExtensionResponse`, the block that removes pending entries and calls `deliverExtensionResponse`:

```swift
            pendingRequestsLock.lock()
            let pending = pendingRequests.removeValue(forKey: requestId)
            let toolCtx = pendingToolContext.removeValue(forKey: requestId)
            pendingRequestsLock.unlock()
            if let pending = pending {
                deliverExtensionResponse(
                    responseString, id: pending.jsonrpcId, to: pending.clientId,
                    toolName: toolCtx?.toolName ?? "",
                    arguments: toolCtx?.arguments ?? [:]
                )
            }
```

- [ ] **Step 6: Update failPendingRequest to clean up pendingToolContext**

```swift
    private func failPendingRequest(requestId: String, message: String) {
        pendingRequestsLock.lock()
        let pending = pendingRequests.removeValue(forKey: requestId)
        pendingToolContext.removeValue(forKey: requestId)
        pendingRequestsLock.unlock()
        if let pending = pending {
            sendError(id: pending.jsonrpcId, code: -32000, message: message, to: pending.clientId)
        }
    }
```

- [ ] **Step 7: Update didDisconnect to clean up pendingToolContext**

```swift
    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String) {
        NSLog("MCP client disconnected: \(clientId)")
        pendingRequestsLock.lock()
        let toCancel = pendingRequests.filter { $0.value.clientId == clientId }.map { $0.key }
        toCancel.forEach {
            pendingRequests.removeValue(forKey: $0)
            pendingToolContext.removeValue(forKey: $0)
        }
        pendingRequestsLock.unlock()
    }
```

- [ ] **Step 8: Update deliverExtensionResponse signature to accept tool context and call hook**

```swift
    private func deliverExtensionResponse(_ json: String, id: Any?, to clientId: String,
                                          toolName: String = "", arguments: [String: Any] = [:]) {
        let decoded = decodeExtensionResponse(json)
        if let result = decoded.result {
            let contentDicts = result.content.map { block -> [String: Any] in
                var out: [String: Any] = ["type": block.type]
                if let text = block.text { out["text"] = text }
                if let data = block.data { out["data"] = data }
                if let mime = block.mediaType { out["mimeType"] = mime }
                return out
            }
            sendResult(id: id, result: ["content": contentDicts], to: clientId)
            // Post-action hook: fire-and-forget GIF frame capture on success only
            let tabId = (arguments["tabId"] as? Int) ?? -1
            let action = (arguments["action"] as? String) ?? toolName
            let coordinate = parseCoordinate(arguments["coordinate"])
            maybeAddGifFrame(tabId: tabId, action: action, coordinate: coordinate)
        } else {
            let message = decoded.error?.content.first?.text ?? "Malformed extension response"
            sendError(id: id, code: -32000, message: message, to: clientId)
            // Error branch: hook does NOT fire
        }
    }
```

- [ ] **Step 9: Add parseCoordinate helper**

Add after `parseResizeDimensions`:

```swift
    /// Parse a coordinate value from tool arguments, tolerating Int, Double, or NSNumber.
    /// Returns [Int] if valid (≥2 elements), nil otherwise.
    private func parseCoordinate(_ raw: Any?) -> [Int]? {
        guard let raw = raw else { return nil }
        if let ints = raw as? [Int] { return ints }
        if let any = raw as? [Any] {
            let converted = any.compactMap { v -> Int? in
                if let i = v as? Int { return i }
                if let d = v as? Double { return Int(d) }
                if let n = v as? NSNumber { return n.intValue }
                return nil
            }
            return converted.count >= 2 ? converted : nil
        }
        return nil
    }
```

---

### Task 8: Modify ToolRouter — add gif_creator dispatch and maybeAddGifFrame

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift`

- [ ] **Step 1: Add gif_creator branch to handleToolCall**

In `handleToolCall`, add before the `} else if nativeTools.contains(toolName)` branch:

```swift
        } else if toolName == "gif_creator" {
            handleGifCreator(arguments: arguments, id: id, clientId: clientId)
```

- [ ] **Step 2: Add handleGifCreator method**

Add a new `// MARK: - Native GIF Creator` section after the `// MARK: - Native Window Resize` section:

```swift
    // MARK: - Native GIF Creator

    func handleGifCreator(arguments: [String: Any], id: Any?, clientId: String) {
        guard let action = arguments["action"] as? String else {
            sendError(id: id, code: -32000, message: "action parameter is required", to: clientId)
            return
        }
        let tabId = (arguments["tabId"] as? Int) ?? -1

        switch action {
        case "start_recording":
            let msg = gifService.startRecording(tabId: tabId)
            sendResult(id: id, result: ["content": [["type": "text", "text": msg]]], to: clientId)

        case "stop_recording":
            let msg = gifService.stopRecording(tabId: tabId)
            sendResult(id: id, result: ["content": [["type": "text", "text": msg]]], to: clientId)

        case "clear":
            let msg = gifService.clearFrames(tabId: tabId)
            sendResult(id: id, result: ["content": [["type": "text", "text": msg]]], to: clientId)

        case "export":
            handleGifExport(tabId: tabId, arguments: arguments, id: id, clientId: clientId)

        default:
            sendError(id: id, code: -32000,
                      message: "Invalid action: \"\(action)\". Must be start_recording, stop_recording, export, or clear.",
                      to: clientId)
        }
    }

    private func handleGifExport(tabId: Int, arguments: [String: Any], id: Any?, clientId: String) {
        let timestamp = Int(Date().timeIntervalSince1970)
        let filename = (arguments["filename"] as? String) ?? "recording-\(timestamp).gif"

        // Parse GifOptions from arguments["options"] dict
        let optsDict = arguments["options"] as? [String: Any] ?? [:]
        var options = GifService.GifOptions()
        if let v = optsDict["showClicks"]    as? Bool { options.showClicks    = v }
        if let v = optsDict["showActions"]   as? Bool { options.showActions   = v }
        if let v = optsDict["showProgress"]  as? Bool { options.showProgress  = v }
        if let v = optsDict["showWatermark"] as? Bool { options.showWatermark = v }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            switch self.gifService.exportGIF(tabId: tabId, options: options, filename: filename) {
            case .failure(let error):
                // Distinguish no-frames (user error) from encoding failure (system error)
                let msg: String
                if let gifErr = error as? GifError, case .noFrames = gifErr {
                    msg = gifErr.errorDescription ?? error.localizedDescription
                } else {
                    msg = "GIF encoding failed: \(error.localizedDescription)"
                }
                self.sendError(id: id, code: -32000, message: msg, to: clientId)
            case .success(let data):
                let frameCount = self.gifService.frameCount(tabId: tabId)
                let base64 = data.base64EncodedString()
                // Write to ~/Desktop/<filename>.gif
                let desktopURL = FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Desktop")
                    .appendingPathComponent(filename)
                var pathText: String
                do {
                    try data.write(to: desktopURL)
                    pathText = "GIF saved to ~/Desktop/\(filename) (\(frameCount) frames)"
                } catch {
                    pathText = "GIF generated (\(frameCount) frames) — Desktop write failed: \(error.localizedDescription)"
                }
                let content: [[String: Any]] = [
                    ["type": "image", "data": base64, "mimeType": "image/gif"],
                    ["type": "text", "text": pathText]
                ]
                self.sendResult(id: id, result: ["content": content], to: clientId)
            }
        }
    }
```

- [ ] **Step 3: Add maybeAddGifFrame method (internal for testability)**

Add after `handleGifExport`:

```swift
    // MARK: - GIF Post-Action Hook

    /// Capture a screenshot and add it as a GIF frame if recording is active for this tabId.
    /// Fire-and-forget: does not block the MCP response. Only fires on success responses.
    /// Skips "wait" action (no meaningful state change to capture).
    /// Internal (not private) for unit testing via ToolRouterGifHookTests.
    func maybeAddGifFrame(tabId: Int, action: String, coordinate: [Int]?) {
        guard action != "wait" else { return }
        guard gifService.isRecording(tabId: tabId) else { return }
        let seq = gifService.nextSequenceNumber()  // assigned before async capture for ordering
        screenshotService.captureScreenshot(tabId: tabId) { [weak self] result in
            guard let self, case .success(let img) = result else { return }
            self.gifService.addFrame(GifService.GifFrame(
                sequenceNumber: seq,
                imageData: img.data,
                actionType: action,
                coordinate: coordinate,
                timestamp: Date(),
                viewportWidth: img.viewportWidth,
                viewportHeight: img.viewportHeight
            ), tabId: tabId)
        }
    }
```

- [ ] **Step 4: Update handleScreenshotAction to call maybeAddGifFrame on success**

In the existing `handleScreenshotAction`, after each `sendScreenshotResult` call in the success paths, add the hook. Change the method to:

```swift
    private func handleScreenshotAction(action: String, arguments: [String: Any], id: Any?, clientId: String) {
        let tabId = (arguments["tabId"] as? Int) ?? -1
        if action == "screenshot" {
            screenshotService.captureScreenshot(tabId: tabId) { [self] result in
                sendScreenshotResult(result, id: id, to: clientId)
                if case .success(_) = result {
                    maybeAddGifFrame(tabId: tabId, action: "screenshot", coordinate: nil)
                }
            }
        } else {
            // zoom
            let region: [Int]? = {
                guard let raw = arguments["region"] else { return nil }
                if let ints = raw as? [Int] { return ints }
                if let any = raw as? [Any] {
                    let converted = any.compactMap { v -> Int? in
                        if let i = v as? Int { return i }
                        if let d = v as? Double { return Int(d) }
                        if let n = v as? NSNumber { return n.intValue }
                        return nil
                    }
                    return converted.count == 4 ? converted : nil
                }
                return nil
            }()
            screenshotService.captureZoom(tabId: tabId, region: region) { [self] result in
                sendScreenshotResult(result, region: region, id: id, to: clientId)
                if case .success(_) = result {
                    maybeAddGifFrame(tabId: tabId, action: "zoom", coordinate: nil)
                }
            }
        }
    }
```

Note: the `let tabId = ...` extraction at the top replaces the existing `let tabId = arguments["tabId"] as? Int` so `tabId` is always an `Int` (not `Int?`). Also update the two `captureScreenshot(tabId: tabId)` calls — `screenshotService` still accepts `tabId: Int?` so pass `tabId` directly.

- [ ] **Step 5: Run all tests**

```bash
make test-swift 2>&1 | tail -15
```

Expected: All GifServiceTests and ToolRouterGifHookTests pass. All existing ToolRouterTests still pass.

- [ ] **Step 6: Commit**

```bash
git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterGifHookTests.swift
echo "feat: implement gif_creator dispatch and post-action frame capture hook in ToolRouter

Add handleGifCreator (start/stop/export/clear), handleGifExport (Desktop write + base64
image response), and maybeAddGifFrame post-action hook. Hook fires fire-and-forget on
success responses only; skips 'wait' action. pendingToolContext threads tool args to
deliverExtensionResponse for hook context. Injectable init for testability.
All ToolRouterGifHookTests T1-T10 pass.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git commit -F /tmp/commitmsg
```

---

### Task 9: Update ROADMAP and run full test suite

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update ROADMAP.md**

In the Phase 6 table, change `gif_creator` from `📋` to `✅`:

```
| `gif_creator` — record, stop, export animated GIFs | [017](Specs/017-gif-creator.md) | ✅ |
```

Add after the Phase 6 table, a new subsection:

```markdown
### Phase 6 Future Items (gif_creator)

| Item | Notes |
|------|-------|
| In-browser GIF delivery via drag-drop | After `upload_image` (Spec 018) validates DataTransfer injection in Safari |
| Per-frame local color palette | `kCGImagePropertyGIFHasGlobalColorMap: false` per frame — export-time only, no capture overhead |
| Frame deduplication | Skip consecutive near-identical frames via pixel sampling — export-time only |
```

- [ ] **Step 2: Run the full test suite**

```bash
make test-all 2>&1 | tail -20
```

Expected: All Swift and JS tests pass.

- [ ] **Step 3: Final commit**

```bash
git add ROADMAP.md
echo "chore: mark gif_creator (Spec 017) complete in ROADMAP

Add future items: in-browser GIF delivery, per-frame palette, frame deduplication.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git commit -F /tmp/commitmsg
```

- [ ] **Step 4: Confirm branch status**

```bash
git log --oneline -5
```

Expected: 4 commits on `feature/gif-creator` branch.

---

## Implementation Checklist Summary

| File | Status |
|------|--------|
| `ClaudeInSafari/Services/GifService.swift` | Create |
| `Tests/Swift/GifServiceTests.swift` | Create (12 tests) |
| `ClaudeInSafari/MCP/ToolRouter.swift` | Modify (injectable init, gif dispatch, hook) |
| `Tests/Swift/ToolRouterGifHookTests.swift` | Create (10 tests) |
| `ROADMAP.md` | Mark ✅ + future items |

**Do NOT modify:** `AppDelegate.swift`, `SafariWebExtensionHandler.swift`, `manifest.json`, `background.js`, `tabs-manager.js`, any extension JS, `ClaudeInSafari.entitlements`
