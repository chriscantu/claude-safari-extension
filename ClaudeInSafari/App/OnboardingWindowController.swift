// ClaudeInSafari/App/OnboardingWindowController.swift
import Cocoa

// MARK: - Color + layout constants

private extension NSColor {
    /// Claude / Anthropic brand orange
    static let claudeOrange = NSColor(red: 0.851, green: 0.467, blue: 0.341, alpha: 1)
    static let claudeOrangeLight = NSColor(red: 0.961, green: 0.929, blue: 0.910, alpha: 1)
}

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

private enum OnboardingScreen {
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

    private var currentScreen: OnboardingScreen = .welcome
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

    /// Show onboarding starting from the first incomplete step (or welcome if none
    /// have been attempted). Pass `startingAt: nil` to always show welcome first.
    func showOnboarding(startingAt step: OnboardingStep? = nil) {
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
        currentScreen = screen
        window?.contentView = buildView(for: screen)
        if case .step(let step) = screen {
            startPolling(for: step)
        }
    }

    private func advance() {
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

    private var dismissed = false
    private func dismiss() {
        guard !dismissed else { return }
        dismissed = true
        stopPolling()
        close()
        onDismiss?()
    }

    // MARK: - Polling

    private func startPolling(for step: OnboardingStep) {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkStepCompletion(step)
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func checkStepCompletion(_ step: OnboardingStep) {
        // checkAll delivers on the main queue — no extra dispatch needed.
        monitor.checkAll { [weak self] status in
            guard let self else { return }
            switch step {
            case .safariExtension where status.extensionEnabled: self.advance()
            case .screenRecording where status.screenRecording:  self.advance()
            case .accessibility   where status.accessibility:    self.advance()
            default: break
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
        // Opens Safari's Extensions pref tab directly. Falls back to launching Safari.app.
        if !NSWorkspace.shared.open(URL(string: "safari-settings://")!) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Safari.app"))
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
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
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
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
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
        numLabel.frame = circle.bounds
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
                bar.layer?.backgroundColor = NSColor.systemGreen.cgColor  // green
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
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSColor.white.setFill()
            // Head
            NSBezierPath(roundedRect: NSRect(x: rect.width * 0.14, y: rect.height * 0.38,
                                             width: rect.width * 0.72, height: rect.height * 0.38),
                         xRadius: rect.width * 0.1, yRadius: rect.width * 0.1).fill()
            // Antenna stem
            NSBezierPath(roundedRect: NSRect(x: rect.width * 0.44, y: rect.height * 0.76,
                                             width: rect.width * 0.12, height: rect.height * 0.16),
                         xRadius: 2, yRadius: 2).fill()
            // Antenna tip
            NSBezierPath(ovalIn: NSRect(x: rect.width * 0.40, y: rect.height * 0.88,
                                        width: rect.width * 0.20, height: rect.height * 0.14)).fill()
            // Body
            NSBezierPath(roundedRect: NSRect(x: rect.width * 0.20, y: rect.height * 0.06,
                                             width: rect.width * 0.60, height: rect.height * 0.28),
                         xRadius: rect.width * 0.08, yRadius: rect.width * 0.08).fill()
            // Arms
            NSBezierPath(roundedRect: NSRect(x: rect.width * 0.02, y: rect.height * 0.08,
                                             width: rect.width * 0.14, height: rect.height * 0.22),
                         xRadius: rect.width * 0.06, yRadius: rect.width * 0.06).fill()
            NSBezierPath(roundedRect: NSRect(x: rect.width * 0.84, y: rect.height * 0.08,
                                             width: rect.width * 0.14, height: rect.height * 0.22),
                         xRadius: rect.width * 0.06, yRadius: rect.width * 0.06).fill()
            // Eyes (orange = transparent reveal of container bg)
            NSColor.claudeOrange.setFill()
            NSBezierPath(ovalIn: NSRect(x: rect.width * 0.24, y: rect.height * 0.48,
                                        width: rect.width * 0.18, height: rect.height * 0.18)).fill()
            NSBezierPath(ovalIn: NSRect(x: rect.width * 0.58, y: rect.height * 0.48,
                                        width: rect.width * 0.18, height: rect.height * 0.18)).fill()
            return true
        }
    }

    private func puzzleIconImage(size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSColor.white.setFill()
            // Simplified puzzle shape via bezier
            let path = NSBezierPath()
            let s = rect.width
            // Top piece notch
            path.move(to: CGPoint(x: s*0.08, y: s*0.50))
            path.line(to: CGPoint(x: s*0.08, y: s*0.70))
            path.appendArc(withCenter: CGPoint(x: s*0.22, y: s*0.70), radius: s*0.12,
                           startAngle: 180, endAngle: 0, clockwise: true)
            path.line(to: CGPoint(x: s*0.34, y: s*0.92))
            path.line(to: CGPoint(x: s*0.92, y: s*0.92))
            path.line(to: CGPoint(x: s*0.92, y: s*0.34))
            path.appendArc(withCenter: CGPoint(x: s*0.92, y: s*0.22), radius: s*0.12,
                           startAngle: 270, endAngle: 90, clockwise: true)
            path.line(to: CGPoint(x: s*0.70, y: s*0.08))
            path.line(to: CGPoint(x: s*0.50, y: s*0.08))
            path.appendArc(withCenter: CGPoint(x: s*0.50, y: s*0.22), radius: s*0.12,
                           startAngle: 270, endAngle: 90, clockwise: false)
            path.line(to: CGPoint(x: s*0.34, y: s*0.50))
            path.appendArc(withCenter: CGPoint(x: s*0.22, y: s*0.50), radius: s*0.12,
                           startAngle: 0, endAngle: 180, clockwise: false)
            path.close()
            path.fill()
            return true
        }
    }

    private func cameraIconImage(size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let s = rect.width
            // Camera body (white)
            NSColor.white.setFill()
            let body = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s * 0.75),
                                    xRadius: s * 0.12, yRadius: s * 0.12)
            body.fill()
            // Viewfinder bump
            NSBezierPath(roundedRect: NSRect(x: s*0.30, y: s*0.70, width: s*0.40, height: s*0.26),
                         xRadius: s*0.08, yRadius: s*0.08).fill()
            // Lens ring (orange = cutout revealing container bg)
            NSColor.claudeOrange.setFill()
            NSBezierPath(ovalIn: NSRect(x: s*0.28, y: s*0.10, width: s*0.44, height: s*0.44)).fill()
            // Lens glass (white)
            NSColor.white.setFill()
            NSBezierPath(ovalIn: NSRect(x: s*0.38, y: s*0.20, width: s*0.24, height: s*0.24)).fill()
            return true
        }
    }

    private func accessibilityIconImage(size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSColor.white.setFill()
            let s = rect.width
            // Head
            NSBezierPath(ovalIn: NSRect(x: s*0.38, y: s*0.78, width: s*0.24, height: s*0.24)).fill()
            // Arms
            let arms = NSBezierPath(roundedRect: NSRect(x: s*0.04, y: s*0.54, width: s*0.92, height: s*0.12),
                                    xRadius: s*0.06, yRadius: s*0.06)
            arms.fill()
            // Legs (two paths)
            let legL = NSBezierPath(roundedRect: NSRect(x: s*0.16, y: s*0.04, width: s*0.22, height: s*0.50),
                                    xRadius: s*0.08, yRadius: s*0.08)
            legL.fill()
            let legR = NSBezierPath(roundedRect: NSRect(x: s*0.62, y: s*0.04, width: s*0.22, height: s*0.50),
                                    xRadius: s*0.08, yRadius: s*0.08)
            legR.fill()
            return true
        }
    }

    private func checkmarkIconImage(size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let s = rect.width
            let path = NSBezierPath()
            path.lineWidth = s * 0.12
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            path.move(to: CGPoint(x: s * 0.15, y: s * 0.50))
            path.line(to: CGPoint(x: s * 0.40, y: s * 0.25))
            path.line(to: CGPoint(x: s * 0.85, y: s * 0.75))
            NSColor.white.setStroke()
            path.stroke()
            return true
        }
    }
}

// MARK: - NSWindowDelegate

extension OnboardingWindowController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        // `dismiss()` already called `onDismiss` and the settled flag prevents double-fire.
        // Stop polling here to handle the case where the user closes the window via the
        // title bar red button (which bypasses `dismiss()`).
        stopPolling()
        if !dismissed { dismiss() }
    }
}
