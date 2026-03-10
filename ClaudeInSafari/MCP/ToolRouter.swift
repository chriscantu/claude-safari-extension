import Foundation

/// Routes incoming MCP JSON-RPC 2.0 requests to the appropriate handler.
/// Implements the MCP stdio transport protocol: initialize handshake, tools/list, and tools/call.
class ToolRouter: MCPSocketServerDelegate {
    private weak var server: MCPSocketServer?
    private let screenshotService = ScreenshotService()

    /// Tools handled natively by the Swift app (not forwarded to the extension).
    private let nativeTools: Set<String> = ["resize_window"]

    /// Maps requestId → (clientId, jsonrpcId) for in-flight extension calls.
    private var pendingRequests = [String: (clientId: String, jsonrpcId: Any?)]()
    private let pendingRequestsLock = NSLock()

    func setServer(_ server: MCPSocketServer) {
        self.server = server
    }

    // MARK: - MCPSocketServerDelegate

    func socketServer(_ server: MCPSocketServer, didReceiveMessage data: Data, from clientId: String) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let method = json["method"] as? String else {
            NSLog("ToolRouter: received non-JSON-RPC message from \(clientId)")
            return
        }

        let id = json["id"] // nil for notifications (no "id" key in JSON)

        switch method {
        case "initialize":
            handleInitialize(id: id, clientId: clientId)
        case "notifications/initialized":
            break // Notification — no response required
        case "tools/list":
            handleToolsList(id: id, clientId: clientId)
        case "tools/call":
            handleToolCall(id: id, params: json["params"] as? [String: Any], clientId: clientId)
        default:
            if id != nil {
                sendError(id: id, code: -32601, message: "Method not found: \(method)", to: clientId)
            }
        }
    }

    func socketServer(_ server: MCPSocketServer, didConnect clientId: String) {
        NSLog("MCP client connected: \(clientId)")
    }

    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String) {
        NSLog("MCP client disconnected: \(clientId)")
        pendingRequestsLock.lock()
        let toCancel = pendingRequests.filter { $0.value.clientId == clientId }.map { $0.key }
        toCancel.forEach { pendingRequests.removeValue(forKey: $0) }
        pendingRequestsLock.unlock()
    }

    // MARK: - MCP Protocol Handlers

    private func handleInitialize(id: Any?, clientId: String) {
        sendResult(id: id, result: [
            "protocolVersion": "2025-11-25",
            "capabilities": ["tools": [String: Any]()],
            "serverInfo": ["name": "claude-safari", "version": "1.0.0"]
        ], to: clientId)
    }

    private func handleToolsList(id: Any?, clientId: String) {
        sendResult(id: id, result: ["tools": Self.toolDefinitions], to: clientId)
    }

    private func handleToolCall(id: Any?, params: [String: Any]?, clientId: String) {
        guard let toolName = params?["name"] as? String else {
            sendError(id: id, code: -32602, message: "Missing tool name in tools/call", to: clientId)
            return
        }

        let arguments = (params?["arguments"] as? [String: Any]) ?? [:]

        if toolName == "computer",
           let action = arguments["action"] as? String,
           action == "screenshot" || action == "zoom" {
            handleScreenshotAction(action: action, arguments: arguments, id: id, clientId: clientId)
        } else if nativeTools.contains(toolName) {
            sendError(id: id, code: -32000, message: "Native tool '\(toolName)' not yet implemented", to: clientId)
        } else {
            let queued = QueuedToolRequest(
                requestId: UUID().uuidString,
                tool: toolName,
                args: arguments.mapValues { AnyCodable($0) },
                context: NativeMessageContext(clientId: clientId, tabGroupId: nil)
            )
            forwardToExtension(queued, id: id, clientId: clientId)
        }
    }

    // MARK: - Native Screenshot / Zoom

    private func handleScreenshotAction(action: String, arguments: [String: Any], id: Any?, clientId: String) {
        let tabId = arguments["tabId"] as? Int
        if action == "screenshot" {
            screenshotService.captureScreenshot(tabId: tabId) { [self] result in
                sendScreenshotResult(result, id: id, to: clientId)
            }
        } else {
            // zoom — parse region as [Int], tolerating JSON numbers arriving as Double or NSNumber
            let region: [Int]? = {
                guard let raw = arguments["region"] else { return nil }
                if let ints = raw as? [Int] { return ints }
                if let any = raw as? [Any] {
                    let converted = any.compactMap { v -> Int? in
                        if let i = v as? Int { return i }
                        if let d = v as? Double { return Int(d) }
                        if let n = v as? NSNumber { return n.intValue }
                        return nil
                    }
                    return converted.count == 4 ? converted : nil
                }
                return nil
            }()
            screenshotService.captureZoom(tabId: tabId, region: region) { [self] result in
                sendScreenshotResult(result, region: region, id: id, to: clientId)
            }
        }
    }

    private func sendScreenshotResult(_ result: Result<CapturedImage, ScreenshotError>, region: [Int]? = nil, id: Any?, to clientId: String) {
        switch result {
        case .failure(let error):
            sendError(id: id, code: -32000, message: error.userMessage, to: clientId)
        case .success(let captured):
            let base64 = captured.data.base64EncodedString()
            let label: String
            if let r = region {
                label = "Zoomed region [\(r[0]),\(r[1]),\(r[2]),\(r[3])] (imageId: \(captured.imageId))."
            } else {
                label = "Screenshot captured (imageId: \(captured.imageId)). Use this imageId with upload_image."
            }
            let content: [[String: Any]] = [
                ["type": "image", "data": base64, "mediaType": "image/png"],
                ["type": "text", "text": label]
            ]
            sendResult(id: id, result: ["content": content], to: clientId)
        }
    }

    // MARK: - Extension Forwarding

    private func forwardToExtension(_ queued: QueuedToolRequest, id: Any?, clientId: String) {
        guard enqueueToolRequest(queued) else {
            sendError(id: id, code: -32000, message: "Failed to enqueue tool request", to: clientId)
            return
        }

        pendingRequestsLock.lock()
        pendingRequests[queued.requestId] = (clientId: clientId, jsonrpcId: id)
        pendingRequestsLock.unlock()

        pollForExtensionResponse(requestId: queued.requestId, deadline: Date().addingTimeInterval(30))
    }

    private func pollForExtensionResponse(requestId: String, deadline: Date) {
        guard let fileURL = AppConstants.responseFileURL(for: requestId) else {
            failPendingRequest(requestId: requestId, message: "App Group unavailable")
            return
        }

        if let data = try? Data(contentsOf: fileURL),
           let responseString = String(data: data, encoding: .utf8) {
            // Delete the file so it isn't processed twice.
            try? FileManager.default.removeItem(at: fileURL)
            pendingRequestsLock.lock()
            let pending = pendingRequests.removeValue(forKey: requestId)
            pendingRequestsLock.unlock()
            if let pending = pending {
                deliverExtensionResponse(responseString, id: pending.jsonrpcId, to: pending.clientId)
            }
            return
        }

        guard Date() < deadline else {
            failPendingRequest(requestId: requestId, message: "Extension response timeout (30s)")
            return
        }

        pendingRequestsLock.lock()
        let isActive = pendingRequests[requestId] != nil
        pendingRequestsLock.unlock()
        guard isActive else { return }

        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.pollForExtensionResponse(requestId: requestId, deadline: deadline)
        }
    }

    private func failPendingRequest(requestId: String, message: String) {
        pendingRequestsLock.lock()
        let pending = pendingRequests.removeValue(forKey: requestId)
        pendingRequestsLock.unlock()
        if let pending = pending {
            sendError(id: pending.jsonrpcId, code: -32000, message: message, to: pending.clientId)
        }
    }

    // MARK: - Extension Queue

    @discardableResult
    private func enqueueToolRequest(_ queued: QueuedToolRequest) -> Bool {
        guard let url = AppConstants.pendingRequestsQueueURL else {
            NSLog("enqueueToolRequest: pendingRequestsQueueURL is nil (App Group unavailable)")
            return false
        }
        guard let itemData = try? JSONEncoder().encode(queued),
              let itemString = String(data: itemData, encoding: .utf8) else {
            NSLog("enqueueToolRequest: failed to encode QueuedToolRequest for tool '\(queued.tool)'")
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
                NSLog("enqueueToolRequest: failed to read queue: \(error.localizedDescription)")
                return
            }
            queue.append(itemString)
            guard let encoded = try? JSONEncoder().encode(queue) else { return }
            do {
                try encoded.write(to: writingURL, options: .atomic)
                success = true
            } catch {
                NSLog("enqueueToolRequest: failed to write queue: \(error.localizedDescription)")
            }
        }
        if let err = coordinatorError {
            NSLog("enqueueToolRequest: file coordination failed: \(err.localizedDescription)")
        }
        return success
    }

    // MARK: - Extension Response Decoding

    /// Parse an extension response JSON string into a typed result.
    /// Separated from deliverExtensionResponse so it can be unit-tested without a live client.
    func decodeExtensionResponse(_ json: String) -> DecodedExtensionResponse {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure("Failed to decode extension response")
        }

        func parseValidBlocks(_ array: [[String: Any]]) -> [ContentBlock]? {
            let blocks = array.compactMap { block -> ContentBlock? in
                guard let type = block["type"] as? String else { return nil }
                return ContentBlock(
                    type: type,
                    text: block["text"] as? String,
                    data: block["data"] as? String,
                    mediaType: block["mediaType"] as? String
                )
            }
            return blocks.isEmpty ? nil : blocks
        }

        if let resultDict = dict["result"] as? [String: Any],
           let rawContent = resultDict["content"] as? [[String: Any]] {
            guard let blocks = parseValidBlocks(rawContent) else {
                return .failure("Extension response contained no valid content blocks")
            }
            return .success(ToolResponseContent(content: blocks))
        }

        if let errorDict = dict["error"] as? [String: Any],
           let rawContent = errorDict["content"] as? [[String: Any]],
           let blocks = parseValidBlocks(rawContent) {
            return DecodedExtensionResponse(result: nil, error: ToolResponseContent(content: blocks))
        }

        return .failure("Malformed extension response")
    }

    private func deliverExtensionResponse(_ json: String, id: Any?, to clientId: String) {
        let decoded = decodeExtensionResponse(json)
        if let result = decoded.result {
            let contentDicts = result.content.map { block -> [String: Any] in
                var out: [String: Any] = ["type": block.type]
                if let text = block.text { out["text"] = text }
                if let data = block.data { out["data"] = data }
                if let mime = block.mediaType { out["mimeType"] = mime }
                return out
            }
            sendResult(id: id, result: ["content": contentDicts], to: clientId)
        } else {
            let message = decoded.error?.content.first?.text ?? "Malformed extension response"
            sendError(id: id, code: -32000, message: message, to: clientId)
        }
    }

    // MARK: - JSON-RPC Response Helpers

    private func sendResult(id: Any?, result: [String: Any], to clientId: String) {
        var response: [String: Any] = ["jsonrpc": "2.0", "result": result]
        if let id = id { response["id"] = id }
        sendJSON(response, to: clientId)
    }

    private func sendError(id: Any?, code: Int, message: String, to clientId: String) {
        var response: [String: Any] = [
            "jsonrpc": "2.0",
            "error": ["code": code, "message": message]
        ]
        if let id = id { response["id"] = id }
        sendJSON(response, to: clientId)
    }

    private func sendJSON(_ dict: [String: Any], to clientId: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else {
            NSLog("ToolRouter: failed to serialize JSON response")
            return
        }
        server?.send(data: data, to: clientId)
    }

    // MARK: - Tool Definitions

    private static let toolDefinitions: [[String: Any]] = [
        tool("tabs_context_mcp", "Get context information about the current MCP tab group.", [:]),
        tool("tabs_create_mcp", "Creates a new empty tab in the MCP tab group.", [:]),
        tool("switch_browser", "Switch which browser is used for browser automation.", [:]),
        tool("navigate", "Navigate to a URL, or go forward/back in browser history.", [
            "url": prop("string", "The URL to navigate to, or 'forward'/'back'"),
            "tabId": prop("number", "Tab ID to navigate")
        ]),
        tool("read_page", "Get an accessibility tree of elements on the page.", [
            "tabId": prop("number", "Tab ID to read from"),
            "filter": prop("string", "'interactive' or 'all'"),
            "depth": prop("number", "Maximum tree depth"),
            "ref_id": prop("string", "Reference ID of a parent element"),
            "max_chars": prop("number", "Maximum characters for output")
        ]),
        tool("find", "Find elements on the page using natural language.", [
            "query": prop("string", "Natural language description of what to find"),
            "tabId": prop("number", "Tab ID to search in")
        ]),
        tool("form_input", "Set values in form elements.", [
            "ref": prop("string", "Element reference ID from read_page"),
            "value": prop("string", "The value to set"),
            "tabId": prop("number", "Tab ID")
        ]),
        tool("computer", "Use mouse and keyboard to interact with a web browser, and take screenshots.", [
            "action": prop("string", "left_click, right_click, double_click, triple_click, type, screenshot, wait, scroll, key, left_click_drag, zoom, scroll_to, hover"),
            "tabId": prop("number", "Tab ID")
        ]),
        tool("javascript_tool", "Execute JavaScript in the context of the current page.", [
            "action": prop("string", "Must be 'javascript_exec'"),
            "text": prop("string", "The JavaScript code to execute"),
            "tabId": prop("number", "Tab ID")
        ]),
        tool("get_page_text", "Extract raw text content from the page.", [
            "tabId": prop("number", "Tab ID")
        ]),
        tool("resize_window", "Resize the current browser window to specified dimensions.", [
            "width": prop("number", "Target window width in pixels"),
            "height": prop("number", "Target window height in pixels"),
            "tabId": prop("number", "Tab ID")
        ]),
        tool("read_console_messages", "Read browser console messages from a specific tab.", [
            "tabId": prop("number", "Tab ID"),
            "pattern": prop("string", "Regex pattern to filter messages"),
            "limit": prop("number", "Maximum number of messages to return"),
            "onlyErrors": prop("boolean", "If true, only return error messages"),
            "clear": prop("boolean", "If true, clear messages after reading")
        ]),
        tool("read_network_requests", "Read HTTP network requests from a specific tab.", [
            "tabId": prop("number", "Tab ID"),
            "urlPattern": prop("string", "URL pattern to filter requests"),
            "limit": prop("number", "Maximum number of requests to return"),
            "clear": prop("boolean", "If true, clear requests after reading")
        ]),
        tool("upload_image", "Upload a previously captured screenshot to a file input or drag & drop target.", [
            "imageId": prop("string", "ID of a previously captured screenshot"),
            "tabId": prop("number", "Tab ID"),
            "ref": prop("string", "Element reference ID for file inputs"),
            "filename": prop("string", "Optional filename for the uploaded file")
        ]),
        tool("file_upload", "Upload one or multiple files from the local filesystem to a file input element.", [
            "paths": prop("array", "Absolute paths to the files to upload"),
            "ref": prop("string", "Element reference ID of the file input"),
            "tabId": prop("number", "Tab ID")
        ]),
        tool("gif_creator", "Manage GIF recording and export for browser automation sessions.", [
            "action": prop("string", "start_recording, stop_recording, export, or clear"),
            "tabId": prop("number", "Tab ID"),
            "filename": prop("string", "Optional filename for exported GIF"),
            "download": prop("boolean", "Set to true to download the GIF")
        ])
    ]

    private static func tool(_ name: String, _ desc: String, _ properties: [String: [String: Any]]) -> [String: Any] {
        return [
            "name": name,
            "description": desc,
            "inputSchema": ["type": "object", "properties": properties]
        ]
    }

    private static func prop(_ type: String, _ description: String) -> [String: Any] {
        return ["type": type, "description": description]
    }
}
