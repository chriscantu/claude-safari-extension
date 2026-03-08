import Foundation

/// Routes incoming MCP tool requests to the appropriate handler.
/// Native-handled tools (screenshot, resize, file read) are executed directly.
/// Extension-handled tools are forwarded to the Safari extension via App Group.
class ToolRouter: NSObject, MCPSocketServerDelegate {
    private weak var server: MCPSocketServer?

    /// Tools that are handled natively by the Swift app (not forwarded to the extension).
    private let nativeTools: Set<String> = [
        "resize_window"
    ]

    /// Tools where the native app handles part of the work (e.g., screenshot capture)
    /// but the extension handles the rest.
    private let hybridTools: Set<String> = [
        "file_upload"
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
        // TODO: Implement via ScreenshotService (Phase 4)
        let response = ToolResponse.failure(message: "Screenshot not yet implemented")
        sendResponse(response, to: clientId)
    }

    private func handleNativeTool(_ request: ToolRequest, clientId: String) {
        // TODO: Implement native tool handlers (Phase 5)
        let response = ToolResponse.failure(message: "Native tool '\(request.params.tool)' not yet implemented")
        sendResponse(response, to: clientId)
    }

    private func forwardToExtension(_ request: ToolRequest, clientId: String) {
        // TODO: Implement App Group forwarding to Safari extension (Phase 2 completion)
        let response = ToolResponse.failure(message: "Extension forwarding not yet implemented")
        sendResponse(response, to: clientId)
    }

    private func sendResponse(_ response: ToolResponse, to clientId: String) {
        guard let data = try? JSONEncoder().encode(response) else { return }
        server?.send(data: data, to: clientId)
    }
}
