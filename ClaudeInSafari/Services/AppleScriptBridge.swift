import Foundation

/// Manages Safari window operations via AppleScript.
/// See Spec 016 for full specification.
///
/// Requires:
/// - com.apple.security.temporary-exception.apple-events entitlement targeting com.apple.Safari
/// - Accessibility permission (System Settings > Privacy & Security > Accessibility)
class AppleScriptBridge {

    enum ResizeError: Error {
        case notPositive
        case belowMinimum(String) // axis name: "Width" or "Height"
        case exceedsMaximum
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
            case .exceedsMaximum:
                return "Dimensions exceed 8K resolution limit"
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
    /// If tabId was provided by the caller it is ignored — resize always targets
    /// the frontmost Safari window. See Spec 016 for the rationale.
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
        guard width <= Self.maxWidth, height <= Self.maxHeight else {
            throw ResizeError.exceedsMaximum
        }
    }

    // MARK: - AppleScript

    private func buildResizeScript(width: Int, height: Int) -> String {
        // Note: width/height are validated integers — no injection risk.
        // Two-step approach:
        //   1. Check window count and fullscreen state via System Events (requires Accessibility permission).
        //   2. Resize via Safari's Apple Events API (requires apple-events entitlement).
        // Race condition: window state may change between the check and the resize — documented in Spec 016.
        return """
        tell application "Safari"
            if (count of windows) is 0 then
                error "no_window"
            end if
        end tell
        tell application "System Events"
            tell process "Safari"
                if value of attribute "AXFullScreen" of window 1 is true then
                    error "fullscreen"
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
            process.waitUntilExit()
        } catch {
            throw ResizeError.executionFailed("Failed to launch osascript: \(error.localizedDescription)")
        }

        guard process.terminationStatus == 0 else {
            let data = stderr.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if message.lowercased().contains("not allowed") ||
               message.lowercased().contains("assistive") {
                throw ResizeError.accessibilityDenied
            }
            if message.contains("no_window") {
                throw ResizeError.noWindowFound
            }
            if message.contains("fullscreen") {
                throw ResizeError.fullscreen
            }
            throw ResizeError.executionFailed(message.isEmpty ? "osascript exited with status \(process.terminationStatus)" : message)
        }
    }
}
