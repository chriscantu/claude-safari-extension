import SafariServices
import os.log

/// Handles communication between the Safari extension's JavaScript and the native app.
/// See Spec 003 for full specification.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let logger = Logger(
        subsystem: "com.chriscantu.claudeinsafari.extension",
        category: "SafariWebExtensionHandler"
    )

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]

        Self.logger.info("Received message from extension JS: \(String(describing: message))")

        let messageType = message["type"] as? String ?? ""

        switch messageType {
        case "poll":
            handlePoll(context: context)
        case "tool_response":
            handleToolResponse(message: message, context: context)
        case "status":
            handleStatusRequest(context: context)
        default:
            Self.logger.warning("Unknown message type: \(messageType)")
            respond(with: ["status": "error", "message": "Unknown message type"], context: context)
        }
    }

    // MARK: - Message Handlers

    private func handlePoll(context: NSExtensionContext) {
        let defaults = UserDefaults(suiteName: AppConstants.appGroupId)
        if let requestJSON = defaults?.string(forKey: AppConstants.UserDefaultsKeys.pendingToolRequest) {
            // Clear the pending request
            defaults?.removeObject(forKey: AppConstants.UserDefaultsKeys.pendingToolRequest)
            respond(with: ["type": "tool_request", "payload": requestJSON], context: context)
        } else {
            respond(with: ["type": "no_request"], context: context)
        }
    }

    private func handleToolResponse(message: [String: Any], context: NSExtensionContext) {
        let defaults = UserDefaults(suiteName: AppConstants.appGroupId)
        if let responseData = try? JSONSerialization.data(withJSONObject: message),
           let responseString = String(data: responseData, encoding: .utf8) {
            defaults?.set(responseString, forKey: AppConstants.UserDefaultsKeys.pendingToolResponse)
        }
        respond(with: ["status": "ok"], context: context)
    }

    private func handleStatusRequest(context: NSExtensionContext) {
        let defaults = UserDefaults(suiteName: AppConstants.appGroupId)
        let isConnected = defaults?.bool(forKey: AppConstants.UserDefaultsKeys.mcpConnectionStatus) ?? false
        respond(with: ["status": "ok", "mcpConnected": isConnected], context: context)
    }

    // MARK: - Helpers

    private func respond(with payload: [String: Any], context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response])
    }
}
