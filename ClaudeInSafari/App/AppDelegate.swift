import Cocoa
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var mcpServer: MCPSocketServer?
    private var toolRouter: ToolRouter?

    func applicationDidFinishLaunching(_ notification: Notification) {
        requestNotificationAuthorization()
        startMCPServer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        mcpServer?.stop()
    }

    // MARK: - Notification Authorization + Category

    private func requestNotificationAuthorization() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // Register the category unconditionally BEFORE requesting authorization.
        // Categories do not require authorization — they must be registered before
        // any notification fires so the "Stop Claude" action button appears even on
        // the very first notification (before the user has responded to the auth dialog).
        let stopAction = UNNotificationAction(
            identifier: "stop-automation",
            title: "Stop Claude",
            options: .destructive
        )
        let category = UNNotificationCategory(
            identifier: "claude-automation",
            actions: [stopAction],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([category])

        center.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error = error {
                NSLog("Notification authorization error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Called when the user taps a notification action (e.g. "Stop Claude").
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == "stop-automation" {
            if let router = toolRouter {
                router.cancelCurrentRequest()
            } else {
                NSLog("AppDelegate: received stop-automation action but toolRouter is nil — cancellation ignored")
            }
        }
        completionHandler()
    }

    /// Show notification banners even when the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner])
    }

    // MARK: - MCP Server

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
