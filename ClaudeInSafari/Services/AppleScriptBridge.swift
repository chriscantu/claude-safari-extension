import Foundation

/// Manages Safari window operations via AppleScript.
/// See Spec 016 for full specification.
///
/// Apple Events are sent via an `osascript` subprocess rather than `NSAppleScript`.
/// See `runAppleScript()` for the rationale — the entitlement applies to `osascript`'s
/// TCC entry, not the app bundle.
///
/// Requires:
/// - Accessibility permission (System Settings > Privacy & Security > Accessibility)
///   for the System Events fullscreen check.
class AppleScriptBridge {

    enum ResizeError: Error {
        case notPositive
        case belowMinimum(String)  // axis name: "Width" or "Height"
        case exceedsMaximum(String) // axis name: "Width" or "Height"
        case noWindowFound
        case fullscreen
        case accessibilityDenied
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
            case .accessibilityDenied:
                return "Accessibility permission required. Grant access in System Settings > Privacy & Security > Accessibility."
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
    /// tabId resolution (tab ID → window index via the extension) is not yet
    /// implemented; this method always resizes the frontmost Safari window (window 1).
    /// See Spec 016 §Window Resolution for the intended full implementation.
    ///
    /// - Parameters:
    ///   - width: Target window width in pixels (200–7680)
    ///   - height: Target window height in pixels (200–4320)
    /// - Returns: Success message describing the new dimensions
    /// - Throws: ResizeError on validation failure or AppleScript execution error
    func resizeWindow(width: Int, height: Int) throws -> String {
        try validateDimensions(width: width, height: height)
        try runAppleScript(buildResizeScript(width: width, height: height))
        return "Resized Safari window to \(width)x\(height) pixels"
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
        //   2. Resize via Safari's Apple Events API (requires osascript TCC permission for Safari).
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
        // Use osascript subprocess rather than NSAppleScript so the Apple Events
        // call runs under osascript's own TCC entry, avoiding Hardened Runtime
        // permission issues with the app's own bundle ID.
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

            // -1743 (errAEEventNotPermitted) is the canonical TCC Apple Events denial code.
            if message.contains("-1743") || message.lowercased().contains("not authorized") {
                throw ResizeError.accessibilityDenied
            }

            throw ResizeError.executionFailed(
                message.isEmpty ? "osascript exited with status \(process.terminationStatus)" : message
            )
        }
    }
}
