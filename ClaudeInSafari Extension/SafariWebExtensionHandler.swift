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

    /// Dequeue the next pending tool request from the App Group FIFO file.
    private func handlePoll(context: NSExtensionContext) {
        if let payload = dequeueToolRequest() {
            respond(with: ["type": "tool_request", "payload": payload], context: context)
        } else {
            respond(with: ["type": "no_request"], context: context)
        }
    }

    /// Store the tool response in UserDefaults keyed by requestId so ToolRouter can pick it up.
    private func handleToolResponse(message: [String: Any], context: NSExtensionContext) {
        guard let requestId = message["requestId"] as? String else {
            Self.logger.warning("tool_response missing requestId")
            respond(with: ["status": "error", "message": "Missing requestId"], context: context)
            return
        }

        guard let defaults = UserDefaults(suiteName: AppConstants.appGroupId) else {
            Self.logger.error("tool_response: failed to open App Group UserDefaults suite")
            respond(with: ["status": "error", "message": "App Group unavailable"], context: context)
            return
        }

        guard let responseData = try? JSONSerialization.data(withJSONObject: message),
              let responseString = String(data: responseData, encoding: .utf8) else {
            Self.logger.error("tool_response: failed to serialize response for requestId \(requestId)")
            respond(with: ["status": "error", "message": "Response serialization failed"], context: context)
            return
        }

        let key = AppConstants.UserDefaultsKeys.toolResponsePrefix + requestId
        defaults.set(responseString, forKey: key)
        respond(with: ["status": "ok"], context: context)
    }

    private func handleStatusRequest(context: NSExtensionContext) {
        guard let defaults = UserDefaults(suiteName: AppConstants.appGroupId) else {
            Self.logger.error("handleStatusRequest: App Group UserDefaults unavailable")
            respond(with: ["status": "error", "message": "App Group unavailable"], context: context)
            return
        }
        let isConnected = defaults.bool(forKey: AppConstants.UserDefaultsKeys.mcpConnectionStatus)
        respond(with: ["status": "ok", "mcpConnected": isConnected], context: context)
    }

    // MARK: - Helpers

    /// Remove and return the first JSON string from the App Group FIFO queue file.
    /// Uses NSFileCoordinator to prevent cross-process read-modify-write races with ToolRouter.
    /// Returns nil if the queue is empty, the file does not exist, or write-back fails.
    /// Write-back failure returns nil to prevent double-execution of the same request.
    private func dequeueToolRequest() -> String? {
        guard let url = AppConstants.pendingRequestsQueueURL else {
            Self.logger.error("dequeueToolRequest: pendingRequestsQueueURL is nil (App Group unavailable)")
            return nil
        }

        var first: String? = nil
        let coordinator = NSFileCoordinator()
        var coordinatorError: NSError?
        coordinator.coordinate(writingItemAt: url, options: .forMerging, error: &coordinatorError) { writingURL in
            guard let data = try? Data(contentsOf: writingURL) else {
                // File doesn't exist yet — queue is empty, this is normal
                return
            }
            guard var queue = try? JSONDecoder().decode([String].self, from: data) else {
                Self.logger.error("dequeueToolRequest: failed to decode queue JSON — file may be corrupt")
                return
            }
            guard !queue.isEmpty else { return }

            first = queue.removeFirst()

            guard let updated = try? JSONEncoder().encode(queue) else {
                Self.logger.error("dequeueToolRequest: failed to encode updated queue, aborting to prevent double-execution")
                first = nil
                return
            }
            do {
                try updated.write(to: writingURL, options: .atomic)
            } catch {
                Self.logger.error("dequeueToolRequest: failed to write updated queue: \(error.localizedDescription), aborting to prevent double-execution")
                first = nil
            }
        }
        if let err = coordinatorError {
            Self.logger.error("dequeueToolRequest: file coordination failed: \(err.localizedDescription)")
        }
        return first
    }

    private func respond(with payload: [String: Any], context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response])
    }
}
