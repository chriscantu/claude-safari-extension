import Foundation

/// Shared constants between the native app and Safari extension.
enum AppConstants {
    /// App Group identifier for shared data between app and extension.
    static let appGroupId = "group.com.chriscantu.claudeinsafari"

    /// The application identifier used by browser.runtime.sendNativeMessage().
    static let nativeAppIdentifier = "com.chriscantu.claudeinsafari"

    /// UserDefaults keys for App Group communication.
    enum UserDefaultsKeys {
        static let pendingToolRequest = "pendingToolRequest"
        static let pendingToolResponse = "pendingToolResponse"
        static let mcpConnectionStatus = "mcpConnectionStatus"
    }
}
