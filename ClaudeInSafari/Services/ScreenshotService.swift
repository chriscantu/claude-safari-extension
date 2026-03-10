import Foundation
import CoreGraphics
import ImageIO
import AppKit
import ScreenCaptureKit
import CoreVideo

// MARK: - ScreenshotError

enum ScreenshotError: Error {
    case permissionDenied
    case noSafariWindow
    case systemVersionUnsupported
    case invalidRegion(String)
    case captureFailed(String)
    case timeout
    case tabNotFound(Int)

    var userMessage: String {
        switch self {
        case .permissionDenied:
            return "Screen Recording permission required. Grant access in System Settings > Privacy & Security > Screen Recording."
        case .noSafariWindow:
            return "No Safari window found"
        case .systemVersionUnsupported:
            return "Screenshots require macOS 13.0 or later"
        case .invalidRegion(let msg):
            return msg
        case .captureFailed(let msg):
            return "Screenshot capture failed: \(msg)"
        case .timeout:
            return "Screenshot capture timed out"
        case .tabNotFound(let id):
            return "Tab not found: \(id)"
        }
    }
}

// MARK: - CapturedImage

struct CapturedImage {
    let imageId: String
    let data: Data            // PNG-encoded
    let timestamp: Date
    let viewportWidth: Int
    let viewportHeight: Int
}

// MARK: - ScreenCaptureProvider (injected for testability)

protocol ScreenCaptureProvider {
    func checkPermission() -> Bool
    /// Capture the frontmost Safari window's content area.
    /// Completion delivers (CGImage, viewportWidth, viewportHeight) or an error.
    func captureWindow(completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void)
}

// MARK: - ScreenshotService

/// Captures screenshots via ScreenCaptureKit and manages an in-memory image store.
/// Thread-safe: all mutable state is protected by `lock`.
/// See Spec 011 for full specification.
class ScreenshotService {

    private let captureProvider: ScreenCaptureProvider
    private let lock = NSLock()
    private var imageStore: [String: CapturedImage] = [:]
    private var imageOrder: [String] = []     // insertion-ordered ids for LRU eviction

    private static let maxStoredImages = 50

    init(captureProvider: ScreenCaptureProvider = DefaultScreenCaptureProvider()) {
        self.captureProvider = captureProvider
    }

    // MARK: - Public API

    /// Number of currently stored images. Exposed for testing eviction behaviour.
    var imageCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return imageStore.count
    }

    /// Capture a full screenshot of the Safari window.
    func captureScreenshot(tabId: Int?, completion: @escaping (Result<CapturedImage, ScreenshotError>) -> Void) {
        guard captureProvider.checkPermission() else {
            completion(.failure(.permissionDenied))
            return
        }
        captureProvider.captureWindow { [weak self] result in
            guard let self = self else {
                completion(.failure(.captureFailed("Service deallocated")))
                return
            }
            switch result {
            case .failure(let error):
                completion(.failure(error))
            case .success(let (cgImage, viewportWidth, viewportHeight)):
                let scaled = self.scale(cgImage, maxWidth: 1280) ?? cgImage
                guard let pngData = self.encodePNG(scaled) else {
                    completion(.failure(.captureFailed("PNG encoding failed")))
                    return
                }
                let captured = CapturedImage(
                    imageId: UUID().uuidString,
                    data: pngData,
                    timestamp: Date(),
                    viewportWidth: viewportWidth,
                    viewportHeight: viewportHeight
                )
                self.store(captured)
                completion(.success(captured))
            }
        }
    }

    /// Capture a zoomed region of the Safari window.
    /// `region` must be [x0, y0, x1, y1] in viewport pixels (web content area coords).
    func captureZoom(tabId: Int?, region: [Int]?, completion: @escaping (Result<CapturedImage, ScreenshotError>) -> Void) {
        guard let region = region else {
            completion(.failure(.invalidRegion("region parameter is required for zoom action")))
            return
        }
        guard region.count == 4 else {
            completion(.failure(.invalidRegion("region must have exactly 4 elements [x0, y0, x1, y1]")))
            return
        }
        let (x0, y0, x1, y1) = (region[0], region[1], region[2], region[3])
        guard x0 >= 0, y0 >= 0 else {
            completion(.failure(.invalidRegion("Invalid region: coordinates must be non-negative")))
            return
        }
        guard x0 < x1, y0 < y1 else {
            completion(.failure(.invalidRegion("Invalid region: coordinates out of bounds")))
            return
        }
        guard captureProvider.checkPermission() else {
            completion(.failure(.permissionDenied))
            return
        }
        captureProvider.captureWindow { [weak self] result in
            guard let self = self else {
                completion(.failure(.captureFailed("Service deallocated")))
                return
            }
            switch result {
            case .failure(let error):
                completion(.failure(error))
            case .success(let (cgImage, viewportWidth, viewportHeight)):
                guard x0 >= 0, y0 >= 0, x1 <= viewportWidth, y1 <= viewportHeight else {
                    completion(.failure(.invalidRegion("Invalid region: coordinates out of bounds")))
                    return
                }
                let cropRect = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
                guard let cropped = cgImage.cropping(to: cropRect) else {
                    completion(.failure(.captureFailed("Failed to crop zoom region")))
                    return
                }
                let scaled = self.scale(cropped, maxWidth: 1280) ?? cropped
                guard let pngData = self.encodePNG(scaled) else {
                    completion(.failure(.captureFailed("PNG encoding failed")))
                    return
                }
                let captured = CapturedImage(
                    imageId: UUID().uuidString,
                    data: pngData,
                    timestamp: Date(),
                    viewportWidth: x1 - x0,
                    viewportHeight: y1 - y0
                )
                self.store(captured)
                completion(.success(captured))
            }
        }
    }

    /// Retrieve a previously captured image by its UUID.
    func retrieveImage(imageId: String) -> CapturedImage? {
        lock.lock()
        defer { lock.unlock() }
        return imageStore[imageId]
    }

    // MARK: - Private helpers

    private func store(_ image: CapturedImage) {
        lock.lock()
        defer { lock.unlock() }
        imageStore[image.imageId] = image
        imageOrder.append(image.imageId)
        while imageStore.count > ScreenshotService.maxStoredImages {
            let oldest = imageOrder.removeFirst()
            imageStore.removeValue(forKey: oldest)
        }
    }

    /// Scale `image` so its width is at most `maxWidth`, preserving aspect ratio.
    /// Returns nil if already within the limit (caller uses original).
    private func scale(_ image: CGImage, maxWidth: Int) -> CGImage? {
        let w = image.width
        let h = image.height
        guard w > maxWidth else { return nil }
        let newW = maxWidth
        let newH = max(1, Int(Double(h) * Double(maxWidth) / Double(w)))
        guard let ctx = CGContext(
            data: nil, width: newW, height: newH,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: newW, height: newH))
        return ctx.makeImage()
    }

    /// Encode a CGImage as PNG Data using ImageIO.
    private func encodePNG(_ image: CGImage) -> Data? {
        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, "public.png" as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return mutableData as Data
    }
}

// MARK: - DefaultScreenCaptureProvider

/// Production implementation using ScreenCaptureKit.
/// Requires Screen Recording permission (check with CGPreflightScreenCaptureAccess()).
@available(macOS 13.0, *)
class DefaultScreenCaptureProvider: ScreenCaptureProvider {

    func checkPermission() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    func captureWindow(completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void) {
        // Internal 10-second timeout guards against SCKit hanging.
        // `onceLock` serialises the check-and-set of `settled` across the timeout queue
        // and SCKit's callback queue so `completion` is invoked exactly once.
        let onceLock = NSLock()
        var settled = false
        // cancelLock protects captureToCancel, which is set after captureViaSCStream returns.
        let cancelLock = NSLock()
        var captureToCancel: SingleFrameCapture? = nil
        let timeoutItem = DispatchWorkItem {
            onceLock.lock()
            let alreadySettled = settled
            if !alreadySettled { settled = true }
            onceLock.unlock()
            if !alreadySettled {
                cancelLock.lock()
                let cap = captureToCancel
                cancelLock.unlock()
                cap?.cancel()   // stop SCStream on macOS 13 to avoid a permanent retain
                completion(.failure(.timeout))
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeoutItem)

        let completeOnce: (Result<(CGImage, Int, Int), ScreenshotError>) -> Void = { result in
            onceLock.lock()
            let alreadySettled = settled
            if !alreadySettled { settled = true }
            onceLock.unlock()
            if !alreadySettled { timeoutItem.cancel(); completion(result) }
        }

        SCShareableContent.getWithCompletionHandler { content, error in
            if let error = error {
                completeOnce(.failure(.captureFailed(error.localizedDescription)))
                return
            }
            guard let content = content else {
                completeOnce(.failure(.noSafariWindow))
                return
            }
            let safariWindows = content.windows.filter {
                $0.owningApplication?.bundleIdentifier == "com.apple.Safari"
            }
            guard let window = safariWindows.first else {
                completeOnce(.failure(.noSafariWindow))
                return
            }

            let windowBounds = window.frame
            // AX APIs must be called from the main thread; SCKit callbacks run on its own queue.
            var toolbarPt: CGFloat = 0
            if Thread.isMainThread {
                toolbarPt = self.toolbarHeight(for: window, windowBounds: windowBounds)
            } else {
                DispatchQueue.main.sync {
                    toolbarPt = self.toolbarHeight(for: window, windowBounds: windowBounds)
                }
            }
            let contentH = max(1.0, windowBounds.height - toolbarPt)
            let viewportW = Int(windowBounds.width)
            let viewportH = Int(contentH)

            let scale = NSScreen.main?.backingScaleFactor ?? 1.0
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = Int(windowBounds.width * scale)
            config.height = Int(windowBounds.height * scale)
            config.pixelFormat = kCVPixelFormatType_32BGRA

            if #available(macOS 14.0, *) {
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                    if let error = error {
                        completeOnce(.failure(.captureFailed(error.localizedDescription)))
                        return
                    }
                    guard let image = image else {
                        completeOnce(.failure(.captureFailed("No image returned from SCScreenshotManager")))
                        return
                    }
                    // Crop out the toolbar (top N pixels in the captured image).
                    // CGImage.cropping(to:) uses a bottom-left origin, so the toolbar
                    // occupies y=(contentHeight)..<image.height. Keep y=0..contentHeight.
                    let toolbarPx = Int(toolbarPt * scale)
                    let contentHeight = image.height - toolbarPx
                    let cropRect = CGRect(x: 0, y: 0, width: image.width, height: max(1, contentHeight))
                    let cropped = image.cropping(to: cropRect) ?? image
                    completeOnce(.success((cropped, viewportW, viewportH)))
                }
            } else {
                // macOS 13 (Ventura) — SCStream single-frame fallback.
                // Store the capture so the timeout closure can stop the stream if it fires.
                let cap = self.captureViaSCStream(
                    filter: filter, config: config,
                    toolbarPx: Int(toolbarPt * scale),
                    viewportW: viewportW, viewportH: viewportH,
                    completion: completeOnce
                )
                cancelLock.lock()
                captureToCancel = cap
                cancelLock.unlock()
            }
        }
    }

    // MARK: - Toolbar height

    /// Returns the toolbar height (in points) for the given Safari window.
    /// Queries AXUIElement first; falls back to a 74pt heuristic.
    private func toolbarHeight(for window: SCWindow, windowBounds: CGRect) -> CGFloat {
        if let pid = window.owningApplication?.processID,
           let h = Self.axToolbarHeight(pid: pid, windowBounds: windowBounds) {
            return h
        }
        return 74  // heuristic fallback (±14pt depending on Safari configuration)
    }

    /// Query the Safari accessibility hierarchy to find the web content area's top edge.
    /// Returns the toolbar height (in points) relative to the window's top, or nil on failure.
    private static func axToolbarHeight(pid: pid_t, windowBounds: CGRect) -> CGFloat? {
        guard let screenHeight = NSScreen.screens.first?.frame.height else { return nil }

        let app = AXUIElementCreateApplication(pid)
        var mainWindowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &mainWindowRef) == AXError.success,
              let mainWindowRaw = mainWindowRef,
              CFGetTypeID(mainWindowRaw) == AXUIElementGetTypeID() else { return nil }
        let mainWindow = mainWindowRaw as! AXUIElement  // safe: type confirmed by CFGetTypeID above

        guard let webArea = findAXWebArea(in: mainWindow, depth: 0) else { return nil }

        var frameRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(webArea, "AXFrame" as CFString, &frameRef) == AXError.success,
              let frameValue = frameRef else { return nil }

        var contentRect = CGRect.zero
        // AXFrame is in "flipped" screen coordinates: origin top-left of primary screen, Y↓.
        guard CFGetTypeID(frameValue) == AXValueGetTypeID() else { return nil }
        let axValue = frameValue as! AXValue  // safe: type confirmed by CFGetTypeID above
        guard AXValueGetValue(axValue, AXValueType.cgRect, &contentRect) else { return nil }

        // Convert AX y (flipped, from screen top) to the content's distance from the window top.
        // NS window.frame.origin.y is the bottom of the window in NS coords (Y↑).
        // Top of window in AX coords = screenHeight - window.frame.maxY
        let windowTopAX = screenHeight - windowBounds.maxY
        let toolbarH = contentRect.origin.y - windowTopAX
        return toolbarH > 0 ? toolbarH : nil
    }

    private static func findAXWebArea(in element: AXUIElement, depth: Int) -> AXUIElement? {
        guard depth < 10 else { return nil }

        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        if let role = roleRef as? String, role == "AXWebArea" {
            return element
        }

        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == AXError.success,
              let children = childrenRef as? [AXUIElement] else { return nil }

        for child in children {
            if let found = findAXWebArea(in: child, depth: depth + 1) { return found }
        }
        return nil
    }

    // MARK: - macOS 13 SCStream fallback

    @available(macOS 13.0, *)
    @discardableResult
    private func captureViaSCStream(
        filter: SCContentFilter,
        config: SCStreamConfiguration,
        toolbarPx: Int,
        viewportW: Int,
        viewportH: Int,
        completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void
    ) -> SingleFrameCapture {
        let capture = SingleFrameCapture(toolbarPx: toolbarPx, viewportW: viewportW, viewportH: viewportH, completion: completion)
        let stream = SCStream(filter: filter, configuration: config, delegate: capture)
        do {
            try stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
            capture.stream = stream
            stream.startCapture { error in
                if let error = error {
                    capture.stream = nil  // break retain cycle on startCapture failure
                    completion(.failure(.captureFailed(error.localizedDescription)))
                }
            }
        } catch {
            completion(.failure(.captureFailed(error.localizedDescription)))
        }
        return capture
    }
}

// MARK: - SingleFrameCapture (SCStream macOS 13 helper)

@available(macOS 13.0, *)
private class SingleFrameCapture: NSObject, SCStreamOutput, SCStreamDelegate {

    var stream: SCStream?   // strong — keeps the stream alive until stopCapture completes
    private let capturedLock = NSLock()
    private var captured = false
    private let toolbarPx: Int
    private let viewportW: Int
    private let viewportH: Int
    private let completion: (Result<(CGImage, Int, Int), ScreenshotError>) -> Void

    init(toolbarPx: Int, viewportW: Int, viewportH: Int, completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void) {
        self.toolbarPx = toolbarPx
        self.viewportW = viewportW
        self.viewportH = viewportH
        self.completion = completion
    }

    /// Called by the outer timeout to stop the stream and release the retain cycle.
    /// Completion is NOT invoked here — the caller delivers the timeout error itself.
    func cancel() {
        capturedLock.lock()
        let alreadyCaptured = captured
        if !alreadyCaptured { captured = true }
        capturedLock.unlock()
        if !alreadyCaptured {
            stream?.stopCapture { _ in }
            stream = nil
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else { return }
        capturedLock.lock()
        let alreadyCaptured = captured
        if !alreadyCaptured { captured = true }
        capturedLock.unlock()
        guard !alreadyCaptured else { return }
        stream.stopCapture { _ in }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            completion(.failure(.captureFailed("No pixel buffer in SCStream frame")))
            return
        }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        let totalHeight = Int(ciImage.extent.height)
        let cropRect = CGRect(
            x: 0,
            y: 0,
            width: ciImage.extent.width,
            height: CGFloat(max(1, totalHeight - toolbarPx))
        )
        guard let cgImage = context.createCGImage(ciImage, from: cropRect) else {
            completion(.failure(.captureFailed("CIContext failed to create CGImage from SCStream frame")))
            return
        }
        completion(.success((cgImage, viewportW, viewportH)))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        capturedLock.lock()
        let alreadyCaptured = captured
        if !alreadyCaptured { captured = true }
        capturedLock.unlock()
        guard !alreadyCaptured else { return }
        completion(.failure(.captureFailed(error.localizedDescription)))
    }
}
