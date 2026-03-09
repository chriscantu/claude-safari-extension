import Cocoa

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
        if let server = mcpServer {
            toolRouter?.setServer(server)
        }

        do {
            try mcpServer?.start()
            NSLog("MCP Socket Server started at: \(mcpServer?.socketPath ?? "unknown")")
        } catch {
            NSLog("Failed to start MCP Socket Server: \(error)")
            let alert = NSAlert()
            alert.messageText = "Claude in Safari: MCP Server Failed to Start"
            alert.informativeText = "Could not start the MCP socket server:\n\(error.localizedDescription)\n\nThe extension will not function. Check Console for details."
            alert.alertStyle = .critical
            alert.runModal()
            NSApplication.shared.terminate(nil)
        }
    }
}
