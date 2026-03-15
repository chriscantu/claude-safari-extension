# Phase 7 Cleanup — Deferred REVIEW.md Items

**Branch:** `chore/phase7-cleanup`
**PR scope:** M5, M6, L3, L5 from the original REVIEW.md deferred list

---

## Changes

### M5 — Extract `normalizePayload()` in `background.js`

**File:** `ClaudeInSafari Extension/Resources/background.js`

The poll loop inlines payload parsing (JSON.parse + string/object fallback) in the middle of dispatch logic, violating SRP.

**Fix:** Extract a `normalizePayload(response)` helper function declared at module scope above `pollForWork`. It accepts the raw poll response and returns a parsed payload object (JSON.parse if string, pass-through if already an object), throwing on malformed input. The poll loop calls it and catches errors exactly as before. Pure refactor — no behavior change.

**Scope:** ~10 lines moved, not rewritten. No new tests required (existing poll-loop tests exercise the same path).

---

### M6 — Remove `__captureResolveTab` test hook from `tabs-manager.js`

**Files:**
- `ClaudeInSafari Extension/Resources/tools/tabs-manager.js` (production)
- `Tests/JS/tabs-manager.test.js` (tests)

Lines 227–228 of `tabs-manager.js` check `globalThis.__captureResolveTab` and invoke it if present. This is a test-only hook that leaks into production code.

**Fix:**
1. Delete lines 227–228 from `tabs-manager.js`
2. Update the 3 call sites in `tabs-manager.test.js` (tests T5, T6, T9) that set `globalThis.__captureResolveTab`. Each test calls `jest.resetModules()` then `require(...)` to load the module. After the `require(...)` call, read `resolveTabFn = globalThis.resolveTab` directly — `tabs-manager.js` already exports the function on `globalThis` at load time, so it is available immediately after `require`. This is the same function object the hook was capturing, so behavior is identical.

Zero production behavior change. Tests become simpler.

---

### L3 — Add `AnyCodable` edge case tests in `MCPMessageTests.swift`

**File:** `Tests/Swift/MCPMessageTests.swift`

The `AnyCodable` implementation in `MCPMessage.swift` is sound — it handles Bool/Int/NSNumber distinction via CFBooleanGetTypeID, NSNull, String, Double, and recursive Array/Dict. The gap is test coverage for edge cases.

**Fix:** Add roundtrip encode/decode tests for the four cases not currently covered:
- `null` — `NSNull` round-trips as JSON `null`
- `String` — plain string value encodes and decodes correctly
- Nested `Array` — `[Any]` with mixed types round-trips
- Nested `Dict` — `[String: Any]` with mixed values round-trips

Bool, Int, Double, and the tricky NSNumber/CFBoolean cases are already covered by existing tests (`testAnyCodableEncodesNSBooleanTrueAsBool`, `testAnyCodableEncodesNSNumberIntegerAsInt`, `testAnyCodableEncodesNSNumberDoubleAsDouble`, `testAnyCodableRoundTripPreservesTypesFromRawJSON`). Do not duplicate those.

No implementation changes to `AnyCodable`.

---

### L5 — Delete dead structs from `MCPMessage.swift`

**File:** `ClaudeInSafari/Models/MCPMessage.swift`

`ToolRequest` (lines 4–7) and `ToolRequestParams` (lines 9–19) are defined but never referenced anywhere in the codebase. They are leftover from an earlier design where `ToolRouter` decoded the MCP wire format through typed structs; `ToolRouter` now uses `JSONSerialization` directly.

**Fix:** Delete both structs. They are dead code — never decoded from live data, never instantiated, never referenced outside their own definitions. Deletion has no runtime effect. `NativeMessageContext.clientId` (in `ToolModels.swift`) is unrelated and remains unchanged.

---

## Verification

```fish
npm test              # M5 + M6: all JS tests pass
make test-swift       # L3 + L5: new AnyCodable tests pass, dead code gone
```

No regression test sections are affected — none of these items touch tool behavior.

---

## Out of Scope

- **L2** (MCPSocketServer tests): deferred to a dedicated PR — requires designing a socket test harness (real UDS or socketpair abstraction) that warrants its own focused session.
- M3, M4, M7, L4: already resolved in prior PRs.
