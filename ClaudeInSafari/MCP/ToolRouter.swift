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

    /// Maps clientId → set of active requestIds so disconnects can stop all pending polls for a client.
    /// Note: one already-queued asyncAfter may fire after a disconnect before the guard check stops it.
    private var activePolls = [String: Set<String>]()
    private let activePollsLock = NSLock()

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
        activePollsLock.lock()
        activePolls.removeValue(forKey: clientId)
        activePollsLock.unlock()
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

        activePollsLock.lock()
        activePolls[clientId, default: Set()].insert(requestId)
        activePollsLock.unlock()

        pollForExtensionResponse(requestId: requestId, clientId: clientId, deadline: Date().addingTimeInterval(30))
    }

    /// Write a QueuedToolRequest (as a JSON string) to the tail of the App Group FIFO queue file.
    /// Uses NSFileCoordinator to reduce the risk of cross-process read-modify-write races with SafariWebExtensionHandler.
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

        var success = false
        let coordinator = NSFileCoordinator()
        var coordinatorError: NSError?
        coordinator.coordinate(writingItemAt: url, options: .forMerging, error: &coordinatorError) { writingURL in
            var queue: [String] = []
            do {
                let existing = try Data(contentsOf: writingURL)
                queue = (try? JSONDecoder().decode([String].self, from: existing)) ?? []
            } catch let error as NSError where error.code == NSFileReadNoSuchFileError {
                // File doesn't exist yet — queue is empty, this is normal
            } catch {
                NSLog("enqueueToolRequest: failed to read request queue: \(error.localizedDescription)")
                return
            }
            queue.append(itemString)
            guard let encoded = try? JSONEncoder().encode(queue) else {
                NSLog("enqueueToolRequest: failed to encode updated queue for tool '\(queued.tool)'")
                return
            }
            do {
                try encoded.write(to: writingURL, options: .atomic)
                success = true
            } catch {
                NSLog("enqueueToolRequest: failed to write request queue: \(error.localizedDescription)")
            }
        }
        if let err = coordinatorError {
            NSLog("enqueueToolRequest: file coordination failed: \(err.localizedDescription)")
        }
        return success
    }

    /// Recursively poll UserDefaults for the extension's response to `requestId`.
    /// Schedules itself every 50 ms on a background queue; gives up after `deadline` or client disconnect.
    private func pollForExtensionResponse(requestId: String, clientId: String, deadline: Date) {
        guard let defaults = UserDefaults(suiteName: AppConstants.appGroupId) else {
            NSLog("pollForExtensionResponse: App Group UserDefaults unavailable, failing immediately for requestId \(requestId)")
            activePollsLock.lock()
            activePolls[clientId]?.remove(requestId)
            activePollsLock.unlock()
            sendResponse(ToolResponse.failure(message: "App Group unavailable"), to: clientId)
            return
        }

        let key = AppConstants.UserDefaultsKeys.toolResponsePrefix + requestId

        if let responseString = defaults.string(forKey: key) {
            defaults.removeObject(forKey: key)
            activePollsLock.lock()
            activePolls[clientId]?.remove(requestId)
            activePollsLock.unlock()
            sendResponse(decodeExtensionResponse(responseString), to: clientId)
            return
        }

        guard Date() < deadline else {
            activePollsLock.lock()
            activePolls[clientId]?.remove(requestId)
            activePollsLock.unlock()
            sendResponse(ToolResponse.failure(message: "Extension response timeout (30s)"), to: clientId)
            return
        }

        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self = self else {
                NSLog("pollForExtensionResponse: ToolRouter deallocated, aborting poll for requestId \(requestId)")
                return
            }
            self.activePollsLock.lock()
            let isActive = self.activePolls[clientId]?.contains(requestId) == true
            self.activePollsLock.unlock()
            guard isActive else {
                NSLog("pollForExtensionResponse: client \(clientId) disconnected, cancelling poll for requestId \(requestId)")
                return
            }
            self.pollForExtensionResponse(requestId: requestId, clientId: clientId, deadline: deadline)
        }
    }

    /// Decode the JSON string stored by SafariWebExtensionHandler into a ToolResponse.
    func decodeExtensionResponse(_ json: String) -> ToolResponse {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ToolResponse.failure(message: "Failed to decode extension response")
        }

        if let resultDict = dict["result"] as? [String: Any],
           let contentArray = resultDict["content"] as? [[String: Any]] {
            let blocks = contentArray.compactMap { rawBlock -> ContentBlock? in
                if let block = ContentBlock(from: rawBlock) { return block }
                NSLog("decodeExtensionResponse: dropped malformed content block: \(rawBlock)")
                return nil
            }
            if blocks.isEmpty && !contentArray.isEmpty {
                return ToolResponse.failure(message: "Extension response contained no valid content blocks")
            }
            return ToolResponse(type: "tool_response", result: ToolResponseContent(content: blocks), error: nil)
        }

        if let errorDict = dict["error"] as? [String: Any],
           let contentArray = errorDict["content"] as? [[String: Any]] {
            let blocks = contentArray.compactMap { rawBlock -> ContentBlock? in
                if let block = ContentBlock(from: rawBlock) { return block }
                NSLog("decodeExtensionResponse: dropped malformed content block: \(rawBlock)")
                return nil
            }
            if blocks.isEmpty && !contentArray.isEmpty {
                return ToolResponse.failure(message: "Extension response contained no valid content blocks")
            }
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
