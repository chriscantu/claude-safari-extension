# Spec 022 — Full Swift Test Coverage

## Goal

Close test coverage gaps across all Swift source files. Focus on logic that can hide real bugs — error classification, debounce state machines, lifecycle coordination — not UI rendering or live OS API integration.

## Scope

Five areas, ordered by bug-catching value.

---

### 1. AppleScriptBridge — error classification

**File:** `ClaudeInSafari/Services/AppleScriptBridge.swift`
**Test file:** `Tests/Swift/AppleScriptBridgeTests.swift`

**Problem:** `runAppleScript()` is private and coupled to `Process`. The error classification logic — matching sentinel codes `(9001)`, `(9002)`, TCC codes `-1743`/`-25212`, signal kills — is the most fragile part. macOS version changes could alter error strings.

**Change:** Extract an `internal` method:

```swift
func classifyScriptError(terminationReason: Process.TerminationReason,
                         exitCode: Int32, stderr: String) -> ResizeError
```

`runAppleScript()` calls this method instead of inline matching. No behavior change.

**Tests (~9):**

| Test | Input | Expected |
|------|-------|----------|
| Sentinel 9001 | stderr contains `(9001)` | `.noWindowFound` |
| Sentinel 9002 | stderr contains `(9002)` | `.fullscreen` |
| TCC -1743 | stderr contains `-1743` | `.permissionDenied` |
| TCC -25212 | stderr contains `-25212` | `.permissionDenied` |
| "not authorized" (case-insensitive) | stderr contains `Not Authorized` | `.permissionDenied` |
| Signal kill | `.uncaughtSignal`, exit 9 | `.executionFailed` with signal info |
| Generic non-zero | exit 1, stderr `"some error"` | `.executionFailed("some error")` |
| Empty stderr non-zero | exit 1, stderr `""` | `.executionFailed` with exit code msg |
| Sentinel takes priority | stderr contains both `(9001)` and `-1743` | `.noWindowFound` (first match wins) |

---

### 2. PermissionMonitor — debounce logic

**File:** `ClaudeInSafari/App/PermissionMonitor.swift`
**Test file:** `Tests/Swift/PermissionMonitorTests.swift`

**Problem:** `MockPermissionChecker.extensionEnabled` is a single `Bool`. The debounce requires two consecutive identical reads to adopt a new value — completely untested.

**Change:** Extend `MockPermissionChecker` with a sequence-based return:

```swift
var extensionEnabledSequence: [Bool] = []
// In getExtensionEnabled: pop from front; fall back to extensionEnabled when empty
```

No production code changes.

**Tests (~5):**

| Test | Sequence | Expected |
|------|----------|----------|
| First call reports raw value via fallback | `[true]` | Reports `true` (`lastExtensionEnabled` is nil, falls through to raw value via `??`) |
| Single flicker suppressed | Stable `true`, then one `false` | Still reports `true` |
| Two consecutive adopt | Stable `true`, then two `false` | Reports `false` |
| Alternating never changes | `true, false, true, false` | Stays on initial value |
| Dealloc mid-check | Deallocate monitor before completion | Delivers `PermissionStatus(false, false, false)` |

---

### 3. AppDelegate — lifecycle & notification handling

**File:** `ClaudeInSafari/App/AppDelegate.swift`
**Test file:** `Tests/Swift/AppDelegateTests.swift` (new)

**Problem:** 0% coverage. AppDelegate is a coordinator — its dependencies are well-tested individually. The highest-risk untested logic is notification action routing and lifecycle cleanup.

**Change:** Extract `handleNotificationAction(_:)` as an `internal` method so tests can call it without constructing a `UNNotificationResponse`:

```swift
/// Routes a notification action identifier to the appropriate handler.
/// Extracted from userNotificationCenter(_:didReceive:) for testability.
func handleNotificationAction(_ identifier: String)
```

Make `toolRouter` accessible via `internal` access level (remove `private`) for test injection.

**Tests (~5):**

| Test | Input | Expected |
|------|-------|----------|
| stop-automation with router | `"stop-automation"` | `cancelCurrentRequest()` called |
| stop-automation without router | `"stop-automation"`, nil toolRouter | No crash, logs |
| Default action | `UNNotificationDefaultActionIdentifier` | No-op |
| Unknown action | `"unknown-action"` | No-op |
| Terminate nil-safety | Call `applicationWillTerminate` without prior launch | No crash (nil timer/server are safe) |

---

### 4. ToolRouter — zoom region parsing

**File:** `ClaudeInSafari/MCP/ToolRouter.swift`
**Test file:** `Tests/Swift/ToolRouterTests.swift`

**Problem:** Zoom region `[Int]` array parsing in `handleScreenshotAction` is only tested indirectly through `parseResizeDimensions`. `handleScreenshotAction` is `private`, so tests must go through the delegate method.

**Change:** Extract zoom region parsing into an `internal` function (same pattern as the existing `parseResizeDimensions`):

```swift
func parseZoomRegion(_ arguments: [String: Any]) -> (x: Int, y: Int, width: Int, height: Int)?
```

**Tests (~3):**

| Test | Input | Expected |
|------|-------|----------|
| Valid zoom region | `zoomRegion: [100, 200, 300, 400]` | Returns `(100, 200, 300, 400)` |
| Wrong length | `zoomRegion: [100, 200]` | Returns `nil` |
| Non-integer elements | `zoomRegion: ["a", "b", "c", "d"]` | Returns `nil` |

---

### 5. MCPSocketServer — stale socket cleanup

**File:** `ClaudeInSafari/MCP/MCPSocketServer.swift`
**Test file:** `Tests/Swift/MCPSocketServerTests.swift`

**Problem:** On `start()`, the server removes stale `.sock` files from its directory. Untested.

**Change:** No production changes.

**Tests (~2):**

| Test | Setup | Expected |
|------|-------|----------|
| All existing sock files removed on start | Create dummy `.sock` in socket dir before `start()` | File removed after start |
| Non-sock files preserved | Create `.txt` file in socket dir | File still present after start |

---

## Out of Scope

- **MenuBarController UI rendering** — NSStatusItem/bezier paths. Low bug risk, manual regression covers it.
- **ScreenCaptureKit integration** — requires live permission. Mock tests already cover logic.
- **BrandColors** — two constants, no logic.
- **OnboardingWindowController view building** — NSView construction is better validated manually.
- **OnboardingWindowController polling** — Already tested (T10–T15 cover auto-advance, guard checks, stale callbacks).

## Summary

~24 new test methods across 4 existing test files + 1 new file (`AppDelegateTests.swift`). Minimal production refactors: extract `classifyScriptError()`, `handleNotificationAction()`, and `parseZoomRegion()`; widen access on `toolRouter` for test injection.
