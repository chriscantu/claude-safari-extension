import Foundation

/// Shared constants between the native app and Safari extension.
enum AppConstants {
    /// App Group identifier for shared data between app and extension.
    static let appGroupId = "group.com.chriscantu.claudeinsafari"

    /// The application identifier used by browser.runtime.sendNativeMessage().
    static let nativeAppIdentifier = "com.chriscantu.claudeinsafari"

    /// URL to the App Group container shared between the native app and extension.
    static var appGroupContainerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }

    /// URL to the pending tool request FIFO queue file (JSON array of encoded request strings).
    static var pendingRequestsQueueURL: URL? {
        appGroupContainerURL?.appendingPathComponent(UserDefaultsKeys.pendingRequestsFile)
    }

    /// UserDefaults keys and file names for App Group communication.
    enum UserDefaultsKeys {
        /// File name for the FIFO queue of pending tool requests (within the App Group container).
        static let pendingRequestsFile = "pending_requests.json"

        /// UserDefaults key prefix for per-request tool responses; append the requestId to form the full key.
        static let toolResponsePrefix = "toolResponse_"

        static let mcpConnectionStatus = "mcpConnectionStatus"
    }
}
