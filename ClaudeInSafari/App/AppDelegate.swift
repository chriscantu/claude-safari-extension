// ClaudeInSafari/App/AppDelegate.swift
import Cocoa
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    // MARK: - Private state

    private var mcpServer: MCPSocketServer?
    var toolRouter: ToolRouter?
    private var menuBarController: MenuBarController?
    private var onboardingWindowController: OnboardingWindowController?
    private var monitorTimer: Timer?
    private let permissionMonitor = PermissionMonitor()

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        requestNotificationAuthorization()
        setupMenuBar()
        startMCPServer()
        checkAndShowOnboardingIfNeeded()
    }

    func applicationWillTerminate(_ notification: Notification) {
        monitorTimer?.invalidate()
        mcpServer?.stop()
    }

    // MARK: - Menu Bar

    private func setupMenuBar() {
        let controller = MenuBarController()
        controller.onOpenSetup = { [weak self] in
            guard let self else { return }
            self.permissionMonitor.checkAll { [weak self] status in
                self?.showOnboarding(startingAt: status.firstIncompleteStep, allComplete: status.allGranted)
            }
        }
        controller.onCheckConnection = { [weak self] in self?.checkConnection() }
        menuBarController = controller
    }

    private func updateMenuBarState() {
        permissionMonitor.checkAll { [weak self] status in
            guard let self else { return }
            let state = MenuBarController.menuBarState(from: status)
            self.menuBarController?.setState(state)
        }
    }

    // MARK: - Onboarding

    private func checkAndShowOnboardingIfNeeded() {
        permissionMonitor.checkAll { [weak self] status in
            guard let self else { return }
            if !status.allGranted {
                self.showOnboarding(startingAt: status.firstIncompleteStep)
            } else {
                self.startContinuousMonitoring()
                self.menuBarController?.setState(.connected)
            }
        }
    }

    private func showOnboarding(startingAt step: OnboardingStep? = nil, allComplete: Bool = false) {
        // Pause background monitoring while onboarding is active; it restarts on dismiss.
        monitorTimer?.invalidate()
        monitorTimer = nil
        if onboardingWindowController == nil {
            let wc = OnboardingWindowController(monitor: permissionMonitor)
            wc.onDismiss = { [weak self] in
                self?.onboardingWindowController = nil
                self?.startContinuousMonitoring()
                self?.updateMenuBarState()
            }
            onboardingWindowController = wc
        }
        onboardingWindowController?.showOnboarding(startingAt: step, allComplete: allComplete)
    }

    // MARK: - Continuous Monitoring

    private func startContinuousMonitoring() {
        // Guard is idempotent — safe to call from both onDismiss and checkAndShowOnboardingIfNeeded.
        guard monitorTimer == nil else { return }
        monitorTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateMenuBarState()
        }
    }

    // MARK: - Connection Check

    private func checkConnection() {
        permissionMonitor.checkAll { [weak self] status in
            guard let self else { return }
            self.menuBarController?.setState(MenuBarController.menuBarState(from: status))
            let alert = NSAlert()
            if status.allGranted {
                alert.messageText = "Claude in Safari is connected"
                alert.informativeText = "All permissions are granted. Claude Code can use Safari."
                alert.alertStyle = .informational
            } else {
                alert.messageText = "Claude in Safari needs attention"
                alert.informativeText = "One or more permissions are missing. Use 'Open Setup Again' to fix them."
                alert.alertStyle = .warning
            }
            alert.runModal()
        }
    }

    // MARK: - Notification Authorization

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

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error = error {
                NSLog("Notification authorization error: \(error.localizedDescription)")
            } else if !granted {
                NSLog("AppDelegate: notification authorization denied — automation notifications and Stop action will be suppressed")
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        handleNotificationAction(response.actionIdentifier)
        completionHandler()
    }

    /// Routes a notification action identifier to the appropriate handler.
    /// Extracted from userNotificationCenter(_:didReceive:) for testability.
    func handleNotificationAction(_ identifier: String) {
        if identifier == "stop-automation" {
            if let router = toolRouter {
                router.cancelCurrentRequest()
            } else {
                NSLog("AppDelegate: received stop-automation but toolRouter is nil")
            }
        } else if identifier != UNNotificationDefaultActionIdentifier {
            NSLog("AppDelegate: unhandled notification action identifier '%@'", identifier)
        }
    }

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
