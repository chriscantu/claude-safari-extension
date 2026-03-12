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

    // MARK: - Export

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
