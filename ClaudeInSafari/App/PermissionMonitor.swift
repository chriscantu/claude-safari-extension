// ClaudeInSafari/App/PermissionMonitor.swift
import Foundation
import ApplicationServices
import CoreGraphics
import SafariServices

// MARK: - OnboardingStep

/// The three permission steps in setup order.
enum OnboardingStep: Equatable {
    case safariExtension
    case screenRecording
    case accessibility
}

// MARK: - PermissionStatus

struct PermissionStatus {
    let extensionEnabled: Bool
    let screenRecording: Bool
    let accessibility: Bool

    var allGranted: Bool {
        extensionEnabled && screenRecording && accessibility
    }

    /// Returns the first step not yet complete, in setup order.
    var firstIncompleteStep: OnboardingStep? {
        if !extensionEnabled { return .safariExtension }
        if !screenRecording  { return .screenRecording }
        if !accessibility    { return .accessibility }
        return nil
    }
}

// MARK: - PermissionChecking protocol

protocol PermissionChecking {
    func isAccessibilityGranted() -> Bool
    func isScreenRecordingGranted() -> Bool
    /// Completion may be called on any queue.
    /// `PermissionMonitor.checkAll` re-dispatches to the main queue before invoking its own
    /// completion, so callers of `checkAll` do not need to add their own dispatch.
    /// Direct callers of this protocol method are responsible for their own queue management.
    func getExtensionEnabled(completion: @escaping (Bool) -> Void)
}

// MARK: - SystemPermissionChecker

/// Production implementation that calls real macOS APIs.
struct SystemPermissionChecker: PermissionChecking {
    private static let extensionBundleID = "com.chriscantu.claudeinsafari.extension"

    func isAccessibilityGranted() -> Bool {
        AXIsProcessTrusted()
    }

    func isScreenRecordingGranted() -> Bool {
        // Silent check — no UI, no side effects. Used for the 0.5 s polling loop.
        // CGRequestScreenCaptureAccess() is called separately (once on step entry and
        // once on app-did-become-active) to refresh the per-process TCC cache after the
        // user grants permission in System Settings.
        CGPreflightScreenCaptureAccess()
    }

    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: Self.extensionBundleID
        ) { state, error in
            if let error = error {
                NSLog("PermissionMonitor: SFSafariExtensionManager query failed: %@", error.localizedDescription)
            }
            completion(state?.isEnabled ?? false)
        }
    }
}

// MARK: - PermissionMonitor

/// Checks permission state and delivers `PermissionStatus` on the main queue.
/// Must be called from the main thread. Not thread-safe for concurrent callers.
final class PermissionMonitor {
    private let checker: PermissionChecking

    init(checker: PermissionChecking = SystemPermissionChecker()) {
        self.checker = checker
    }

    /// One-shot check of all three permissions. Delivers `PermissionStatus` on the main queue.
    func checkAll(completion: @escaping (PermissionStatus) -> Void) {
        let accessibility = checker.isAccessibilityGranted()
        let screenRecording = checker.isScreenRecordingGranted()
        checker.getExtensionEnabled { extensionEnabled in
            let status = PermissionStatus(
                extensionEnabled: extensionEnabled,
                screenRecording: screenRecording,
                accessibility: accessibility
            )
            DispatchQueue.main.async { completion(status) }
        }
    }
}
