import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var mcpServer: MCPSocketServer?
    private var toolRouter: ToolRouter?

    func applicationDidFinishLaunching(_ notification: Notification) {
        startMCPServer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        mcpServer?.stop()
    }

    private func startMCPServer() {
        let framer = MessageFramer()
        mcpServer = MCPSocketServer(framer: framer)
        toolRouter = ToolRouter()

        mcpServer?.delegate = toolRouter

        do {
            try mcpServer?.start()
            NSLog("MCP Socket Server started at: \(mcpServer?.socketPath ?? "unknown")")
        } catch {
            NSLog("Failed to start MCP Socket Server: \(error)")
        }
    }
}
