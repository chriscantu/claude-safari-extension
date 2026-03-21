// ClaudeInSafari/App/OnboardingWindowController.swift
import Cocoa
import SafariServices

// MARK: - Layout constants

private enum Layout {
    static let windowWidth: CGFloat  = 440
    static let windowHeight: CGFloat = 480
    static let padding: CGFloat      = 28
    static let iconSizeLg: CGFloat   = 72
    static let iconSizeSm: CGFloat   = 56
    static let cornerLg: CGFloat     = 20
    static let cornerSm: CGFloat     = 16
}

// MARK: - OnboardingScreen

enum OnboardingScreen: Equatable {
    case welcome
    case step(OnboardingStep)
    case connectClaude
    case done
}

// MARK: - OnboardingWindowController

final class OnboardingWindowController: NSWindowController {

    // MARK: Dependencies

    private let monitor: PermissionMonitor

    /// Called when the user finishes or dismisses setup. The caller should
    /// start continuous monitoring and update the menu bar state.
    var onDismiss: (() -> Void)?

    // MARK: Private state

    private(set) var currentScreen: OnboardingScreen = .welcome
    private(set) var pollTimer: Timer?
    private weak var copyButton: NSButton?
    private var copyResetWork: DispatchWorkItem?

    // MARK: Init

    init(monitor: PermissionMonitor = PermissionMonitor()) {
        self.monitor = monitor
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Layout.windowWidth, height: Layout.windowHeight),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = AppConstants.appDisplayName
        window.center()
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    // MARK: - Public API

    /// Shows the onboarding window. If `step` is non-nil, opens directly to that step's screen.
    /// If `step` is nil (the default), opens to the Welcome screen.
    func showOnboarding(startingAt step: OnboardingStep? = nil, allComplete: Bool = false) {
        // If the window is already visible and mid-flow, just bring it to front
        // without resetting state, to avoid interrupting the user mid-step.
        if let existingWindow = window, existingWindow.isVisible {
            if case .welcome = currentScreen {
                // Still on welcome — allow re-navigation to the requested step.
            } else {
                existingWindow.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                return
            }
        }
        if let step = step {
            show(screen: .step(step))
        } else if allComplete {
            show(screen: .done)
        } else {
            show(screen: .welcome)
        }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Screen navigation

    private func show(screen: OnboardingScreen) {
        stopPolling()
        guard window != nil else {
            NSLog("OnboardingWindowController: show(screen:) called with nil window — content view not updated")
            return
        }
        currentScreen = screen
        window?.contentView = buildView(for: screen)
        if case .step(let step) = screen {
            if step == .screenRecording {
                // Silently register in TCC so the app appears in Screen Recording list.
                // No dialog on macOS 14+. Must happen before user navigates to System Settings.
                monitor.registerScreenRecording()
            }
            startPolling(for: step)
        }
        // Note: .connectClaude polling starts when user clicks Install button, not on screen show
    }

    func advance() {
        switch currentScreen {
        case .welcome:
            show(screen: .step(.safariExtension))
        case .step(.safariExtension):
            show(screen: .step(.screenRecording))
        case .step(.screenRecording):
            show(screen: .connectClaude)
        case .connectClaude:
            show(screen: .done)
        case .done:
            dismiss()
        }
    }

    private(set) var dismissed = false
    private(set) var checkInFlight = false
    func dismiss() {
        guard !dismissed else { return }
        dismissed = true
        stopPolling()
        copyResetWork?.cancel()
        close()
        onDismiss?()
    }

    // NOTE: close() is called above in dismiss(). windowWillClose(_:) will fire as a
    // result, but the dismissed flag prevents double-firing of onDismiss.

    // MARK: - Polling

    private func startPolling(for step: OnboardingStep) {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkStepCompletion(step)
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
        checkInFlight = false
    }

    func checkStepCompletion(_ step: OnboardingStep) {
        // Skip if a checkAll is already in-flight; avoids stacking concurrent calls to
        // SFSafariExtensionManager when Safari is slow or restarting.
        guard !checkInFlight else { return }
        checkInFlight = true
        // checkAll delivers on the main queue — no extra dispatch needed.
        monitor.checkAll { [weak self] status in
            guard let self else { return }
            self.checkInFlight = false
            // Guard against callbacks arriving after the controller has already been dismissed.
            guard !self.dismissed else { return }
            // Guard against in-flight callbacks arriving after screen has already changed.
            guard case .step(let currentStep) = self.currentScreen, currentStep == step else { return }
            switch step {
            case .safariExtension where status.extensionEnabled: self.advance()
            case .safariExtension:  break   // permission not yet granted; keep polling
            case .screenRecording where status.screenRecording:  self.advance()
            case .screenRecording:  break   // permission not yet granted; keep polling
            }
        }
    }

    // MARK: - View building

    private func buildView(for screen: OnboardingScreen) -> NSView {
        switch screen {
        case .welcome:                return buildWelcomeView()
        case .step(.safariExtension): return buildSafariExtensionView()
        case .step(.screenRecording): return buildScreenRecordingView()
        case .connectClaude:          return buildConnectClaudeView()
        case .done:                   return buildDoneView()
        }
    }

    // MARK: Welcome

    private func buildWelcomeView() -> NSView {
        let root = paddedRoot()

        // Large robot icon
        let iconView = makeIconView(size: Layout.iconSizeLg, corner: Layout.cornerLg, content: robotIconImage(size: Layout.iconSizeLg * 0.6))
        iconView.frame.origin = CGPoint(x: (Layout.windowWidth - Layout.iconSizeLg) / 2, y: Layout.windowHeight - Layout.padding - Layout.iconSizeLg)
        root.addSubview(iconView)

        // Badge
        let badge = makeBadgeLabel("Works with Claude Code")
        badge.frame = NSRect(x: Layout.padding, y: iconView.frame.minY - 36, width: Layout.windowWidth - Layout.padding * 2, height: 22)
        root.addSubview(badge)

        // Headline
        let headline = makeLabel("Connect Claude Code to Safari", size: 22, weight: .bold)
        headline.frame = NSRect(x: Layout.padding, y: badge.frame.minY - 38, width: Layout.windowWidth - Layout.padding * 2, height: 30)
        root.addSubview(headline)

        // Body
        let body = makeLabel(
            "Claude in Safari is a bridge that gives Claude Code a real browser — so it can navigate pages, fill forms, take screenshots, and automate tasks on your behalf.\n\nSetup takes about 2 minutes.",
            size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true
        )
        body.frame = NSRect(x: Layout.padding, y: headline.frame.minY - 90, width: Layout.windowWidth - Layout.padding * 2, height: 84)
        root.addSubview(body)

        // Primary CTA
        let getStarted = makeButton("Get Started →", action: #selector(getStartedTapped), primary: true)
        getStarted.frame = NSRect(x: Layout.padding, y: 60, width: Layout.windowWidth - Layout.padding * 2, height: 36)
        root.addSubview(getStarted)

        // Ghost CTA
        let later = makeButton("I'll set this up later", action: #selector(laterTapped), primary: false)
        later.frame = NSRect(x: Layout.padding, y: 28, width: Layout.windowWidth - Layout.padding * 2, height: 24)
        root.addSubview(later)

        return root
    }

    @objc private func getStartedTapped() { advance() }
    @objc private func laterTapped()      { dismiss() }

    // MARK: Safari Extension Step

    private func buildSafariExtensionView() -> NSView {
        let root = paddedRoot()

        let iconImage = puzzleIconImage(size: Layout.iconSizeSm * 0.55)
        let iconView = makeIconView(size: Layout.iconSizeSm, corner: Layout.cornerSm, content: iconImage)
        iconView.frame.origin = CGPoint(x: Layout.padding, y: Layout.windowHeight - Layout.padding - Layout.iconSizeSm)
        root.addSubview(iconView)

        let title = makeLabel("Enable the Safari Extension", size: 20, weight: .bold)
        title.frame = NSRect(x: Layout.padding, y: iconView.frame.minY - 36, width: Layout.windowWidth - Layout.padding * 2, height: 26)
        root.addSubview(title)

        let subtitle = makeLabel("This is the part of the bridge that runs inside Safari.", size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
        subtitle.frame = NSRect(x: Layout.padding, y: title.frame.minY - 30, width: Layout.windowWidth - Layout.padding * 2, height: 20)
        root.addSubview(subtitle)

        // Sub-steps
        let subSteps: [(String, String)] = [
            ("1", "Open Safari → Settings → Advanced and enable \"Show features for web developers\""),
            ("2", "In the Develop menu, click \"Allow Unsigned Extensions\""),
            ("3", "Go to Safari → Settings → Extensions and turn on \(AppConstants.appDisplayName)")
        ]
        var y = subtitle.frame.minY - 14
        for (num, text) in subSteps {
            let row = makeSubStep(number: num, text: text)
            row.frame = NSRect(x: Layout.padding, y: y - 44, width: Layout.windowWidth - Layout.padding * 2, height: 44)
            root.addSubview(row)
            y = row.frame.minY - 8
        }

        let detecting = makeDetectingRow("Watching for the extension to connect…")
        detecting.frame = NSRect(x: Layout.padding, y: y - 36, width: Layout.windowWidth - Layout.padding * 2, height: 32)
        root.addSubview(detecting)

        let primary = makeButton("Open Safari Settings", action: #selector(openSafariSettings), primary: true)
        primary.frame = NSRect(x: Layout.padding, y: 60, width: Layout.windowWidth - Layout.padding * 2, height: 36)
        root.addSubview(primary)

        let fallback = makeButton("I already did this →", action: #selector(manualAdvance), primary: false)
        fallback.frame = NSRect(x: Layout.padding, y: 30, width: Layout.windowWidth - Layout.padding * 2, height: 24)
        root.addSubview(fallback)

        addTimeline(to: root, activeIndex: 0)
        return root
    }

    @objc private func openSafariSettings() {
        // Try SFSafariApplication.showPreferencesForExtension first — opens Safari Settings
        // directly to the Extensions pane. Falls back to opening Safari.app if it fails.
        //
        // History: this API was broken in early macOS 26 betas (SFErrorDomain error 4), so an
        // AppleScript/osascript workaround was used instead. That workaround was removed because
        // it requires Automation permission for System Events, which triggers a TCC dialog on
        // every launch under App Sandbox. showPreferencesForExtension works on macOS 26.3+;
        // on older versions that still have the bug, the fallback opens Safari.app directly.
        let extensionBundleID = "com.chriscantu.claudeinsafari.extension"
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleID) { error in
            if let error = error {
                NSLog("OnboardingWindowController: showPreferencesForExtension failed: %@ — falling back to Safari.app", error.localizedDescription)
                DispatchQueue.main.async {
                    if !NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Safari.app")) {
                        NSLog("OnboardingWindowController: Safari.app fallback also failed")
                    }
                }
            }
        }
    }

    // MARK: Screen Recording Step

    private func buildScreenRecordingView() -> NSView {
        let root = paddedRoot()

        let iconView = makeIconView(size: Layout.iconSizeSm, corner: Layout.cornerSm, content: cameraIconImage(size: Layout.iconSizeSm * 0.55))
        iconView.frame.origin = CGPoint(x: Layout.padding, y: Layout.windowHeight - Layout.padding - Layout.iconSizeSm)
        root.addSubview(iconView)

        let title = makeLabel("Allow Screen Recording", size: 20, weight: .bold)
        title.frame = NSRect(x: Layout.padding, y: iconView.frame.minY - 36, width: Layout.windowWidth - Layout.padding * 2, height: 26)
        root.addSubview(title)

        let body = makeLabel("Claude Code needs to see the browser to help you — so it can understand what's on screen and take targeted action. Your screen is never stored or shared.", size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
        body.frame = NSRect(x: Layout.padding, y: title.frame.minY - 54, width: Layout.windowWidth - Layout.padding * 2, height: 48)
        root.addSubview(body)

        let instructionBox = makeInstructionBox("Open System Settings → Privacy & Security → Screen Recording and enable \(AppConstants.appDisplayName)")
        instructionBox.frame = NSRect(x: Layout.padding, y: body.frame.minY - 68, width: Layout.windowWidth - Layout.padding * 2, height: 56)
        root.addSubview(instructionBox)

        let detecting = makeDetectingRow("Watching for permission to be granted…")
        detecting.frame = NSRect(x: Layout.padding, y: instructionBox.frame.minY - 44, width: Layout.windowWidth - Layout.padding * 2, height: 32)
        root.addSubview(detecting)

        let primary = makeButton("Open System Settings", action: #selector(openScreenRecordingSettings), primary: true)
        primary.frame = NSRect(x: Layout.padding, y: 60, width: Layout.windowWidth - Layout.padding * 2, height: 36)
        root.addSubview(primary)

        let fallback = makeButton("I already did this →", action: #selector(manualAdvance), primary: false)
        fallback.frame = NSRect(x: Layout.padding, y: 30, width: Layout.windowWidth - Layout.padding * 2, height: 24)
        root.addSubview(fallback)

        addTimeline(to: root, activeIndex: 1)
        return root
    }

    @objc private func openScreenRecordingSettings() {
        // Re-register in TCC (idempotent) to refresh the per-process cache,
        // then open System Settings to the Screen Recording pane.
        monitor.registerScreenRecording()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            if !NSWorkspace.shared.open(url) {
                NSLog("OnboardingWindowController: failed to open Screen Recording system preferences URL")
            }
        } else {
            NSLog("OnboardingWindowController: malformed URL literal for Screen Recording preferences")
        }
    }

    @objc private func manualAdvance() { advance() }

    // MARK: Connect to Claude Step

    private func buildConnectClaudeView() -> NSView {
        let root = paddedRoot()

        // Icon: link/chain symbol
        let iconView = makeIconView(size: Layout.iconSizeSm, corner: Layout.cornerSm,
                                    content: sfSymbolImage("link", size: Layout.iconSizeSm * 0.55))
        iconView.frame.origin = CGPoint(x: Layout.padding, y: Layout.windowHeight - Layout.padding - Layout.iconSizeSm)
        root.addSubview(iconView)

        let title = makeLabel("Connect to Claude", size: 20, weight: .bold)
        title.frame = NSRect(x: Layout.padding, y: iconView.frame.minY - 36,
                             width: Layout.windowWidth - Layout.padding * 2, height: 26)
        root.addSubview(title)

        if AppConstants.isSandboxed {
            // App Store flow: copy command + open Terminal
            let body = makeLabel(
                "One more step — connect this app to Claude Code and Claude Desktop so they can use Safari.",
                size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
            body.frame = NSRect(x: Layout.padding, y: title.frame.minY - 44,
                                width: Layout.windowWidth - Layout.padding * 2, height: 36)
            root.addSubview(body)

            // Command box
            let commandBox = makeInstructionBox("Click Install, then paste (\u{2318}V) in Terminal and press Enter.")
            commandBox.frame = NSRect(x: Layout.padding, y: body.frame.minY - 68,
                                      width: Layout.windowWidth - Layout.padding * 2, height: 56)
            root.addSubview(commandBox)

            let primary = makeButton("Install (Copy & Open Terminal)", action: #selector(copyAndOpenTerminal), primary: true)
            primary.frame = NSRect(x: Layout.padding, y: 100, width: Layout.windowWidth - Layout.padding * 2, height: 36)
            root.addSubview(primary)
        } else {
            // DMG flow: auto-install
            let body = makeLabel(
                "Connect this app to Claude Code and Claude Desktop so they can use Safari.",
                size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
            body.frame = NSRect(x: Layout.padding, y: title.frame.minY - 36,
                                width: Layout.windowWidth - Layout.padding * 2, height: 28)
            root.addSubview(body)

            let primary = makeButton("Install", action: #selector(runInstallDirectly), primary: true)
            primary.frame = NSRect(x: Layout.padding, y: 100, width: Layout.windowWidth - Layout.padding * 2, height: 36)
            root.addSubview(primary)
        }

        // Detecting row — polls for marker file (initially hidden, shown after Install click)
        let detecting = makeDetectingRow("Waiting for installation\u{2026}")
        detecting.frame = NSRect(x: Layout.padding, y: 64, width: Layout.windowWidth - Layout.padding * 2, height: 32)
        detecting.isHidden = true
        detecting.identifier = NSUserInterfaceItemIdentifier("connectDetecting")
        root.addSubview(detecting)

        let skip = makeButton("I'll do this later \u{2192}", action: #selector(skipConnect), primary: false)
        skip.frame = NSRect(x: Layout.padding, y: 30, width: Layout.windowWidth - Layout.padding * 2, height: 24)
        root.addSubview(skip)

        addTimeline(to: root, activeIndex: 2)
        return root
    }

    @objc private func copyAndOpenTerminal() {
        let command = "\"\(AppConstants.bridgeBinaryPath)\" --install --verify"

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)

        // Open Terminal
        let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.openApplication(at: terminalURL, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error = error {
                NSLog("OnboardingWindowController: failed to open Terminal — %@", error.localizedDescription)
            }
        }

        // Start polling for marker file
        startMarkerPolling()
    }

    @objc private func runInstallDirectly() {
        // Reuse the shared bridge runner; advance onboarding on success
        AppDelegate.runBridge(
            arguments: ["--install", "--verify"],
            successTitle: "Claude Integration installed",
            failureTitle: "Installation failed"
        ) { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self?.advance()
            }
        }
    }

    @objc private func skipConnect() { advance() }

    /// Maximum time (seconds) to wait for the marker file before showing a timeout message.
    /// 30s matches the navigation-settlement timeout used elsewhere in the extension.
    private static let markerPollingTimeout: TimeInterval = 30

    private var markerPollingStart: Date?

    private func startMarkerPolling() {
        // Show detecting row
        if let detectingRow = window?.contentView?.subviews.first(where: {
            $0.identifier == NSUserInterfaceItemIdentifier("connectDetecting")
        }) {
            detectingRow.isHidden = false
        }

        markerPollingStart = Date()

        // Poll the marker file every 2 seconds
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self, !self.dismissed else { return }
            guard case .connectClaude = self.currentScreen else { return }

            if let url = AppConstants.mcpConfigInstalledURL,
               FileManager.default.fileExists(atPath: url.path) {
                self.stopPolling()
                self.advance()
                return
            }

            // Timeout — update detecting row with helpful message
            if let start = self.markerPollingStart,
               Date().timeIntervalSince(start) > Self.markerPollingTimeout {
                self.stopPolling()
                if let detectingRow = self.window?.contentView?.subviews.first(where: {
                    $0.identifier == NSUserInterfaceItemIdentifier("connectDetecting")
                }) {
                    // Replace spinner with timeout message
                    detectingRow.subviews.forEach { $0.removeFromSuperview() }
                    let label = NSTextField(labelWithString: "Installation not detected. You can try again or skip this step.")
                    label.font = NSFont.systemFont(ofSize: 12)
                    label.textColor = .secondaryLabelColor
                    label.frame = NSRect(x: 8, y: 8, width: Layout.windowWidth - Layout.padding * 2 - 16, height: 16)
                    detectingRow.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
                    detectingRow.addSubview(label)
                }
            }
        }
    }

    // MARK: Done

    static let examplePrompt = "Open news.ycombinator.com in Safari and tell me what the top 5 stories are about"

    private func buildDoneView() -> NSView {
        let root = paddedRoot()

        // Checkmark icon
        let checkIcon = makeIconView(size: Layout.iconSizeLg, corner: Layout.cornerLg, content: checkmarkIconImage(size: Layout.iconSizeLg * 0.55))
        checkIcon.frame.origin = CGPoint(x: (Layout.windowWidth - Layout.iconSizeLg) / 2, y: Layout.windowHeight - Layout.padding - Layout.iconSizeLg - 12)
        root.addSubview(checkIcon)

        let title = makeLabel("You're all set!", size: 22, weight: .bold)
        title.alignment = .center
        title.frame = NSRect(x: Layout.padding, y: checkIcon.frame.minY - 42, width: Layout.windowWidth - Layout.padding * 2, height: 30)
        root.addSubview(title)

        let body = makeLabel("Restart Claude Code or Claude Desktop to connect, then try the example below.", size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
        body.alignment = .center
        body.frame = NSRect(x: Layout.padding, y: title.frame.minY - 52, width: Layout.windowWidth - Layout.padding * 2, height: 44)
        root.addSubview(body)

        // "Try this" card
        let cardInset: CGFloat = Layout.padding
        let cardWidth = Layout.windowWidth - cardInset * 2
        let cardHeight: CGFloat = 120
        let cardY = body.frame.minY - cardHeight - 12
        let accentWidth: CGFloat = 4
        let innerPadding: CGFloat = 18

        let card = NSView(frame: NSRect(x: cardInset, y: cardY, width: cardWidth, height: cardHeight))
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor.claudeOrangeLight.cgColor
        card.layer?.cornerRadius = 10
        root.addSubview(card)

        // Left accent bar
        let accent = NSView(frame: NSRect(x: 0, y: 0, width: accentWidth, height: cardHeight))
        accent.wantsLayer = true
        accent.layer?.backgroundColor = NSColor.claudeOrange.cgColor
        // Round only left corners
        accent.layer?.cornerRadius = 10
        accent.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMinXMaxYCorner]
        card.addSubview(accent)

        let textX = accentWidth + innerPadding
        let textWidth = cardWidth - textX - innerPadding

        let tryLabel = makeLabel("Try this in Claude Code:", size: 13, weight: .bold, color: .claudeOrange)
        tryLabel.frame = NSRect(x: textX, y: cardHeight - 32, width: textWidth, height: 20)
        card.addSubview(tryLabel)

        let prompt = NSTextField(wrappingLabelWithString: Self.examplePrompt)
        prompt.font = NSFont.monospacedSystemFont(ofSize: 13.5, weight: .medium)
        prompt.textColor = .black
        prompt.isSelectable = true
        prompt.drawsBackground = false
        prompt.isBezeled = false
        prompt.frame = NSRect(x: textX, y: 36, width: textWidth, height: cardHeight - 68)
        card.addSubview(prompt)

        let copy = NSButton(title: "Copy", target: self, action: #selector(copyExamplePrompt))
        copy.bezelStyle = .rounded
        copy.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        copy.wantsLayer = true
        copy.layer?.backgroundColor = NSColor.claudeOrange.cgColor
        copy.layer?.cornerRadius = 6
        copy.contentTintColor = .white
        copy.isBordered = false
        copy.frame = NSRect(x: cardWidth - 76, y: 8, width: 62, height: 26)
        card.addSubview(copy)
        copyButton = copy

        let done = makeButton("Done", action: #selector(doneTapped), primary: true)
        done.frame = NSRect(x: Layout.padding + 60, y: 30, width: Layout.windowWidth - (Layout.padding + 60) * 2, height: 36)
        root.addSubview(done)

        return root
    }

    @objc private func doneTapped() { dismiss() }

    @objc private func copyExamplePrompt() {
        NSPasteboard.general.clearContents()
        let ok = NSPasteboard.general.setString(Self.examplePrompt, forType: .string)
        if !ok {
            NSLog("OnboardingWindowController: failed to write example prompt to pasteboard")
        }
        // Brief "Copied!" / "Failed" feedback on the button
        copyButton?.title = ok ? "Copied!" : "Failed"
        copyResetWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.copyButton?.title = "Copy"
        }
        copyResetWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

    // MARK: - UI helpers

    private func paddedRoot() -> NSView {
        let v = NSView(frame: NSRect(x: 0, y: 0, width: Layout.windowWidth, height: Layout.windowHeight))
        v.wantsLayer = true
        v.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        return v
    }

    private func makeIconView(size: CGFloat, corner: CGFloat, content: NSImage) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        container.wantsLayer = true
        container.layer?.cornerRadius = corner
        container.layer?.backgroundColor = NSColor.claudeOrange.cgColor

        let imageView = NSImageView(frame: container.bounds.insetBy(dx: (size - content.size.width) / 2,
                                                                     dy: (size - content.size.height) / 2))
        imageView.image = content
        imageView.imageScaling = .scaleProportionallyUpOrDown
        container.addSubview(imageView)
        return container
    }

    private func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor = .labelColor, wraps: Bool = false) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.isSelectable = false
        if wraps {
            label.lineBreakMode = .byWordWrapping
            label.maximumNumberOfLines = 0
        }
        return label
    }

    private func makeBadgeLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .claudeOrange
        label.alignment = .center
        return label
    }

    private func makeButton(_ title: String, action: Selector, primary: Bool) -> NSButton {
        let btn = NSButton(title: title, target: self, action: action)
        if primary {
            btn.bezelStyle = .rounded
            btn.keyEquivalent = "\r"
            (btn.cell as? NSButtonCell)?.backgroundColor = .controlAccentColor
        } else {
            btn.bezelStyle = .inline
            btn.isBordered = false
            btn.font = NSFont.systemFont(ofSize: 12)
            btn.contentTintColor = .secondaryLabelColor
        }
        return btn
    }

    private func makeSubStep(number: String, text: String) -> NSView {
        let row = NSView(frame: .zero)
        row.wantsLayer = true
        row.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        row.layer?.cornerRadius = 8

        // Number circle
        let circle = NSView(frame: NSRect(x: 10, y: 12, width: 20, height: 20))
        circle.wantsLayer = true
        circle.layer?.cornerRadius = 10
        circle.layer?.backgroundColor = NSColor.claudeOrange.cgColor
        let numLabel = NSTextField(labelWithString: number)
        numLabel.font = NSFont.systemFont(ofSize: 11, weight: .bold)
        numLabel.textColor = .white
        numLabel.alignment = .center
        let labelHeight = numLabel.intrinsicContentSize.height
        numLabel.frame = NSRect(x: 0,
                                y: (circle.bounds.height - labelHeight) / 2,
                                width: circle.bounds.width,
                                height: labelHeight)
        circle.addSubview(numLabel)
        row.addSubview(circle)

        // Text
        let textLabel = NSTextField(wrappingLabelWithString: text)
        textLabel.font = NSFont.systemFont(ofSize: 12)
        textLabel.frame = NSRect(x: 38, y: 4, width: Layout.windowWidth - Layout.padding * 2 - 50, height: 36)
        row.addSubview(textLabel)

        return row
    }

    private func makeInstructionBox(_ text: String) -> NSView {
        let box = NSView(frame: .zero)
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        box.layer?.cornerRadius = 8

        let label = NSTextField(wrappingLabelWithString: text)
        label.font = NSFont.systemFont(ofSize: 12)
        label.frame = NSRect(x: 12, y: 8, width: Layout.windowWidth - Layout.padding * 2 - 24, height: 40)
        box.addSubview(label)
        return box
    }

    private func makeDetectingRow(_ text: String) -> NSView {
        let row = NSView(frame: .zero)
        row.wantsLayer = true
        row.layer?.backgroundColor = NSColor.claudeOrangeLight.cgColor
        row.layer?.cornerRadius = 8

        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 12)
        label.textColor = NSColor(red: 0.478, green: 0.231, blue: 0.118, alpha: 1)
        row.addSubview(label)

        let spinner = NSProgressIndicator(frame: NSRect(x: 8, y: 6, width: 18, height: 18))
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.startAnimation(nil)
        row.addSubview(spinner)
        label.frame = NSRect(x: 34, y: 8, width: Layout.windowWidth - Layout.padding * 2 - 42, height: 16)

        return row
    }

    /// Adds the 3-segment timeline strip at the bottom of a step view.
    /// `activeIndex`: 0 = Safari Extension, 1 = Screen Recording, 2 = Connect
    private func addTimeline(to root: NSView, activeIndex: Int) {
        let labels = ["Safari Extension", "Screen Recording", "Connect"]
        let segCount = labels.count
        let segWidth = (Layout.windowWidth - Layout.padding * 2 - CGFloat(segCount - 1) * 5) / CGFloat(segCount)
        let barY: CGFloat = 14
        let labelY: CGFloat = 2

        for i in 0..<segCount {
            let x = Layout.padding + CGFloat(i) * (segWidth + 5)

            // Bar
            let bar = NSView(frame: NSRect(x: x, y: barY, width: segWidth, height: 3))
            bar.wantsLayer = true
            if i < activeIndex {
                bar.layer?.backgroundColor = NSColor.systemGreen.cgColor
            } else if i == activeIndex {
                bar.layer?.backgroundColor = NSColor.claudeOrange.cgColor
            } else {
                bar.layer?.backgroundColor = NSColor.separatorColor.cgColor
            }
            bar.layer?.cornerRadius = 1.5
            root.addSubview(bar)

            // Label
            let lbl = NSTextField(labelWithString: i < activeIndex ? "\u{2713} \(labels[i])" : labels[i])
            lbl.font = NSFont.systemFont(ofSize: 9, weight: i == activeIndex ? .semibold : .regular)
            lbl.textColor = i < activeIndex ? NSColor.systemGreen
                          : i == activeIndex ? .claudeOrange
                          : .tertiaryLabelColor
            lbl.frame = NSRect(x: x, y: labelY, width: segWidth, height: 11)
            root.addSubview(lbl)
        }
    }

    // MARK: - Icon images (white bezier paths on transparent background, placed on orange container)

    private func robotIconImage(size: CGFloat) -> NSImage {
        // Use SF Symbol "robot" — matches the design mockup exactly.
        let config = NSImage.SymbolConfiguration(pointSize: size * 0.58, weight: .regular)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
        if let symbol = NSImage(systemSymbolName: "robot", accessibilityDescription: nil)?
            .withSymbolConfiguration(config) {
            return symbol
        }
        // Fallback: hand-drawn bezier robot (safety net in case the SF Symbol is unavailable)
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let w = rect.width; let h = rect.height
            NSColor.white.setFill()
            NSBezierPath(roundedRect: NSRect(x: w*0.14, y: h*0.36, width: w*0.72, height: h*0.42), xRadius: w*0.10, yRadius: w*0.10).fill()
            NSBezierPath(roundedRect: NSRect(x: w*0.46, y: h*0.78, width: w*0.08, height: h*0.10), xRadius: 2, yRadius: 2).fill()
            NSBezierPath(ovalIn: NSRect(x: w*0.38, y: h*0.86, width: w*0.24, height: h*0.14)).fill()
            NSBezierPath(roundedRect: NSRect(x: w*0.32, y: h*0.08, width: w*0.36, height: h*0.24), xRadius: w*0.06, yRadius: w*0.06).fill()
            NSBezierPath(roundedRect: NSRect(x: w*0.20, y: h*0.155, width: w*0.14, height: h*0.09), xRadius: w*0.03, yRadius: w*0.03).fill()
            NSBezierPath(roundedRect: NSRect(x: w*0.66, y: h*0.155, width: w*0.14, height: h*0.09), xRadius: w*0.03, yRadius: w*0.03).fill()
            if let ctx = NSGraphicsContext.current?.cgContext {
                ctx.setBlendMode(.clear)
                NSColor.white.setFill()
                NSBezierPath(roundedRect: NSRect(x: w*0.27, y: h*0.53, width: w*0.13, height: h*0.13), xRadius: w*0.02, yRadius: w*0.02).fill()
                NSBezierPath(roundedRect: NSRect(x: w*0.60, y: h*0.53, width: w*0.13, height: h*0.13), xRadius: w*0.02, yRadius: w*0.02).fill()
                ctx.setBlendMode(.normal)
            }
            return true
        }
    }

    private func puzzleIconImage(size: CGFloat) -> NSImage {
        sfSymbolImage("puzzlepiece.extension.fill", size: size)
    }

    private func cameraIconImage(size: CGFloat) -> NSImage {
        sfSymbolImage("camera.fill", size: size)
    }

    private func checkmarkIconImage(size: CGFloat) -> NSImage {
        sfSymbolImage("checkmark", size: size, weight: .bold)
    }

    /// Returns a white SF Symbol image sized to fit within `size` points.
    private func sfSymbolImage(_ name: String, size: CGFloat, weight: NSFont.Weight = .regular) -> NSImage {
        let config = NSImage.SymbolConfiguration(pointSize: size * 0.65, weight: weight)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else {
            NSLog("OnboardingWindowController: SF Symbol '%@' not found", name)
            return NSImage()
        }
        let configured = image.withSymbolConfiguration(config)
        if configured == nil {
            NSLog("OnboardingWindowController: withSymbolConfiguration returned nil for SF Symbol '%@'", name)
        }
        return configured ?? NSImage()
    }
}

// MARK: - NSWindowDelegate

extension OnboardingWindowController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        // Always stop polling first (idempotent) so in-flight timer callbacks
        // are cancelled before onDismiss fires.
        stopPolling()
        // Only fire onDismiss if not already dismissed via the normal path
        // (Done button / laterTapped). The dismissed flag prevents double-fire.
        guard !dismissed else { return }
        dismissed = true
        onDismiss?()
    }
}
