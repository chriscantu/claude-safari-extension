// ClaudeInSafari/App/MenuBarController.swift
import Cocoa

// MARK: - MenuBarState

enum MenuBarState: Equatable {
    case connected
    case needsAttention(String)  // message describing which permission was revoked
    case notConnected
}

// MARK: - MenuBarController

/// Owns the NSStatusItem and rebuilds the menu whenever state changes.
final class MenuBarController {

    // MARK: Public

    private(set) var state: MenuBarState = .notConnected {
        didSet { updateStatusItem() }
    }

    /// Callback invoked when user taps "Open Setup" (.notConnected state),
    /// "Open Setup Again" (.connected state), or "Fix This →" (.needsAttention state).
    // Called on the main thread (invoked from @objc action methods).
    var onOpenSetup: (() -> Void)?

    /// Callback invoked when user taps "Check Connection".
    // Called on the main thread (invoked from @objc action methods).
    var onCheckConnection: (() -> Void)?

    // MARK: Private

    private let statusItem: NSStatusItem

    // MARK: Init

    init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateStatusItem()
    }

    deinit {
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    // MARK: - Public API

    func setState(_ newState: MenuBarState) {
        state = newState
    }

    /// Derives the correct MenuBarState from a PermissionStatus snapshot.
    /// Exposed as a static pure function so it can be tested without AppKit.
    static func menuBarState(from status: PermissionStatus) -> MenuBarState {
        guard status.extensionEnabled else { return .notConnected }
        if !status.screenRecording {
            return .needsAttention("Screen Recording permission was removed")
        }
        if !status.accessibility {
            return .needsAttention("Accessibility permission was removed")
        }
        return .connected
    }

    // MARK: - Private

    private func updateStatusItem() {
        statusItem.button?.image = robotImage(for: state)
        statusItem.button?.image?.isTemplate = false  // we handle coloring ourselves
        statusItem.menu = buildMenu()
    }

    // MARK: - Icon

    /// Returns a composited image: robot silhouette + status dot.
    private func robotImage(for state: MenuBarState) -> NSImage {
        let size = NSSize(width: 22, height: 18)
        let image = NSImage(size: size, flipped: false) { [weak self] rect in
            guard let self else { return false }
            self.drawRobot(in: rect, dimmed: state == .notConnected)
            self.drawStatusDot(in: rect, state: state)
            return true
        }
        return image
    }

    /// Draws a minimal robot silhouette using bezier paths.
    /// Uses NSColor.labelColor (black in Light mode, white in Dark mode) so the icon
    /// adapts automatically to light and dark menu bars. `isTemplate` is set to `false`
    /// on the parent image so the colored status dot is preserved.
    private func drawRobot(in rect: NSRect, dimmed: Bool) {
        let color = dimmed ? NSColor.labelColor.withAlphaComponent(0.35) : NSColor.labelColor
        color.setFill()

        // Head
        let head = NSBezierPath(roundedRect: NSRect(x: 3, y: 7, width: 13, height: 8), xRadius: 2, yRadius: 2)
        head.fill()

        // Antenna stem
        let stem = NSBezierPath(roundedRect: NSRect(x: 8.5, y: 15, width: 2, height: 3), xRadius: 1, yRadius: 1)
        stem.fill()

        // Antenna tip
        let tip = NSBezierPath(ovalIn: NSRect(x: 8, y: 17.5, width: 3, height: 3))
        tip.fill()

        // Body
        let body = NSBezierPath(roundedRect: NSRect(x: 4, y: 1, width: 11, height: 5.5), xRadius: 1.5, yRadius: 1.5)
        body.fill()

        // Eyes — windowBackgroundColor is light in Light mode (punches holes in dark head)
        // and dark in Dark mode (punches holes in white head), making eyes visible in both.
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: 5.5, y: 9.5, width: 2.5, height: 2.5)).fill()
        NSBezierPath(ovalIn: NSRect(x: 10.5, y: 9.5, width: 2.5, height: 2.5)).fill()
    }

    private func drawStatusDot(in rect: NSRect, state: MenuBarState) {
        let dotColor: NSColor
        switch state {
        case .connected:       dotColor = NSColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1) // system green
        case .needsAttention:  dotColor = NSColor(red: 1.000, green: 0.839, blue: 0.039, alpha: 1) // system yellow
        case .notConnected:    dotColor = NSColor(red: 1.000, green: 0.231, blue: 0.188, alpha: 1) // system red
        }
        dotColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: 16, y: 1, width: 5, height: 5)).fill()
    }

    // MARK: - Menu

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()

        // Header item (non-interactive)
        let headerItem = NSMenuItem()
        headerItem.view = buildMenuHeader()
        menu.addItem(headerItem)

        menu.addItem(.separator())

        switch state {
        case .connected:
            menu.addItem(makeItem("Open Setup Again", action: #selector(openSetup), symbol: "⚙️"))
            menu.addItem(makeItem("Open Safari", action: #selector(openSafari), symbol: "🧭"))

        case .needsAttention:
            let fixItem = makeItem("Fix This →", action: #selector(openSetup), symbol: "🔧")
            fixItem.attributedTitle = NSAttributedString(
                string: "🔧  Fix This →",
                attributes: [
                    .foregroundColor: NSColor.claudeOrange,
                    .font: NSFont.systemFont(ofSize: 13, weight: .bold)
                ]
            )
            menu.addItem(fixItem)
            menu.addItem(.separator())
            menu.addItem(makeItem("Open Safari", action: #selector(openSafari), symbol: "🧭"))

        case .notConnected:
            menu.addItem(makeItem("Open Setup", action: #selector(openSetup), symbol: "⚙️"))
        }

        menu.addItem(.separator())
        menu.addItem(makeItem("Check Connection", action: #selector(checkConnection), symbol: "🔍"))

        menu.addItem(makeItem("Quit", action: #selector(quitApp), symbol: nil))

        // Wire target
        for item in menu.items {
            if item.action != nil { item.target = self }
        }

        return menu
    }

    private func makeItem(_ title: String, action: Selector, symbol: String?) -> NSMenuItem {
        let label = symbol.map { "\($0)  \(title)" } ?? title
        return NSMenuItem(title: label, action: action, keyEquivalent: "")
    }

    private func buildMenuHeader() -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 52))

        // Plain NSView (not NSImageView) so we can drive the background color via CALayer
        // without needing a separate image asset for the avatar swatch.
        let avatarSize: CGFloat = 32
        let avatar = NSView(frame: NSRect(x: 12, y: 10, width: avatarSize, height: avatarSize))
        avatar.wantsLayer = true
        avatar.layer?.cornerRadius = 8
        avatar.layer?.backgroundColor = NSColor.claudeOrange.cgColor
        view.addSubview(avatar)

        // Title
        let titleLabel = NSTextField(labelWithString: titleText)
        titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = titleColor
        titleLabel.frame = NSRect(x: 52, y: 28, width: 180, height: 16)
        view.addSubview(titleLabel)

        // Subtitle
        let subtitleLabel = NSTextField(labelWithString: subtitleText)
        subtitleLabel.font = NSFont.systemFont(ofSize: 11)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.frame = NSRect(x: 52, y: 12, width: 180, height: 14)
        view.addSubview(subtitleLabel)

        return view
    }

    private var titleText: String {
        switch state {
        case .connected:           return "Claude in Safari"
        case .needsAttention:      return "Action Required"
        case .notConnected:        return "Claude in Safari"
        }
    }

    private var titleColor: NSColor {
        if case .needsAttention = state { return NSColor(red: 0.573, green: 0.251, blue: 0, alpha: 1) }
        return .labelColor
    }

    private var subtitleText: String {
        switch state {
        case .connected:                  return "Connected · Claude Code can use Safari"
        case .needsAttention(let msg):    return msg
        case .notConnected:               return "Setup required"
        }
    }

    // MARK: - Actions

    @objc private func checkConnection() { onCheckConnection?() }
    @objc private func openSetup()       { onOpenSetup?() }
    @objc private func openSafari() {
        let safariURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari")
            ?? URL(fileURLWithPath: "/Applications/Safari.app")
        let config = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.openApplication(at: safariURL, configuration: config) { _, error in
            if let error = error {
                NSLog("MenuBarController: failed to open Safari — %@", error.localizedDescription)
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Could not open Safari"
                    alert.informativeText = error.localizedDescription
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        }
    }
    @objc private func quitApp()         { NSApplication.shared.terminate(nil) }
}
