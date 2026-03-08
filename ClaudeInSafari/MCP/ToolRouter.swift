import Foundation

/// Routes incoming MCP tool requests to the appropriate handler.
/// Native-handled tools (screenshot, resize) are executed directly.
/// Extension-handled tools are forwarded via the App Group FIFO queue file.
class ToolRouter: MCPSocketServerDelegate {
    private weak var server: MCPSocketServer?

    /// Tools that are handled natively by the Swift app (not forwarded to the extension).
    private let nativeTools: Set<String> = [
        "resize_window"
    ]

    func setServer(_ server: MCPSocketServer) {
        self.server = server
    }

    // MARK: - MCPSocketServerDelegate

    func socketServer(_ server: MCPSocketServer, didReceiveMessage data: Data, from clientId: String) {
        do {
            let request = try JSONDecoder().decode(ToolRequest.self, from: data)
            let toolName = request.params.tool

            if isNativeScreenshot(request) {
                handleScreenshot(clientId: clientId)
            } else if nativeTools.contains(toolName) {
                handleNativeTool(request, clientId: clientId)
            } else {
                forwardToExtension(request, clientId: clientId)
            }
        } catch {
            let response = ToolResponse.failure(message: "Failed to decode tool request: \(error.localizedDescription)")
            sendResponse(response, to: clientId)
        }
    }

    func socketServer(_ server: MCPSocketServer, didConnect clientId: String) {
        NSLog("MCP client connected: \(clientId)")
    }

    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String) {
        NSLog("MCP client disconnected: \(clientId)")
    }

    // MARK: - Private

    private func isNativeScreenshot(_ request: ToolRequest) -> Bool {
        guard request.params.tool == "computer" else { return false }
        if let action = request.params.args["action"]?.value as? String {
            return action == "screenshot" || action == "zoom"
        }
        return false
    }

    private func handleScreenshot(clientId: String) {
        // TODO: Implement via ScreenshotService (Phase 5)
        let response = ToolResponse.failure(message: "Screenshot not yet implemented")
        sendResponse(response, to: clientId)
    }

    private func handleNativeTool(_ request: ToolRequest, clientId: String) {
        // TODO: Implement native tool handlers (Phase 5/6)
        let response = ToolResponse.failure(message: "Native tool '\(request.params.tool)' not yet implemented")
        sendResponse(response, to: clientId)
    }

    /// Enqueue the request in the App Group FIFO file and poll asynchronously for the extension's response.
    private func forwardToExtension(_ request: ToolRequest, clientId: String) {
        let requestId = UUID().uuidString
        let queued = QueuedToolRequest(
            requestId: requestId,
            tool: request.params.tool,
            args: request.params.args,
            context: NativeMessageContext(clientId: request.params.clientId, tabGroupId: nil)
        )

        guard enqueueToolRequest(queued) else {
            sendResponse(ToolResponse.failure(message: "Failed to enqueue tool request"), to: clientId)
            return
        }

        pollForExtensionResponse(requestId: requestId, clientId: clientId, deadline: Date().addingTimeInterval(30))
    }

    /// Write a QueuedToolRequest (as a JSON string) to the tail of the App Group FIFO queue file.
    @discardableResult
    private func enqueueToolRequest(_ queued: QueuedToolRequest) -> Bool {
        guard let url = AppConstants.pendingRequestsQueueURL else {
            NSLog("enqueueToolRequest: pendingRequestsQueueURL is nil (App Group unavailable)")
            return false
        }
        guard let itemData = try? JSONEncoder().encode(queued) else {
            NSLog("enqueueToolRequest: failed to encode QueuedToolRequest for tool '\(queued.tool)'")
            return false
        }
        guard let itemString = String(data: itemData, encoding: .utf8) else {
            NSLog("enqueueToolRequest: encoded JSON is not valid UTF-8")
            return false
        }

        var queue: [String] = []
        if let existing = try? Data(contentsOf: url) {
            queue = (try? JSONDecoder().decode([String].self, from: existing)) ?? []
        }
        queue.append(itemString)

        guard let encoded = try? JSONEncoder().encode(queue) else { return false }
        do {
            try encoded.write(to: url, options: .atomic)
            return true
        } catch {
            NSLog("Failed to write request queue: \(error)")
            return false
        }
    }

    /// Recursively poll UserDefaults for the extension's response to `requestId`.
    /// Schedules itself every 50 ms on a background queue; gives up after `deadline`.
    private func pollForExtensionResponse(requestId: String, clientId: String, deadline: Date) {
        let key = AppConstants.UserDefaultsKeys.toolResponsePrefix + requestId
        let defaults = UserDefaults(suiteName: AppConstants.appGroupId)

        if let responseString = defaults?.string(forKey: key) {
            defaults?.removeObject(forKey: key)
            sendResponse(decodeExtensionResponse(responseString), to: clientId)
            return
        }

        guard Date() < deadline else {
            sendResponse(ToolResponse.failure(message: "Extension response timeout (30s)"), to: clientId)
            return
        }

        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self = self else {
                NSLog("pollForExtensionResponse: ToolRouter deallocated, client \(clientId) will hang for requestId \(requestId)")
                return
            }
            self.pollForExtensionResponse(requestId: requestId, clientId: clientId, deadline: deadline)
        }
    }

    /// Decode the JSON string stored by SafariWebExtensionHandler into a ToolResponse.
    private func decodeExtensionResponse(_ json: String) -> ToolResponse {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ToolResponse.failure(message: "Failed to decode extension response")
        }

        if let resultDict = dict["result"] as? [String: Any],
           let contentArray = resultDict["content"] as? [[String: Any]] {
            let blocks = contentArray.compactMap { ContentBlock(from: $0) }
            return ToolResponse(type: "tool_response", result: ToolResponseContent(content: blocks), error: nil)
        }

        if let errorDict = dict["error"] as? [String: Any],
           let contentArray = errorDict["content"] as? [[String: Any]] {
            let blocks = contentArray.compactMap { ContentBlock(from: $0) }
            return ToolResponse(type: "tool_response", result: nil, error: ToolResponseContent(content: blocks))
        }

        return ToolResponse.failure(message: "Malformed extension response")
    }

    private func sendResponse(_ response: ToolResponse, to clientId: String) {
        do {
            let data = try JSONEncoder().encode(response)
            server?.send(data: data, to: clientId)
        } catch {
            NSLog("sendResponse: failed to encode ToolResponse for client \(clientId): \(error)")
        }
    }
}

private extension ContentBlock {
    init?(from dict: [String: Any]) {
        guard let type = dict["type"] as? String else { return nil }
        self.init(
            type: type,
            text: dict["text"] as? String,
            data: dict["data"] as? String,
            mediaType: dict["mediaType"] as? String
        )
    }
}
