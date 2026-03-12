import Foundation
import ApplicationServices

/// Manages Safari window operations via AppleScript.
/// See Spec 016 for full specification.
///
/// Apple Events are sent via an `osascript` subprocess rather than `NSAppleScript`.
/// See `runAppleScript()` for the rationale — the entitlement applies to `osascript`'s
/// TCC entry, not the app bundle.
///
/// Requires two separate TCC permissions:
/// - Automation (System Settings > Privacy & Security > Automation > osascript → Safari)
///   for the Safari Apple Events resize call.
/// - Accessibility (System Settings > Privacy & Security > Accessibility)
///   for the System Events fullscreen check via AXFullScreen.
class AppleScriptBridge {

    enum ResizeError: Error {
        case notPositive
        case belowMinimum(String)   // axis name: "Width" or "Height"
        case exceedsMaximum(String) // axis name: "Width" or "Height"
        case noWindowFound
        case fullscreen
        case permissionDenied
        case executionFailed(String)

        var userMessage: String {
            switch self {
            case .notPositive:
                return "Width and height must be positive numbers"
            case .belowMinimum(let axis):
                return "\(axis) must be at least \(AppleScriptBridge.minDimension) pixels"
            case .exceedsMaximum(let axis):
                return "\(axis) exceeds 8K resolution limit"
            case .noWindowFound:
                return "No Safari window found"
            case .fullscreen:
                return "Cannot resize a fullscreen window. Exit fullscreen first."
            case .permissionDenied:
                return "Permission denied. Grant access in System Settings > Privacy & Security > Automation (osascript → Safari) and Accessibility."
            case .executionFailed(let detail):
                return "Failed to resize window: \(detail)"
            }
        }
    }

    static let minDimension = 200
    static let maxWidth = 7680
    static let maxHeight = 4320

    // MARK: - Public API

    /// Resize the frontmost Safari window to the given dimensions.
    /// The window's top-left corner is preserved; only width and height change.
    ///
    /// tabId resolution (tab ID → window index via the extension) is not implemented;
    /// this method always resizes the frontmost Safari window (window 1).
    /// See Spec 016 §Window Resolution for the architectural rationale.
    ///
    /// Dimension validation runs synchronously on the caller's thread (fast, no I/O).
    /// The AppleScript subprocess is dispatched onto a background GCD queue so the
    /// caller's thread (the MCP receive queue) is never blocked by `waitUntilExit()`.
    ///
    /// - Parameters:
    ///   - width: Target window width in pixels (200–7680)
    ///   - height: Target window height in pixels (200–4320)
    ///   - completion: Called on an unspecified background queue with `.success(message)`
    ///     or `.failure(ResizeError)`.
    func resizeWindow(width: Int, height: Int, completion: @escaping (Result<String, ResizeError>) -> Void) {
        do {
            try validateDimensions(width: width, height: height)
        } catch let error as ResizeError {
            completion(.failure(error))
            return
        } catch {
            completion(.failure(.executionFailed(error.localizedDescription)))
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.runAppleScript(self.buildResizeScript(width: width, height: height))
                completion(.success("Resized Safari window to \(width)x\(height) pixels"))
            } catch let error as ResizeError {
                completion(.failure(error))
            } catch {
                completion(.failure(.executionFailed(error.localizedDescription)))
            }
        }
    }

    // MARK: - Validation (testable without a live Safari instance)

    func validateDimensions(width: Int, height: Int) throws {
        guard width > 0, height > 0 else {
            throw ResizeError.notPositive
        }
        guard width >= Self.minDimension else {
            throw ResizeError.belowMinimum("Width")
        }
        guard height >= Self.minDimension else {
            throw ResizeError.belowMinimum("Height")
        }
        guard width <= Self.maxWidth else {
            throw ResizeError.exceedsMaximum("Width")
        }
        guard height <= Self.maxHeight else {
            throw ResizeError.exceedsMaximum("Height")
        }
    }

    // MARK: - AppleScript

    private func buildResizeScript(width: Int, height: Int) -> String {
        // Note: width/height are validated integers — no injection risk.
        // Two-step approach:
        //   1. Check window count and fullscreen state via System Events (requires Accessibility permission).
        //   2. Resize via Safari's Apple Events API (requires Automation permission for osascript → Safari).
        // Sentinel error numbers (9001, 9002) are matched in runAppleScript for reliable classification,
        // avoiding fragile substring matches on human-readable error text.
        // Race condition: the frontmost window (window 1) may change between the fullscreen check and
        // the resize if the user interacts with another window during execution. Documented in Spec 016.
        return """
        tell application "Safari"
            if (count of windows) is 0 then
                error "RESIZE_NO_WINDOW" number 9001
            end if
        end tell
        tell application "System Events"
            tell process "Safari"
                if value of attribute "AXFullScreen" of window 1 is true then
                    error "RESIZE_FULLSCREEN" number 9002
                end if
            end tell
        end tell
        tell application "Safari"
            set {posX, posY, posX2, posY2} to bounds of window 1
            set bounds of window 1 to {posX, posY, posX + \(width), posY + \(height)}
        end tell
        """
    }

    private func runAppleScript(_ source: String) throws {
        // Preflight: check Accessibility TCC before spawning osascript.
        // AXIsProcessTrusted() is locale-independent and synchronous — avoids
        // fragile string-matching on localised macOS error messages.
        // The Accessibility permission is required for the System Events AXFullScreen check.
        guard AXIsProcessTrusted() else {
            throw ResizeError.permissionDenied
        }

        // Use osascript subprocess rather than NSAppleScript so the Apple Events
        // call runs under osascript's own TCC entry, avoiding Hardened Runtime
        // permission issues with the app's own bundle ID.
        // Called from a background GCD queue (dispatched by resizeWindow) so
        // waitUntilExit() does not block the MCP receive queue.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]

        let stderr = Pipe()
        process.standardError = stderr

        do {
            try process.run()
        } catch {
            NSLog("AppleScriptBridge: process.run() threw — %@", error.localizedDescription)
            throw ResizeError.executionFailed("Failed to launch osascript: \(error.localizedDescription)")
        }

        // Read stderr on a background thread concurrently with waitUntilExit() to avoid
        // a pipe buffer deadlock: if osascript writes >64 KB to stderr before exiting,
        // it blocks on write() while the parent is blocked on waitUntilExit().
        let stderrHandle = stderr.fileHandleForReading
        var stderrData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            stderrData = stderrHandle.readDataToEndOfFile()
            group.leave()
        }
        process.waitUntilExit()
        group.wait()

        // A signal-killed process has a different termination reason from a normal exit.
        if process.terminationReason == .uncaughtSignal {
            NSLog("AppleScriptBridge: osascript killed by signal %d", process.terminationStatus)
            throw ResizeError.executionFailed("osascript was killed by signal \(process.terminationStatus)")
        }

        guard process.terminationStatus == 0 else {
            let message = String(data: stderrData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            // Match on numeric sentinel codes injected by the AppleScript for reliable
            // classification — avoids fragile substring matching on localised error text.
            if message.contains("(9001)") { throw ResizeError.noWindowFound }
            if message.contains("(9002)") { throw ResizeError.fullscreen }

            // -1743 (errAEEventNotPermitted) is the Automation TCC denial code — fired
            // when osascript is not authorised to send Apple Events to Safari.
            if message.contains("-1743") || message.lowercased().contains("not authorized") {
                throw ResizeError.permissionDenied
            }

            throw ResizeError.executionFailed(
                message.isEmpty ? "osascript exited with status \(process.terminationStatus)" : message
            )
        }
    }
}
