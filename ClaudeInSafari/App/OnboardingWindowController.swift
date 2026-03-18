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
    private var pollTimer: Timer?

    // MARK: Init

    init(monitor: PermissionMonitor = PermissionMonitor()) {
        self.monitor = monitor
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Layout.windowWidth, height: Layout.windowHeight),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Claude in Safari"
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
    func showOnboarding(startingAt step: OnboardingStep? = nil) {
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
                // Register the app in TCC so it appears in System Settings → Screen Recording.
                // Called once per step entry. Safe — ScreenshotService now uses
                // CGPreflightScreenCaptureAccess() and will not create a competing dialog loop.
                CGRequestScreenCaptureAccess()
            }
            if step == .accessibility {
                // Register the app in TCC so it appears in System Settings → Accessibility.
                // Shows the system prompt directing the user to grant access. Without this,
                // the app may never appear in the Accessibility list after a rebuild.
                monitor.requestAccessibility()
            }
            startPolling(for: step)
        }
    }

    func advance() {
        switch currentScreen {
        case .welcome:
            show(screen: .step(.safariExtension))
        case .step(.safariExtension):
            show(screen: .step(.screenRecording))
        case .step(.screenRecording):
            show(screen: .step(.accessibility))
        case .step(.accessibility):
            show(screen: .done)
        case .done:
            dismiss()
        }
    }

    private(set) var dismissed = false
    private var checkInFlight = false
    func dismiss() {
        guard !dismissed else { return }
        dismissed = true
        stopPolling()
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

    private func checkStepCompletion(_ step: OnboardingStep) {
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
            case .accessibility   where status.accessibility:    self.advance()
            case .accessibility:    break   // permission not yet granted; keep polling
            }
        }
    }

    // MARK: - View building

    private func buildView(for screen: OnboardingScreen) -> NSView {
        switch screen {
        case .welcome:              return buildWelcomeView()
        case .step(.safariExtension): return buildSafariExtensionView()
        case .step(.screenRecording): return buildScreenRecordingView()
        case .step(.accessibility):   return buildAccessibilityView()
        case .done:                 return buildDoneView()
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
            ("3", "Go to Safari → Settings → Extensions and turn on Claude in Safari")
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
        // safari-settings:// and SFSafariApplication.showPreferencesForExtension both fail on macOS 26+.
        // Use AppleScript (via osascript subprocess, same pattern as AppleScriptBridge) to activate
        // Safari and navigate to Settings → Extensions. Falls back to opening Safari.app on error.
        let script = """
            tell application "Safari" to activate
            delay 0.3
            tell application "System Events"
                tell process "Safari"
                    try
                        click menu item "Settings\u{2026}" of menu "Safari" of menu bar 1
                    on error
                        click menu item "Preferences\u{2026}" of menu "Safari" of menu bar 1
                    end try
                    delay 0.4
                    tell window 1
                        click button "Extensions" of tool bar 1
                    end tell
                end tell
            end tell
            """
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-e", script]
            let stderrPipe = Pipe()
            process.standardError = stderrPipe
            do {
                try process.run()
                process.waitUntilExit()
                if process.terminationStatus != 0 {
                    let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    let stderrStr = String(data: stderrData, encoding: .utf8) ?? "<unreadable>"
                    NSLog("OnboardingWindowController: osascript exited %d — stderr: %@ — falling back to Safari.app",
                          process.terminationStatus, stderrStr)
                    DispatchQueue.main.async { [weak self] in self?.openSafariFallback() }
                }
            } catch {
                NSLog("OnboardingWindowController: failed to launch osascript: %@ — falling back", error.localizedDescription)
                DispatchQueue.main.async { [weak self] in self?.openSafariFallback() }
            }
        }
    }

    private func openSafariFallback() {
        if !NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Safari.app")) {
            NSLog("OnboardingWindowController: Safari.app fallback also failed")
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

        let instructionBox = makeInstructionBox("Open System Settings → Privacy & Security → Screen Recording and enable Claude in Safari")
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
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            if !NSWorkspace.shared.open(url) {
                NSLog("OnboardingWindowController: failed to open Screen Recording system preferences URL")
            }
        } else {
            NSLog("OnboardingWindowController: malformed URL literal for Screen Recording preferences")
        }
    }

    // MARK: Accessibility Step

    private func buildAccessibilityView() -> NSView {
        let root = paddedRoot()

        let iconView = makeIconView(size: Layout.iconSizeSm, corner: Layout.cornerSm, content: accessibilityIconImage(size: Layout.iconSizeSm * 0.55))
        iconView.frame.origin = CGPoint(x: Layout.padding, y: Layout.windowHeight - Layout.padding - Layout.iconSizeSm)
        root.addSubview(iconView)

        let title = makeLabel("Allow Accessibility Access", size: 20, weight: .bold)
        title.frame = NSRect(x: Layout.padding, y: iconView.frame.minY - 36, width: Layout.windowWidth - Layout.padding * 2, height: 26)
        root.addSubview(title)

        let body = makeLabel("This lets Claude Code resize and position Safari's window — so it has enough room to work effectively. Used only for window management, nothing else.", size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
        body.frame = NSRect(x: Layout.padding, y: title.frame.minY - 54, width: Layout.windowWidth - Layout.padding * 2, height: 48)
        root.addSubview(body)

        let instructionBox = makeInstructionBox("Open System Settings → Privacy & Security → Accessibility and enable Claude in Safari")
        instructionBox.frame = NSRect(x: Layout.padding, y: body.frame.minY - 68, width: Layout.windowWidth - Layout.padding * 2, height: 56)
        root.addSubview(instructionBox)

        let detecting = makeDetectingRow("Watching for permission to be granted…")
        detecting.frame = NSRect(x: Layout.padding, y: instructionBox.frame.minY - 44, width: Layout.windowWidth - Layout.padding * 2, height: 32)
        root.addSubview(detecting)

        let primary = makeButton("Open System Settings", action: #selector(openAccessibilitySettings), primary: true)
        primary.frame = NSRect(x: Layout.padding, y: 60, width: Layout.windowWidth - Layout.padding * 2, height: 36)
        root.addSubview(primary)

        let fallback = makeButton("I already did this →", action: #selector(manualAdvance), primary: false)
        fallback.frame = NSRect(x: Layout.padding, y: 30, width: Layout.windowWidth - Layout.padding * 2, height: 24)
        root.addSubview(fallback)

        addTimeline(to: root, activeIndex: 2)
        return root
    }

    @objc private func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            if !NSWorkspace.shared.open(url) {
                NSLog("OnboardingWindowController: failed to open Accessibility system preferences URL")
            }
        } else {
            NSLog("OnboardingWindowController: malformed URL literal for Accessibility preferences")
        }
    }

    @objc private func manualAdvance() { advance() }

    // MARK: Done

    private func buildDoneView() -> NSView {
        let root = paddedRoot()

        // Checkmark icon
        let checkIcon = makeIconView(size: Layout.iconSizeLg, corner: Layout.cornerLg, content: checkmarkIconImage(size: Layout.iconSizeLg * 0.55))
        checkIcon.frame.origin = CGPoint(x: (Layout.windowWidth - Layout.iconSizeLg) / 2, y: Layout.windowHeight - Layout.padding - Layout.iconSizeLg - 20)
        root.addSubview(checkIcon)

        let title = makeLabel("You're all set!", size: 22, weight: .bold)
        title.alignment = .center
        title.frame = NSRect(x: Layout.padding, y: checkIcon.frame.minY - 48, width: Layout.windowWidth - Layout.padding * 2, height: 30)
        root.addSubview(title)

        let body = makeLabel("Claude Code can now use Safari. Ask Claude to open a page, fill a form, or take a screenshot — it'll just work.\n\nLook for the robot icon in your menu bar whenever the connection is active.", size: 13, weight: .regular, color: .secondaryLabelColor, wraps: true)
        body.alignment = .center
        body.frame = NSRect(x: Layout.padding, y: title.frame.minY - 90, width: Layout.windowWidth - Layout.padding * 2, height: 84)
        root.addSubview(body)

        let done = makeButton("Done", action: #selector(doneTapped), primary: true)
        done.frame = NSRect(x: Layout.padding + 60, y: 60, width: Layout.windowWidth - (Layout.padding + 60) * 2, height: 36)
        root.addSubview(done)

        return root
    }

    @objc private func doneTapped() { dismiss() }

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
    /// `activeIndex`: 0 = Safari Extension, 1 = Screen Recording, 2 = Accessibility
    private func addTimeline(to root: NSView, activeIndex: Int) {
        let labels = ["Safari Extension", "Screen Recording", "Accessibility"]
        let segWidth = (Layout.windowWidth - Layout.padding * 2 - 10) / 3
        let barY: CGFloat = 14
        let labelY: CGFloat = 2

        for i in 0..<3 {
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
            let lbl = NSTextField(labelWithString: i < activeIndex ? "✓ \(labels[i])" : labels[i])
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

    private func accessibilityIconImage(size: CGFloat) -> NSImage {
        sfSymbolImage("accessibility", size: size)
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
