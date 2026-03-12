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
/// Thread-safe via NSLock. All mutable state (recordingTabs, frameBuffers, sequenceCounter)
/// is protected by a single NSLock. exportGIF uses copy-then-release to avoid holding the
/// lock during GIF encoding. See Spec 017 for full specification.
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
        let showClicks: Bool
        let showActions: Bool
        let showProgress: Bool
        let showWatermark: Bool

        init(showClicks: Bool = true, showActions: Bool = true,
             showProgress: Bool = true, showWatermark: Bool = true) {
            self.showClicks = showClicks
            self.showActions = showActions
            self.showProgress = showProgress
            self.showWatermark = showWatermark
        }
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

    /// Append a frame to the capped frame buffer for the given tabId.
    /// Enforces a 50-frame maximum by evicting the oldest frame (O(n) via Array.removeFirst).
    /// Silently drops frames for tabs that are not currently recording (e.g., frames arriving
    /// after stopRecording due to async capture delay).
    func addFrame(_ frame: GifFrame, tabId: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard recordingTabs.contains(tabId) else {
            NSLog("GifService.addFrame: dropping frame seq=%d action=%@ — tabId=%d is not recording",
                  frame.sequenceNumber, frame.actionType, tabId)
            return
        }
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

    // MARK: - Export

    /// Encode captured frames as an animated GIF. Returns the GIF data and the number of
    /// frames successfully encoded (may be less than the buffer count if any PNG frames
    /// fail to decode).
    /// Snapshot semantics: copies frame array under lock, releases immediately, encodes from snapshot.
    /// Sorts by sequenceNumber to handle out-of-order async captures.
    func exportGIF(tabId: Int, options: GifOptions) -> Result<(Data, Int), Error> {
        lock.lock()
        let snapshot = (frameBuffers[tabId] ?? []).sorted { $0.sequenceNumber < $1.sequenceNumber }
        lock.unlock()

        guard !snapshot.isEmpty else {
            return .failure(GifError.noFrames(tabId))
        }

        return encodeGIF(frames: snapshot, options: options)
    }

    // MARK: - GIF Encoding

    private func encodeGIF(frames: [GifFrame], options: GifOptions) -> Result<(Data, Int), Error> {
        // First pass: decode all PNG frames and compute delays.
        // Pre-counting valid frames before creating CGImageDestination avoids a count mismatch
        // if any frames have corrupt PNG data — ImageIO behaviour is undefined when actual
        // image count is less than the declared count.
        struct ValidFrame {
            let cgImage: CGImage
            let frame: GifFrame
            let delay: Double
        }
        var validFrames: [ValidFrame] = []
        for (index, frame) in frames.enumerated() {
            guard let source = CGImageSourceCreateWithData(frame.imageData as CFData, nil),
                  let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                NSLog("GifService.encodeGIF: skipping frame seq=%d (action=%@, dataLength=%d) — invalid PNG data",
                      frame.sequenceNumber, frame.actionType, frame.imageData.count)
                continue
            }
            // Frame delay: elapsed time to next frame, clamped to [0.3, 3.0]s.
            // Last frame always holds for 3.0s regardless of action type.
            let delay: Double
            if index == frames.count - 1 {
                delay = 3.0
            } else {
                let elapsed = frames[index + 1].timestamp.timeIntervalSince(frame.timestamp)
                delay = min(max(elapsed, 0.3), 3.0)
            }
            validFrames.append(ValidFrame(cgImage: cgImage, frame: frame, delay: delay))
        }

        guard !validFrames.isEmpty else {
            return .failure(GifError.encodingFailed("All frames had invalid PNG data"))
        }

        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, "com.compuserve.gif" as CFString, validFrames.count, nil
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

        for (index, valid) in validFrames.enumerated() {
            // Apply visual overlays via CGContext. Log and fall back to base image on failure.
            let imageToAdd: CGImage
            if let overlaid = applyOverlays(
                to: valid.cgImage, frame: valid.frame,
                frameIndex: index, totalFrames: validFrames.count,
                options: options
            ) {
                imageToAdd = overlaid
            } else {
                NSLog("GifService.encodeGIF: applyOverlays returned nil for frame seq=%d (action=%@, size=%dx%d) — using base image",
                      valid.frame.sequenceNumber, valid.frame.actionType, valid.cgImage.width, valid.cgImage.height)
                imageToAdd = valid.cgImage
            }

            let frameProps: [String: Any] = [
                kCGImagePropertyGIFDictionary as String: [
                    kCGImagePropertyGIFUnclampedDelayTime as String: valid.delay,
                    kCGImagePropertyGIFDelayTime as String: valid.delay
                ]
            ]
            CGImageDestinationAddImage(dest, imageToAdd, frameProps as CFDictionary)
        }

        guard CGImageDestinationFinalize(dest) else {
            return .failure(GifError.encodingFailed("CGImageDestinationFinalize failed"))
        }
        return .success((mutableData as Data, validFrames.count))
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
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.6))
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(imageWidth), height: labelHeight))
        drawText(text, in: ctx, at: CGPoint(x: padding, y: padding), fontSize: fontSize,
                 color: CGColor(red: 1, green: 1, blue: 1, alpha: 1.0))
    }

    private func drawWatermark(in ctx: CGContext, imageWidth: Int) {
        let text = "Recorded with Claude"
        let fontSize: CGFloat = 11
        let padding: CGFloat = 8
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
        // d: -1 flips text upright — CTLineDraw in a CGContext uses a flipped y relative to the drawing context
        ctx.textMatrix = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 0)
        ctx.textPosition = point
        CTLineDraw(line, ctx)
    }
}
