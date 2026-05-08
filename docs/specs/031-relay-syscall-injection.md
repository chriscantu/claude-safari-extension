# Spec 031 — Relay Syscall Injection for Test Coverage

## Goal

Make the EINTR-retry loops and partial-write advancement in
`BridgeRelay.relay()` (lines 214-322 of `safari-mcp-bridge/BridgeRelay.swift`)
addressable from XCTest, without changing production behavior.

These are POSIX I/O loops where off-by-one or missing-retry bugs cause
silent data loss / hangs in production under load. PR #64 review Finding #1
(High severity) flagged the gap.

## Problem

`relay()` is `private static`, calls `Darwin.read` / `Darwin.write` directly,
and runs on two GCD threads. Real syscalls cannot deterministically produce
EINTR or partial writes under unit test load. A `socketpair()` fixture covers
happy-path + EOF but cannot reach the high-risk branches.

## Change

### Production: minimal injection point

Two additions to `BridgeRelay`:

```swift
typealias ReadFn  = (Int32, UnsafeMutableRawPointer, Int) -> Int
typealias WriteFn = (Int32, UnsafeRawPointer, Int) -> Int

static func relay(
    stdinFD: Int32,
    stdoutFD: Int32,
    socketFD fd: Int32,
    readFn:  @escaping ReadFn  = { Darwin.read($0, $1, $2) },
    writeFn: @escaping WriteFn = { Darwin.write($0, $1, $2) }
) -> RelayExitReason
```

Visibility change: `private` → `internal` (default). Required for
cross-file test access — `safari-mcp-bridge` is a command-line executable,
not a framework, so `@testable import` is unavailable.

Default closures call the real syscalls. The production caller in `run()`
passes no extra arguments and is unaffected: the call site is bit-for-bit
identical at the SIL level.

### Test: deterministic mock harness

`Tests/Swift/BridgeRelayTests.swift` adds a `MockSyscalls` helper class
scoped to the test class. Per-fd queues of programmed `ReadOp` / `WriteOp`
values let each test inject EINTR, partial writes, write errors, and
zero-byte writes per call. `errno` is set thread-locally to mimic real
syscall semantics.

## Test Matrix

| # | Test | Path covered |
|---|---|---|
| 1 | `testRelay_stdinEOF_returnsStdinEOF` | clean stdin EOF → `.stdinEOF` |
| 2 | `testRelay_stdinReadEINTR_retriesUntilEOF` | stdin read EINTR retry (~L235) |
| 3 | `testRelay_stdinReadError_returnsStdinEOF` | stdin non-EINTR read error (~L244) |
| 4 | `testRelay_socketWriteEINTR_retriesAndCompletes` | socket write EINTR retry (~L246) |
| 5 | `testRelay_socketPartialWrite_advancesBuffer` | socket partial-write advancement (~L242-257) |
| 6 | `testRelay_socketWriteError_returnsSocketError` | socket non-EINTR write error → `.socketError` |
| 7 | `testRelay_socketReadEINTR_retriesUntilEOF` | socket read EINTR retry (~L282) |
| 8 | `testRelay_socketReadError_doesNotRetry` | socket non-EINTR read error (~L297) |
| 9 | `testRelay_stdoutWriteEINTR_retriesAndCompletes` | stdout write EINTR retry (~L307) |
| 10 | `testRelay_stdoutWriteError_doesNotRetry` | stdout non-EINTR write error |
| 11 | `testRelay_stdoutPartialWrite_advancesBuffer` | stdout partial-write advancement (~L304-315) |
| 12 | `testRelay_zeroByteWrite_breaksWithoutHang` | `w == 0` break on socket — no infinite loop |
| 13 | `testRelay_zeroByteStdoutWrite_breaksWithoutHang` | `w == 0` break on stdout — no infinite loop |

EINTR retry tests assert exact call counts (`== 3`) so an over-retry past EOF
fails the test. Partial-write tests assert exact call counts and cumulative
bytes — catches off-by-one in `written += w`.

## Non-Goals

- No behavior change to `relay()`. Defaults preserve syscall semantics
  byte-for-byte.
- No mock for `shutdown()` — its return code is already ignored by relay.
- No mock for `DispatchQueue.global().async` — real GCD is fine; tests
  block on `relay()` which blocks on `group.wait()`.

## Verification

- `xcodebuild test -only-testing:ClaudeInSafariTests/BridgeRelayTests` passes
- Full Swift suite still green
- Production callers (`run()`) unchanged at the source level
