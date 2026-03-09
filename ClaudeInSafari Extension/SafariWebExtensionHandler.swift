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

    /// Write the tool response to a file in the App Group responses directory so ToolRouter can pick it up.
    /// Uses file-based IPC instead of UserDefaults because UserDefaults(suiteName:) fails on macOS
    /// development builds due to cfprefsd rejecting App Group container access.
    private func handleToolResponse(message: [String: Any], context: NSExtensionContext) {
        guard let requestId = message["requestId"] as? String else {
            Self.logger.warning("tool_response missing requestId")
            respond(with: ["status": "error", "message": "Missing requestId"], context: context)
            return
        }

        guard let responseURL = AppConstants.responseFileURL(for: requestId) else {
            Self.logger.error("tool_response: responseFileURL is nil (App Group unavailable)")
            respond(with: ["status": "error", "message": "App Group unavailable"], context: context)
            return
        }

        guard let responseData = try? JSONSerialization.data(withJSONObject: message) else {
            Self.logger.error("tool_response: failed to serialize response for requestId \(requestId)")
            respond(with: ["status": "error", "message": "Response serialization failed"], context: context)
            return
        }

        do {
            // Create the responses directory if it doesn't exist yet.
            let dir = responseURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try responseData.write(to: responseURL, options: .atomic)
        } catch {
            Self.logger.error("tool_response: failed to write response file for \(requestId): \(error.localizedDescription)")
            respond(with: ["status": "error", "message": "Failed to write response file"], context: context)
            return
        }

        respond(with: ["status": "ok"], context: context)
    }

    private func handleStatusRequest(context: NSExtensionContext) {
        // Read connection status from the App Group container file to avoid cfprefsd issues.
        // Fall back to true (connected) if the file is unreadable — if the socket is alive,
        // the native app is running and effectively connected.
        var isConnected = true
        if let url = AppConstants.appGroupContainerURL?.appendingPathComponent("mcp_connected"),
           let data = try? Data(contentsOf: url),
           let value = String(data: data, encoding: .utf8) {
            isConnected = value.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
        }
        respond(with: ["status": "ok", "mcpConnected": isConnected], context: context)
    }

    // MARK: - Helpers

    /// Remove and return the first JSON string from the App Group FIFO queue file.
    /// Uses NSFileCoordinator to reduce the risk of cross-process read-modify-write races with ToolRouter.
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
            let data: Data
            do {
                data = try Data(contentsOf: writingURL)
            } catch let error as NSError where error.code == NSFileReadNoSuchFileError {
                // File doesn't exist yet — queue is empty, this is normal
                return
            } catch {
                Self.logger.error("dequeueToolRequest: failed to read queue file: \(error.localizedDescription)")
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
