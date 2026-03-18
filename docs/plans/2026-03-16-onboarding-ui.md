# Onboarding UI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a menu bar presence and first-run onboarding wizard to Claude in Safari, guiding users through enabling the Safari extension and granting Screen Recording and Accessibility permissions.

**Architecture:** Four independent chunks — a testable `PermissionMonitor` (protocol-injected APIs), a `MenuBarController` (NSStatusItem + 3-state menu), an `OnboardingWindowController` (5-screen programmatic AppKit wizard), and an `AppDelegate` integration pass that wires everything together and flips `LSUIElement`. All UI is programmatic AppKit — no XIBs or storyboards.

**Tech Stack:** Swift / AppKit / XCTest — macOS 13.0+ deployment target. `SafariServices` for `SFSafariExtensionManager`. No SwiftUI.

**Spec:** `docs/specs/2026-03-16-onboarding-ui-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `ClaudeInSafari/App/PermissionMonitor.swift` | `PermissionChecking` protocol, `SystemPermissionChecker`, `PermissionMonitor` (polling + callbacks) |
| Create | `ClaudeInSafari/App/MenuBarController.swift` | `NSStatusItem`, `MenuBarState` enum, icon compositing, menu construction |
| Create | `ClaudeInSafari/App/OnboardingWindowController.swift` | `OnboardingStep` enum, programmatic 5-screen wizard, per-step polling |
| Create | `Tests/Swift/PermissionMonitorTests.swift` | XCTest suite for `PermissionMonitor` |
| Create | `Tests/Swift/MenuBarControllerTests.swift` | XCTest suite for `MenuBarController` state logic |
| Modify | `ClaudeInSafari/App/AppDelegate.swift` | Wire `MenuBarController` + `OnboardingWindowController`, start post-setup monitoring |
| Modify | `ClaudeInSafari/Info.plist` | `LSUIElement = true` |
| Modify | `STRUCTURE.md` | Document new files |

---

## Chunk 1: PermissionMonitor

### Task 1: Write `PermissionMonitorTests.swift` (failing)

**Files:**
- Create: `Tests/Swift/PermissionMonitorTests.swift`

- [ ] **Step 1: Create the test file with a mock checker and failing tests**

```swift
// Tests/Swift/PermissionMonitorTests.swift
import XCTest
@testable import ClaudeInSafari

// MARK: - Mock

final class MockPermissionChecker: PermissionChecking {
    var accessibilityGranted = false
    var screenRecordingGranted = false
    var extensionEnabled = false

    func isAccessibilityGranted() -> Bool { accessibilityGranted }
    func isScreenRecordingGranted() -> Bool { screenRecordingGranted }
    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        completion(extensionEnabled)
    }
}

// MARK: - Tests

final class PermissionMonitorTests: XCTestCase {

    // T1 — allGranted returns true when all three are granted
    func testAllGranted_whenAllPermissionsGranted() {
        let checker = MockPermissionChecker()
        checker.accessibilityGranted = true
        checker.screenRecordingGranted = true
        checker.extensionEnabled = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "allGranted")
        monitor.checkAll { status in
            XCTAssertTrue(status.allGranted)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T2 — allGranted returns false when accessibility is missing
    func testAllGranted_falseWhenAccessibilityMissing() {
        let checker = MockPermissionChecker()
        checker.screenRecordingGranted = true
        checker.extensionEnabled = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "notAllGranted")
        monitor.checkAll { status in
            XCTAssertFalse(status.allGranted)
            XCTAssertFalse(status.accessibility)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T3 — firstIncompleteStep returns .safariExtension when extension is not enabled
    func testFirstIncompleteStep_extensionNotEnabled() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = false
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "firstStep")
        monitor.checkAll { status in
            XCTAssertEqual(status.firstIncompleteStep, .safariExtension)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T4 — firstIncompleteStep returns .screenRecording when extension is enabled but recording is not
    func testFirstIncompleteStep_screenRecordingNotGranted() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = true
        checker.screenRecordingGranted = false
        checker.accessibilityGranted = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "screenRecording")
        monitor.checkAll { status in
            XCTAssertEqual(status.firstIncompleteStep, .screenRecording)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T5 — firstIncompleteStep returns .accessibility when only accessibility is missing
    func testFirstIncompleteStep_accessibilityNotGranted() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = true
        checker.screenRecordingGranted = true
        checker.accessibilityGranted = false
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "accessibility")
        monitor.checkAll { status in
            XCTAssertEqual(status.firstIncompleteStep, .accessibility)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }

    // T6 — firstIncompleteStep returns nil when all granted
    func testFirstIncompleteStep_nilWhenAllGranted() {
        let checker = MockPermissionChecker()
        checker.extensionEnabled = true
        checker.screenRecordingGranted = true
        checker.accessibilityGranted = true
        let monitor = PermissionMonitor(checker: checker)

        let exp = expectation(description: "noIncomplete")
        monitor.checkAll { status in
            XCTAssertNil(status.firstIncompleteStep)
            exp.fulfill()
        }
        waitForExpectations(timeout: 1)
    }
}
```

- [ ] **Step 2: Run tests — expect compile failure (types don't exist yet)**

```fish
make test-swift 2>&1 | grep -E "error:|PermissionMonitor|PermissionChecking"
```

Expected: build errors — `PermissionChecking`, `PermissionMonitor`, `OnboardingStep` not found.

---

### Task 2: Implement `PermissionMonitor.swift`

**Files:**
- Create: `ClaudeInSafari/App/PermissionMonitor.swift`

- [ ] **Step 3: Create the implementation**

```swift
// ClaudeInSafari/App/PermissionMonitor.swift
import Foundation
import ApplicationServices
import CoreGraphics
import SafariServices

// MARK: - OnboardingStep

/// The three permission steps in setup order.
enum OnboardingStep: Equatable {
    case safariExtension
    case screenRecording
    case accessibility
}

// MARK: - PermissionStatus

struct PermissionStatus {
    let extensionEnabled: Bool
    let screenRecording: Bool
    let accessibility: Bool

    var allGranted: Bool {
        extensionEnabled && screenRecording && accessibility
    }

    /// Returns the first step not yet complete, in setup order.
    var firstIncompleteStep: OnboardingStep? {
        if !extensionEnabled { return .safariExtension }
        if !screenRecording  { return .screenRecording }
        if !accessibility    { return .accessibility }
        return nil
    }
}

// MARK: - PermissionChecking protocol

protocol PermissionChecking {
    func isAccessibilityGranted() -> Bool
    func isScreenRecordingGranted() -> Bool
    func getExtensionEnabled(completion: @escaping (Bool) -> Void)
}

// MARK: - SystemPermissionChecker

/// Production implementation that calls real macOS APIs.
struct SystemPermissionChecker: PermissionChecking {
    private static let extensionBundleID = "com.chriscantu.claudeinsafari.extension"

    func isAccessibilityGranted() -> Bool {
        AXIsProcessTrusted()
    }

    func isScreenRecordingGranted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    func getExtensionEnabled(completion: @escaping (Bool) -> Void) {
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: Self.extensionBundleID
        ) { state, _ in
            DispatchQueue.main.async {
                completion(state?.isEnabled ?? false)
            }
        }
    }
}

// MARK: - PermissionMonitor

/// Polls permission state and delivers `PermissionStatus` on the main queue.
final class PermissionMonitor {
    private let checker: PermissionChecking

    init(checker: PermissionChecking = SystemPermissionChecker()) {
        self.checker = checker
    }

    /// One-shot check of all three permissions. Calls `completion` on main queue.
    func checkAll(completion: @escaping (PermissionStatus) -> Void) {
        let accessibility = checker.isAccessibilityGranted()
        let screenRecording = checker.isScreenRecordingGranted()
        checker.getExtensionEnabled { extensionEnabled in
            let status = PermissionStatus(
                extensionEnabled: extensionEnabled,
                screenRecording: screenRecording,
                accessibility: accessibility
            )
            DispatchQueue.main.async { completion(status) }
        }
    }
}
```

- [ ] **Step 4: Verify the file is picked up automatically**

`project.yml` uses a directory-level source glob (`path: ClaudeInSafari`), so any `.swift` file placed under `ClaudeInSafari/App/` is included in the app target automatically — no explicit file registration is needed. Do **not** add it manually; a duplicate source entry will cause a build error.

> **Note:** The extension bundle ID `com.chriscantu.claudeinsafari.extension` must match the actual extension target. Verify in Xcode → ClaudeInSafari Extension target → General → Bundle Identifier if you suspect it has changed.

- [ ] **Step 5: Run tests — all 6 should pass**

```fish
make test-swift 2>&1 | grep -E "PermissionMonitor|passed|failed"
```

Expected: `PermissionMonitorTests` — 6 tests passed.

- [ ] **Step 6: Commit**

```fish
printf "feat(permissions): add PermissionMonitor with protocol-injected checker\n\nPermissionChecking protocol wraps AXIsProcessTrusted, CGPreflightScreenCaptureAccess,\nand SFSafariExtensionManager. PermissionStatus carries allGranted and firstIncompleteStep.\nSix tests cover all grant/missing combinations.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git add ClaudeInSafari/App/PermissionMonitor.swift Tests/Swift/PermissionMonitorTests.swift
git commit -F /tmp/commitmsg
```

---

## Chunk 2: MenuBarController

> **Prerequisite:** Chunk 1 must be complete. `PermissionMonitor.swift` (which defines `PermissionStatus` and `OnboardingStep`) must already be compiled into the app target before starting this chunk.

### Task 3: Write `MenuBarControllerTests.swift` (failing)

**Files:**
- Create: `Tests/Swift/MenuBarControllerTests.swift`

- [ ] **Step 1: Create the test file**

```swift
// Tests/Swift/MenuBarControllerTests.swift
import XCTest
@testable import ClaudeInSafari

final class MenuBarControllerTests: XCTestCase {

    // T1 — initial state is .notConnected
    func testInitialState_isNotConnected() {
        let controller = MenuBarController()
        XCTAssertEqual(controller.state, .notConnected)
    }

    // T2 — setState(.connected) updates state
    func testSetState_connected() {
        let controller = MenuBarController()
        controller.setState(.connected)
        XCTAssertEqual(controller.state, .connected)
    }

    // T3 — setState(.needsAttention) with message stores message
    func testSetState_needsAttention_storesMessage() {
        let controller = MenuBarController()
        controller.setState(.needsAttention("Screen Recording permission was removed"))
        if case .needsAttention(let msg) = controller.state {
            XCTAssertEqual(msg, "Screen Recording permission was removed")
        } else {
            XCTFail("Expected .needsAttention state")
        }
    }

    // T4 — menuBarState(from:) returns .connected when allGranted
    func testMenuBarState_allGranted_isConnected() {
        let status = PermissionStatus(extensionEnabled: true, screenRecording: true, accessibility: true)
        XCTAssertEqual(MenuBarController.menuBarState(from: status), .connected)
    }

    // T5 — menuBarState(from:) returns .needsAttention when screen recording revoked
    func testMenuBarState_screenRecordingRevoked_isNeedsAttention() {
        let status = PermissionStatus(extensionEnabled: true, screenRecording: false, accessibility: true)
        if case .needsAttention(let msg) = MenuBarController.menuBarState(from: status) {
            XCTAssertTrue(msg.contains("Screen Recording"), "Expected Screen Recording in message, got: \(msg)")
        } else {
            XCTFail("Expected .needsAttention state")
        }
    }

    // T6 — menuBarState(from:) returns .notConnected when extension not enabled
    func testMenuBarState_extensionNotEnabled_isNotConnected() {
        let status = PermissionStatus(extensionEnabled: false, screenRecording: true, accessibility: true)
        XCTAssertEqual(MenuBarController.menuBarState(from: status), .notConnected)
    }
}
```

- [ ] **Step 2: Run tests — expect compile failure**

```fish
make test-swift 2>&1 | grep -E "error:|MenuBarController|MenuBarState"
```

Expected: build errors — `MenuBarController`, `MenuBarState` not found.

---

### Task 4: Implement `MenuBarController.swift`

**Files:**
- Create: `ClaudeInSafari/App/MenuBarController.swift`

- [ ] **Step 3: Create the implementation**

```swift
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

    /// Callback invoked when user taps "Open Setup Again" or "Fix This →".
    var onOpenSetup: (() -> Void)?

    /// Callback invoked when user taps "Check Connection".
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
        let image = NSImage(size: size, flipped: false) { rect in
            self.drawRobot(in: rect, dimmed: state == .notConnected)
            self.drawStatusDot(in: rect, state: state)
            return true
        }
        return image
    }

    /// Draws a minimal robot silhouette using bezier paths.
    /// White paths — macOS renders the menu bar button button tinted appropriately.
    private func drawRobot(in rect: NSRect, dimmed: Bool) {
        let color = dimmed ? NSColor.white.withAlphaComponent(0.35) : NSColor.white
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

        // Eyes — punch out using background color (orange on orange containers; here use clear to show menu bar bg)
        NSColor.clear.setFill()
        // Left eye
        NSBezierPath(ovalIn: NSRect(x: 5.5, y: 9.5, width: 2.5, height: 2.5)).fill()
        // Right eye
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
            menu.addItem(makeItem("Check Connection", action: #selector(checkConnection), symbol: "🔍"))
            menu.addItem(makeItem("Open Safari", action: #selector(openSafari), symbol: "🧭"))
            menu.addItem(makeItem("Open Setup Again", action: #selector(openSetup), symbol: "⚙️"))

        case .needsAttention:
            let fixItem = makeItem("Fix This →", action: #selector(openSetup), symbol: "🔧")
            fixItem.attributedTitle = NSAttributedString(
                string: "🔧  Fix This →",
                attributes: [
                    .foregroundColor: NSColor(red: 0.851, green: 0.467, blue: 0.341, alpha: 1),
                    .font: NSFont.systemFont(ofSize: 13, weight: .semibold)
                ]
            )
            menu.addItem(fixItem)
            menu.addItem(.separator())
            menu.addItem(makeItem("Open Safari", action: #selector(openSafari), symbol: "🧭"))

        case .notConnected:
            menu.addItem(makeItem("Open Setup", action: #selector(openSetup), symbol: "⚙️"))
        }

        menu.addItem(.separator())
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

        // Robot avatar (small orange rounded rect)
        let avatarSize: CGFloat = 32
        let avatar = NSView(frame: NSRect(x: 12, y: 10, width: avatarSize, height: avatarSize))
        avatar.wantsLayer = true
        avatar.layer?.cornerRadius = 8
        avatar.layer?.backgroundColor = NSColor(red: 0.851, green: 0.467, blue: 0.341, alpha: 1).cgColor
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
    @objc private func openSafari()      { NSWorkspace.shared.open(URL(string: "safari://")!) }
    @objc private func quitApp()         { NSApplication.shared.terminate(nil) }
}
```

- [ ] **Step 4: Add `MenuBarController.swift` to the app target** (same as Task 2 Step 4)

- [ ] **Step 5: Run tests — all 6 should pass**

```fish
make test-swift 2>&1 | grep -E "MenuBarController|passed|failed"
```

Expected: `MenuBarControllerTests` — 6 tests passed.

- [ ] **Step 6: Commit**

```fish
printf "feat(menubar): add MenuBarController with 3-state NSStatusItem menu\n\nMenuBarState enum (.connected / .needsAttention / .notConnected) drives icon\ncompositing and menu construction. Static menuBarState(from:) is pure and\ntestable. Robot drawn programmatically via NSBezierPath.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git add ClaudeInSafari/App/MenuBarController.swift Tests/Swift/MenuBarControllerTests.swift
git commit -F /tmp/commitmsg
```

---

## Chunk 3: OnboardingWindowController

> This chunk has no meaningful unit tests for the AppKit view layout — visual correctness is verified manually. The state machine logic (which step to show, when to advance) is covered by the PermissionMonitor tests already written. Focus on getting the window to build, show, and navigate correctly.

### Task 5: Implement `OnboardingWindowController.swift`

**Files:**
- Create: `ClaudeInSafari/App/OnboardingWindowController.swift`

- [ ] **Step 1: Create the window controller**

```swift
// ClaudeInSafari/App/OnboardingWindowController.swift
import Cocoa
import ApplicationServices

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
        monitor.checkAll { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                switch step {
                case .safariExtension where status.extensionEnabled: self.advance()
                case .screenRecording where status.screenRecording:  self.advance()
                case .accessibility   where status.accessibility:    self.advance()
                default: break
                }
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
        label.frame = NSRect(x: 32, y: 8, width: Layout.windowWidth - Layout.padding * 2 - 40, height: 16)
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
                bar.layer?.backgroundColor = NSColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1).cgColor  // green
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
            lbl.textColor = i < activeIndex ? NSColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1)
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
```

- [ ] **Step 2: Add `OnboardingWindowController.swift` to the app target** (same as Task 4, Step 4 — `project.yml` dir-glob picks it up automatically)

- [ ] **Step 3: Build — no unit tests here, verify it compiles**

```fish
make build 2>&1 | grep -E "error:|warning:|BUILD"
```

Expected: `BUILD SUCCEEDED` with no errors.

- [ ] **Step 3b: Manual smoke test — launch and walk all 5 screens**

```fish
make run
```

Checklist (verify each manually):
- [ ] Window appears automatically on launch (all permissions are revoked in test environment)
- [ ] Welcome screen shows robot icon, "Connect Claude Code to Safari" headline, "Get Started →" and "I'll set this up later" buttons; no timeline strip
- [ ] "I'll set this up later" closes the window immediately; menu bar icon appears dimmed
- [ ] "Get Started →" advances to Step 1 (Safari Extension); timeline strip shows segment 1 active (orange), 2–3 gray
- [ ] Spinner (`NSProgressIndicator`) is animated (not a static dot) on each step screen
- [ ] "Open Safari Settings" CTA opens Safari (via `safari-settings://` or Safari.app fallback)
- [ ] "I already did this →" button advances to the next step without waiting for detection
- [ ] Step 2 and Step 3 screens show correct System Settings deep-link CTAs
- [ ] Done screen shows checkmark, no timeline strip
- [ ] "Done" button closes the window; no crash or double-dismiss

- [ ] **Step 4: Commit**

```fish
printf "feat(onboarding): add OnboardingWindowController — 5-screen setup wizard\n\nProgrammatic AppKit wizard: Welcome → SafariExtension → ScreenRecording\n→ Accessibility → Done. Each step polls PermissionMonitor at 500ms and\nauto-advances on detection. Manual fallback button on every step.\nTimeline strip (3 segments) shown on step screens only.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git add ClaudeInSafari/App/OnboardingWindowController.swift
git commit -F /tmp/commitmsg
```

---

## Chunk 4: AppDelegate Integration + LSUIElement

### Task 6: Wire everything into AppDelegate and flip LSUIElement

**Files:**
- Modify: `ClaudeInSafari/App/AppDelegate.swift`
- Modify: `ClaudeInSafari/Info.plist`

- [ ] **Step 1: Update `Info.plist` — set `LSUIElement` to `true`**

In `ClaudeInSafari/Info.plist`, change:
```xml
<key>LSUIElement</key>
<false/>
```
to:
```xml
<key>LSUIElement</key>
<true/>
```

This removes the app from the Dock and `Cmd-Tab`. The only quit path is the Quit item in the menu bar menu.

- [ ] **Step 2: Rewrite `AppDelegate.swift`**

```swift
// ClaudeInSafari/App/AppDelegate.swift
import Cocoa
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    // MARK: - Private state

    private var mcpServer: MCPSocketServer?
    private var toolRouter: ToolRouter?
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
        controller.onOpenSetup = { [weak self] in self?.showOnboarding() }
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

    private func showOnboarding(startingAt step: OnboardingStep? = nil) {
        if onboardingWindowController == nil {
            let wc = OnboardingWindowController(monitor: permissionMonitor)
            wc.onDismiss = { [weak self] in
                self?.onboardingWindowController = nil
                self?.startContinuousMonitoring()
                self?.updateMenuBarState()
            }
            onboardingWindowController = wc
        }
        onboardingWindowController?.showOnboarding(startingAt: step)
    }

    // MARK: - Continuous Monitoring

    private func startContinuousMonitoring() {
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
                NSLog("Notification authorization denied")
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == "stop-automation" {
            if let router = toolRouter {
                router.cancelCurrentRequest()
            } else {
                NSLog("AppDelegate: received stop-automation but toolRouter is nil")
            }
        }
        completionHandler()
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
```

- [ ] **Step 3: Build and run**

```fish
make build 2>&1 | grep -E "error:|BUILD"
make run
```

Expected: `BUILD SUCCEEDED`. App launches with no Dock icon. Menu bar shows robot icon.

- [ ] **Step 4: Manual smoke test — onboarding flow**

With the app running:
1. Verify robot icon appears in menu bar with red/yellow dot (some permissions likely not yet granted in dev)
2. Click the icon — verify menu appears with correct state-appropriate items
3. Click "Open Setup" or "Open Setup Again" — verify the Welcome screen appears
4. Click "Get Started →" — verify Step 1 (Safari Extension) appears with timeline showing segment 1 orange
5. Click "I already did this →" — verify Step 2 (Screen Recording) appears, segment 1 green, segment 2 orange
6. Click "I already did this →" — verify Step 3 (Accessibility) appears, segments 1–2 green, segment 3 orange
7. Click "I already did this →" — verify Done screen appears
8. Click "Done" — verify window closes and menu bar updates

- [ ] **Step 5: Run full test suite to confirm no regressions**

```fish
make test-all 2>&1 | grep -E "passed|failed|error:"
```

Expected: all existing tests pass + new PermissionMonitorTests (6) + MenuBarControllerTests (6).

- [ ] **Step 6: Commit**

```fish
printf "feat(app): wire menu bar + onboarding into AppDelegate, set LSUIElement=true\n\nApp now lives in the menu bar (no Dock icon). On launch, checks all\npermissions — shows onboarding at first incomplete step if needed,\nor starts 5s continuous monitoring if all granted. Quit is via menu bar.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git add ClaudeInSafari/App/AppDelegate.swift ClaudeInSafari/Info.plist
git commit -F /tmp/commitmsg
```

---

### Task 7: Update STRUCTURE.md

**Files:**
- Modify: `STRUCTURE.md`

- [ ] **Step 1: Add new files to the structure listing**

In `STRUCTURE.md`, update the `App/` section from:

```
│   │   ├── App/
│   │   │   └── AppDelegate.swift            # App lifecycle, menu bar status item, setup wizard
```

to:

```
│   │   ├── App/
│   │   │   ├── AppDelegate.swift            # App lifecycle — wires menu bar, onboarding, MCP server, notifications
│   │   │   ├── MenuBarController.swift      # NSStatusItem, MenuBarState enum, icon compositing, menu construction
│   │   │   ├── OnboardingWindowController.swift  # 5-screen setup wizard: Welcome → 3 permission steps → Done
│   │   │   └── PermissionMonitor.swift      # PermissionChecking protocol, SystemPermissionChecker, polling
```

And add to the Tests section:

```
│   │   ├── MenuBarControllerTests.swift
│   │   ├── PermissionMonitorTests.swift
```

- [ ] **Step 2: Commit**

```fish
printf "docs(structure): document new onboarding UI files\n\nAdds MenuBarController, OnboardingWindowController, PermissionMonitor\nto STRUCTURE.md App/ listing and their test counterparts to Tests/Swift/.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
git add STRUCTURE.md
git commit -F /tmp/commitmsg
```

---

## Final Verification

- [ ] Run `make test-all` — all tests pass (JS + Swift)
- [ ] Run `make build` — BUILD SUCCEEDED
- [ ] Run `make run` — app launches, menu bar icon appears, no Dock icon
- [ ] Manually walk the full onboarding flow (Task 6 Step 4 checklist)
- [ ] Click robot menu → Quit — app exits cleanly
- [ ] Confirm extension bundle ID in `SystemPermissionChecker.extensionBundleID` matches the actual extension target bundle ID in Xcode
