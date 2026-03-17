# Spec 021 — Onboarding UI

## Overview

The onboarding UI guides first-time users through enabling the Safari extension and granting
the two macOS permissions (Screen Recording, Accessibility) required for Claude in Safari to
function. It also adds a persistent menu bar presence so users can check connection status
and re-open the setup wizard at any time.

## Scope

- **`PermissionMonitor`** — polls Safari extension state, Screen Recording, and Accessibility
  permissions; delivers `PermissionStatus` on the main queue via protocol-injected checker
- **`MenuBarController`** — `NSStatusItem` with 3-state icon (connected / needs-attention /
  not-connected) and contextual menu (Open Setup, Check Connection, Quit)
- **`OnboardingWindowController`** — programmatic AppKit 5-screen wizard:
  Welcome → Safari Extension → Screen Recording → Accessibility → Done
  Each step polls every 0.5 s and auto-advances when the required permission is granted
- **`AppDelegate` integration** — `LSUIElement=true` hides the Dock icon; first-run check
  shows onboarding if any permission is missing; 5-second continuous monitoring keeps the
  menu bar icon in sync after setup

## Files

| File | Role |
|------|------|
| `ClaudeInSafari/App/PermissionMonitor.swift` | Permission checking + polling |
| `ClaudeInSafari/App/MenuBarController.swift` | Menu bar presence |
| `ClaudeInSafari/App/OnboardingWindowController.swift` | 5-screen setup wizard |
| `ClaudeInSafari/App/AppDelegate.swift` | Wiring + LSUIElement |
| `Tests/Swift/PermissionMonitorTests.swift` | Unit tests for PermissionMonitor |
| `Tests/Swift/MenuBarControllerTests.swift` | Unit tests for MenuBarController |
| `Tests/Swift/OnboardingWindowControllerTests.swift` | Unit tests for OnboardingWindowController |

## Key Decisions

- **No XIBs or storyboards** — all UI is programmatic AppKit for maintainability
- **Protocol injection** (`PermissionChecking`) separates testable logic from OS APIs
- **`dismissed` flag** prevents double-firing of `onDismiss` across all three close paths
  (Done button, "later" link, title-bar red button)
- **macOS 14.0 minimum** — deployment target raised to support SF Symbols used in wizard

## Safari Degradations

None — this feature is pure native macOS Swift/AppKit with no Safari extension involvement.
