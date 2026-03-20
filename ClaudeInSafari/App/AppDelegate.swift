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
        // Note: notification authorization is deferred until after onboarding completes
        // (or requested immediately if onboarding is skipped) to avoid showing a system
        // permission dialog on top of the onboarding window.
        registerNotificationCategories()
        setupMenuBar()
        startMCPServer()
        checkAndShowOnboardingIfNeeded()
        checkBridgePathMismatch()
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
        controller.onInstallIntegration = { [weak self] in self?.runBridgeInstall() }
        controller.onUninstallIntegration = { [weak self] in self?.runBridgeUninstall() }
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
                self.requestNotificationAuthorization()
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
                self?.requestNotificationAuthorization()
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
                alert.messageText = "\(AppConstants.appDisplayName) is connected"
                alert.informativeText = "All permissions are granted. Claude Code can use Safari."
                alert.alertStyle = .informational
            } else {
                alert.messageText = "\(AppConstants.appDisplayName) needs attention"
                alert.informativeText = "One or more permissions are missing. Use 'Open Setup Again' to fix them."
                alert.alertStyle = .warning
            }
            alert.runModal()
        }
    }

    // MARK: - Notification Authorization

    /// Registers notification categories (no dialog). Safe to call at any time.
    private func registerNotificationCategories() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

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
    }

    /// Requests notification authorization (may show a system dialog).
    /// Called after onboarding completes or immediately if onboarding is skipped.
    private func requestNotificationAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
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

    // MARK: - Claude Integration

    private func runBridgeInstall() {
        if AppConstants.isSandboxed {
            copyBridgeCommandAndOpenTerminal("--install --verify",
                                             alertTitle: "Install command copied",
                                             alertBody: "Paste (⌘V) in Terminal and press Enter to configure Claude Code and Desktop.")
        } else {
            Self.runBridge(arguments: ["--install", "--verify"],
                           successTitle: "Claude Integration installed",
                           failureTitle: "Installation failed")
        }
    }

    private func runBridgeUninstall() {
        if AppConstants.isSandboxed {
            copyBridgeCommandAndOpenTerminal("--uninstall",
                                             alertTitle: "Uninstall command copied",
                                             alertBody: "Paste (⌘V) in Terminal and press Enter.")
        } else {
            Self.runBridge(arguments: ["--uninstall"],
                           successTitle: "Claude Integration removed",
                           failureTitle: "Uninstallation failed")
        }
    }

    /// Copies the bridge command to the clipboard and opens Terminal.app (sandboxed flow).
    private func copyBridgeCommandAndOpenTerminal(_ flags: String, alertTitle: String, alertBody: String) {
        let command = "\"\(AppConstants.bridgeBinaryPath)\" \(flags)"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)

        let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.openApplication(at: terminalURL, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error = error {
                NSLog("AppDelegate: failed to open Terminal — %@", error.localizedDescription)
            }
        }

        let alert = NSAlert()
        alert.messageText = alertTitle
        alert.informativeText = alertBody
        alert.alertStyle = .informational
        alert.runModal()
    }

    /// Runs the bridge binary on a background queue and shows a result alert (unsandboxed flow).
    /// Shared by install and uninstall paths.
    static func runBridge(arguments: [String], successTitle: String, failureTitle: String, onSuccess: (() -> Void)? = nil) {
        let bridgePath = AppConstants.bridgeBinaryPath
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: bridgePath)
            process.arguments = arguments
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            do {
                try process.run()
                process.waitUntilExit()
                let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let output = stderr.isEmpty ? stdout : "\(stdout)\n\(stderr)"

                DispatchQueue.main.async {
                    if process.terminationStatus == 0 {
                        onSuccess?()
                        let alert = NSAlert()
                        alert.messageText = successTitle
                        alert.informativeText = stdout
                        alert.alertStyle = .informational
                        alert.runModal()
                    } else {
                        let alert = NSAlert()
                        alert.messageText = failureTitle
                        alert.informativeText = output
                        alert.alertStyle = .warning
                        alert.runModal()
                    }
                }
            } catch {
                NSLog("AppDelegate: failed to run bridge — %@", error.localizedDescription)
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Failed to run safari-mcp-bridge"
                    alert.informativeText = "Could not launch: \(error.localizedDescription)"
                    alert.alertStyle = .critical
                    alert.runModal()
                }
            }
        }
    }

    /// Checks if the bridge path in the install marker file differs from the current app bundle path.
    /// Shows an alert offering to re-run --install if a mismatch is detected.
    private func checkBridgePathMismatch() {
        guard let markerURL = AppConstants.mcpConfigInstalledURL,
              FileManager.default.fileExists(atPath: markerURL.path),
              let data = try? Data(contentsOf: markerURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let installedPath = json["bridge_path"] as? String else { return }

        let currentPath = AppConstants.bridgeBinaryPath
        guard installedPath != currentPath else { return }

        // Path mismatch — app was moved since last install
        DispatchQueue.main.async { [weak self] in
            let alert = NSAlert()
            alert.messageText = "Claude Integration needs update"
            alert.informativeText = "The app was moved since the MCP config was installed. Update the config to keep Claude Code connected."
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Update Now")
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn {
                self?.runBridgeInstall()
            }
        }
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

        toolRouter?.performStartupCleanup()

        do {
            try mcpServer?.start()
            NSLog("MCP Socket Server started at: \(mcpServer?.socketPath ?? "unknown")")
        } catch {
            NSLog("Failed to start MCP Socket Server: \(error)")
            let alert = NSAlert()
            alert.messageText = "\(AppConstants.appDisplayName): MCP Server Failed to Start"
            alert.informativeText = "Could not start the MCP socket server:\n\(error.localizedDescription)\n\nThe extension will not function. Check Console for details."
            alert.alertStyle = .critical
            alert.runModal()
            NSApplication.shared.terminate(nil)
        }
    }
}
