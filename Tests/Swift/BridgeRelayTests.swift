import XCTest
@testable import ClaudeInSafari

final class BridgeRelayTests: XCTestCase {

    // MARK: - Backoff formula tests

    /// Verify the backoff sequence doubles from base up to max cap:
    /// attempt 0 → 100ms, 1 → 200ms, 2 → 400ms, 3 → 800ms, 4 → 1600ms, 5+ → 2000ms
    func testBackoffSequence_doublesFromBaseToMax() {
        let baseUs: UInt64 = 100_000  // 100ms in microseconds
        let maxUs: UInt64 = 2_000_000 // 2s in microseconds

        func formula(_ attempt: Int) -> UInt64 {
            min(baseUs * (1 << UInt64(min(attempt, 20))), maxUs)
        }

        XCTAssertEqual(formula(0), 100_000)   // 100ms
        XCTAssertEqual(formula(1), 200_000)   // 200ms
        XCTAssertEqual(formula(2), 400_000)   // 400ms
        XCTAssertEqual(formula(3), 800_000)   // 800ms
        XCTAssertEqual(formula(4), 1_600_000) // 1600ms
        XCTAssertEqual(formula(5), 2_000_000) // 2000ms (capped)
        XCTAssertEqual(formula(10), 2_000_000) // still capped
        XCTAssertEqual(formula(20), 2_000_000) // still capped
    }

    /// Verify total elapsed time for reasonable attempt counts stays well under 30s.
    func testBackoffTotalTime_staysWithinTimeout() {
        let baseUs: UInt64 = 100_000
        let maxUs: UInt64 = 2_000_000
        let timeoutUs: UInt64 = 30_000_000 // 30s in microseconds

        func formula(_ attempt: Int) -> UInt64 {
            min(baseUs * (1 << UInt64(min(attempt, 20))), maxUs)
        }

        // Sum the backoff delays for 20 attempts (more than enough to hit 30s with 2s cap)
        var total: UInt64 = 0
        for i in 0..<20 {
            total += formula(i)
        }
        // 20 attempts: first 5 sum to ~3.1s, remaining 15 at 2s each = 33.1s total
        // BUT the loop should break when elapsed >= timeoutUs, not after 20 attempts.
        // Verify the formula itself: 6 attempts at or below cap sums to < 30s.
        var earlyTotal: UInt64 = 0
        for i in 0..<6 {
            earlyTotal += formula(i)
        }
        // 100 + 200 + 400 + 800 + 1600 + 2000 = 5100ms — well within 30s
        XCTAssertLessThan(earlyTotal, timeoutUs, "First 6 backoff delays should total less than 30s")

        // Verify the cap ensures we don't wildly overshoot in a single sleep
        XCTAssertLessThanOrEqual(formula(100), maxUs, "Backoff should never exceed maxUs")
    }

    /// Verify BridgeRelay.backoffDelay(attempt:) returns the expected sequence.
    func testBackoffDelay_matchesExpectedSequence() {
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 0), 100_000)   // 100ms
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 1), 200_000)   // 200ms
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 2), 400_000)   // 400ms
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 3), 800_000)   // 800ms
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 4), 1_600_000) // 1600ms
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 5), 2_000_000) // capped at 2s
        XCTAssertEqual(BridgeRelay.backoffDelay(attempt: 20), 2_000_000) // still capped
    }

    // MARK: - findNewestSocket tests

    func testFindNewestSocket_returnsNewestByMtime() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let older = tmpDir.appendingPathComponent("111.sock")
        let newer = tmpDir.appendingPathComponent("222.sock")
        FileManager.default.createFile(atPath: older.path, contents: nil)
        sleep(1)
        FileManager.default.createFile(atPath: newer.path, contents: nil)

        let result = BridgeRelay.findNewestSocket(in: tmpDir.path)
        XCTAssertEqual(result, newer.path)
    }

    func testFindNewestSocket_returnsNilWhenEmpty() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let result = BridgeRelay.findNewestSocket(in: tmpDir.path)
        XCTAssertNil(result)
    }

    // MARK: - Auto-Reconnect (Spec 029 Change 4)

    func testVerifyConnection_returnsNilForNonexistentSocket() throws {
        let result = BridgeRelay.verifyConnection(socketPath: "/tmp/nonexistent-\(UUID().uuidString).sock")
        XCTAssertNil(result, "Should return nil when socket does not exist")
    }

    func testBackoffDelay_largeAttemptDoesNotOverflow() {
        let delay = BridgeRelay.backoffDelay(attempt: 99)
        XCTAssertEqual(delay, BridgeRelay.backoffMaxUs, "Very large attempt should cap at max")
    }

    func testPerformHandshake_returnsFalseForBadFd() {
        // performHandshake should return false when given an invalid fd
        // (simulates what happens when the app dies mid-reconnect)
        let result = BridgeRelay.performHandshake(fd: -1)
        XCTAssertFalse(result, "performHandshake should fail gracefully on invalid fd")
    }

    func testSessionMetrics_areAccessible() {
        // Session tracking vars are static on an enum — they are process-global
        // and cannot be reliably asserted on initial state (test order dependent).
        // This test verifies the vars exist and are the expected types.
        let _: Date? = BridgeRelay.bridgeSessionStart
        let _: Int = BridgeRelay.bridgeReconnectCount
    }

    // MARK: - relay() syscall-injected tests
    //
    // Cover the EINTR-retry loops and partial-write advancement in relay().
    // Real syscalls cannot deterministically produce EINTR / partial writes
    // under unit test load, so we inject mock read/write closures.
    //
    // Fake fds are used (100/101/102). `shutdown()` calls inside relay() will
    // fail harmlessly on them; relay ignores those return codes by design.

    private static let mockStdinFD: Int32 = 100
    private static let mockStdoutFD: Int32 = 101
    private static let mockSocketFD: Int32 = 102

    private final class MockSyscalls {
        enum ReadOp {
            case bytes([UInt8])
            case error(errno: Int32)
            case eof
        }
        enum WriteOp {
            case full
            case partial(Int)
            case error(errno: Int32)
            case zero
        }

        private let lock = NSLock()
        private var reads: [Int32: [ReadOp]] = [:]
        private var writes: [Int32: [WriteOp]] = [:]
        private var _written: [Int32: [UInt8]] = [:]
        private var _readCalls: [Int32: Int] = [:]
        private var _writeCalls: [Int32: Int] = [:]

        func enqueueReads(fd: Int32, _ ops: ReadOp...) {
            lock.lock(); defer { lock.unlock() }
            reads[fd, default: []].append(contentsOf: ops)
        }

        func enqueueWrites(fd: Int32, _ ops: WriteOp...) {
            lock.lock(); defer { lock.unlock() }
            writes[fd, default: []].append(contentsOf: ops)
        }

        func writtenBytes(_ fd: Int32) -> [UInt8] {
            lock.lock(); defer { lock.unlock() }
            return _written[fd] ?? []
        }

        func readCallCount(_ fd: Int32) -> Int {
            lock.lock(); defer { lock.unlock() }
            return _readCalls[fd] ?? 0
        }

        func writeCallCount(_ fd: Int32) -> Int {
            lock.lock(); defer { lock.unlock() }
            return _writeCalls[fd] ?? 0
        }

        func readFn(_ fd: Int32, _ buf: UnsafeMutableRawPointer, _ n: Int) -> Int {
            lock.lock()
            _readCalls[fd, default: 0] += 1
            let op: ReadOp
            if let next = reads[fd]?.first {
                reads[fd]!.removeFirst()
                op = next
            } else {
                // Queue exhausted — default to EOF so threads can exit cleanly.
                lock.unlock()
                return 0
            }
            lock.unlock()
            switch op {
            case .bytes(let bytes):
                let copyN = min(bytes.count, n)
                bytes.withUnsafeBufferPointer { src in
                    if let base = src.baseAddress {
                        buf.copyMemory(from: base, byteCount: copyN)
                    }
                }
                return copyN
            case .error(let e):
                errno = e
                return -1
            case .eof:
                return 0
            }
        }

        func writeFn(_ fd: Int32, _ buf: UnsafeRawPointer, _ n: Int) -> Int {
            lock.lock()
            _writeCalls[fd, default: 0] += 1
            let op: WriteOp = (writes[fd]?.first).map { _ in writes[fd]!.removeFirst() } ?? .full
            switch op {
            case .full:
                let typed = buf.assumingMemoryBound(to: UInt8.self)
                let bp = UnsafeBufferPointer(start: typed, count: n)
                _written[fd, default: []].append(contentsOf: bp)
                lock.unlock()
                return n
            case .partial(let k):
                let take = min(max(k, 0), n)
                let typed = buf.assumingMemoryBound(to: UInt8.self)
                let bp = UnsafeBufferPointer(start: typed, count: take)
                _written[fd, default: []].append(contentsOf: bp)
                lock.unlock()
                return take
            case .error(let e):
                lock.unlock()
                errno = e
                return -1
            case .zero:
                lock.unlock()
                return 0
            }
        }
    }

    /// Stdin closes immediately → relay should report `.stdinEOF`.
    func testRelay_stdinEOF_returnsStdinEOF() {
        let mock = MockSyscalls()
        mock.enqueueReads(fd: Self.mockStdinFD, .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF)
    }

    /// EINTR on stdin read must `continue` — not break, not error.
    /// After retry, EOF should produce `.stdinEOF`.
    func testRelay_stdinReadEINTR_retriesUntilEOF() {
        let mock = MockSyscalls()
        mock.enqueueReads(fd: Self.mockStdinFD, .error(errno: EINTR), .error(errno: EINTR), .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF)
        XCTAssertEqual(mock.readCallCount(Self.mockStdinFD), 3,
            "EINTR must retry exactly the queued ops: 2 EINTR + 1 EOF = 3 reads. " +
            "A higher count would indicate over-retry past EOF.")
    }

    /// EINTR on socket write must `continue` — bytes must still be delivered after retry.
    func testRelay_socketWriteEINTR_retriesAndCompletes() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array("hello".utf8)
        mock.enqueueReads(fd: Self.mockStdinFD, .bytes(payload), .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)
        mock.enqueueWrites(fd: Self.mockSocketFD, .error(errno: EINTR), .full)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF)
        XCTAssertEqual(mock.writtenBytes(Self.mockSocketFD), payload,
            "All payload bytes must be delivered after EINTR retry")
        XCTAssertGreaterThanOrEqual(mock.writeCallCount(Self.mockSocketFD), 2,
            "EINTR must trigger a retry — expected at least 2 write calls")
    }

    /// Partial-write advancement: a short write must NOT drop the unwritten tail.
    /// The `while written < n` loop must call writeFn again with an advanced buffer.
    func testRelay_socketPartialWrite_advancesBuffer() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array(repeating: 0x41, count: 100) // 100 'A's
        mock.enqueueReads(fd: Self.mockStdinFD, .bytes(payload), .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)
        // First call accepts 30 bytes, second call accepts the remaining 70.
        mock.enqueueWrites(fd: Self.mockSocketFD, .partial(30), .full)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF)
        XCTAssertEqual(mock.writtenBytes(Self.mockSocketFD), payload,
            "Partial write must advance — total bytes delivered must equal payload")
        XCTAssertEqual(mock.writeCallCount(Self.mockSocketFD), 2,
            "Partial write must produce exactly 2 write calls (30 + 70)")
    }

    /// Non-EINTR write error on socket → relay reports `.socketError`.
    func testRelay_socketWriteError_returnsSocketError() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array("x".utf8)
        mock.enqueueReads(fd: Self.mockStdinFD, .bytes(payload), .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)
        mock.enqueueWrites(fd: Self.mockSocketFD, .error(errno: EPIPE))

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .socketError,
            "EPIPE on socket write must trigger reconnect path (.socketError)")
    }

    /// Non-EINTR stdin read error → relay treats stdin as done, returns `.stdinEOF`.
    /// Covers the `n < 0 && errno != EINTR` branch in the stdin→socket pump
    /// (BridgeRelay.swift ~line 244).
    func testRelay_stdinReadError_returnsStdinEOF() {
        let mock = MockSyscalls()
        mock.enqueueReads(fd: Self.mockStdinFD, .error(errno: EBADF))
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF,
            "Non-EINTR stdin read error must be treated as client done (.stdinEOF), " +
            "not as a socket failure")
    }

    /// Non-EINTR socket read error must NOT retry. Covers the
    /// `n < 0 && errno != EINTR` branch in the socket→stdout pump
    /// (BridgeRelay.swift ~line 297).
    ///
    /// Determinism note: both threads must `group.leave()` before `relay()`
    /// returns. The stdin thread (default-EOF) always sets
    /// `exitReason = .stdinEOF` under lock before leaving; the socket thread
    /// on a non-EINTR read error does NOT touch `exitReason` (it just
    /// shutdowns and breaks). So the deterministic outcome is `.stdinEOF`,
    /// even though the original cause was a socket failure.
    ///
    /// In production, the surrounding scenario differs — stdin is held open
    /// by the live MCP client — so the socket-error path leaves the
    /// `.socketError` default and triggers the outer reconnect loop. This
    /// test isolates only the no-retry property.
    func testRelay_socketReadError_doesNotRetry() {
        let mock = MockSyscalls()
        mock.enqueueReads(fd: Self.mockSocketFD, .error(errno: ECONNRESET))

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF,
            "Stdin thread sets .stdinEOF under lock before leaving; socket-error " +
            "path does not touch exitReason. See doc-comment for production semantics.")
        XCTAssertEqual(mock.readCallCount(Self.mockSocketFD), 1,
            "Non-EINTR read error must NOT retry — exactly 1 read call expected")
    }

    /// EINTR on socket read must retry rather than aborting the socket→stdout pump.
    func testRelay_socketReadEINTR_retriesUntilEOF() {
        let mock = MockSyscalls()
        mock.enqueueReads(fd: Self.mockStdinFD, .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .error(errno: EINTR), .error(errno: EINTR), .eof)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        // Deterministic: stdin thread sets `.stdinEOF` under lock before leaving;
        // the socket thread on EOF after EINTR retries does not touch exitReason
        // (it just shutdowns and breaks). Both threads must `group.leave()` before
        // `relay()` returns, so the final value is `.stdinEOF`.
        XCTAssertEqual(reason, .stdinEOF)
        XCTAssertEqual(mock.readCallCount(Self.mockSocketFD), 3,
            "Socket read EINTR must retry exactly the queued ops: 2 EINTR + 1 EOF = 3 reads. " +
            "A higher count would indicate over-retry past EOF.")
    }

    /// EINTR on stdout write must retry without losing socket payload.
    func testRelay_stdoutWriteEINTR_retriesAndCompletes() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array("payload".utf8)
        mock.enqueueReads(fd: Self.mockStdinFD, .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .bytes(payload), .eof)
        mock.enqueueWrites(fd: Self.mockStdoutFD, .error(errno: EINTR), .full)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF)
        XCTAssertEqual(mock.writtenBytes(Self.mockStdoutFD), payload,
            "All payload bytes must reach stdout after EINTR retry")
        XCTAssertGreaterThanOrEqual(mock.writeCallCount(Self.mockStdoutFD), 2)
    }

    /// Non-EINTR stdout write error must NOT retry. Covers the
    /// `w < 0 && errno != EINTR` branch in the socket→stdout pump.
    ///
    /// Determinism note: same as `testRelay_socketReadError_doesNotRetry` —
    /// the stdin thread always sets `.stdinEOF` before leaving and the
    /// stdout-write-error path does not touch `exitReason`, so the
    /// deterministic outcome is `.stdinEOF`. In production with stdin held
    /// open the path leaves the `.socketError` default and reconnects.
    func testRelay_stdoutWriteError_doesNotRetry() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array("z".utf8)
        mock.enqueueReads(fd: Self.mockStdinFD, .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .bytes(payload), .eof)
        mock.enqueueWrites(fd: Self.mockStdoutFD, .error(errno: EIO))

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF,
            "Stdin thread sets .stdinEOF under lock before leaving; stdout-write-error " +
            "path does not touch exitReason. See doc-comment for production semantics.")
        XCTAssertEqual(mock.writeCallCount(Self.mockStdoutFD), 1,
            "Non-EINTR stdout write error must NOT retry — exactly 1 write call expected")
    }

    /// Partial-write advancement on stdout side mirrors the socket side.
    func testRelay_stdoutPartialWrite_advancesBuffer() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array(repeating: 0x42, count: 50)
        mock.enqueueReads(fd: Self.mockStdinFD, .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .bytes(payload), .eof)
        mock.enqueueWrites(fd: Self.mockStdoutFD, .partial(10), .partial(20), .full)

        let reason = BridgeRelay.relay(
            stdinFD: Self.mockStdinFD,
            stdoutFD: Self.mockStdoutFD,
            socketFD: Self.mockSocketFD,
            readFn: mock.readFn,
            writeFn: mock.writeFn
        )
        XCTAssertEqual(reason, .stdinEOF)
        XCTAssertEqual(mock.writtenBytes(Self.mockStdoutFD), payload)
        XCTAssertEqual(mock.writeCallCount(Self.mockStdoutFD), 3,
            "10 + 20 + 20 = 50 bytes across 3 write calls")
    }

    /// `w == 0` from a write must `break` the inner loop without infinite-looping.
    /// Documents the existing behavior: a zero-write drops the unsent tail and the
    /// outer loop proceeds to the next read.
    func testRelay_zeroByteWrite_breaksWithoutHang() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array("data".utf8)
        mock.enqueueReads(fd: Self.mockStdinFD, .bytes(payload), .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .eof)
        mock.enqueueWrites(fd: Self.mockSocketFD, .zero)

        let exp = expectation(description: "relay returns")
        var reason: BridgeRelay.RelayExitReason = .socketError
        DispatchQueue.global().async {
            reason = BridgeRelay.relay(
                stdinFD: Self.mockStdinFD,
                stdoutFD: Self.mockStdoutFD,
                socketFD: Self.mockSocketFD,
                readFn: mock.readFn,
                writeFn: mock.writeFn
            )
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        XCTAssertEqual(reason, .stdinEOF,
            "Zero-byte write must not hang — outer loop continues to next read (EOF)")
        XCTAssertEqual(mock.writeCallCount(Self.mockSocketFD), 1,
            "Zero-byte write must break the inner loop (not retry): write(2) returning 0 " +
            "on a blocking fd is undefined — break avoids an infinite loop at the cost of " +
            "dropping the unwritten tail")
    }

    /// Symmetric to `testRelay_zeroByteWrite_breaksWithoutHang` but on the
    /// socket→stdout side: `w == 0` from a stdout write must break, not loop.
    func testRelay_zeroByteStdoutWrite_breaksWithoutHang() {
        let mock = MockSyscalls()
        let payload: [UInt8] = Array("data".utf8)
        mock.enqueueReads(fd: Self.mockStdinFD, .eof)
        mock.enqueueReads(fd: Self.mockSocketFD, .bytes(payload), .eof)
        mock.enqueueWrites(fd: Self.mockStdoutFD, .zero)

        let exp = expectation(description: "relay returns")
        var reason: BridgeRelay.RelayExitReason = .socketError
        DispatchQueue.global().async {
            reason = BridgeRelay.relay(
                stdinFD: Self.mockStdinFD,
                stdoutFD: Self.mockStdoutFD,
                socketFD: Self.mockSocketFD,
                readFn: mock.readFn,
                writeFn: mock.writeFn
            )
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        XCTAssertEqual(reason, .stdinEOF,
            "Zero-byte stdout write must not hang — outer loop continues to next read (EOF)")
        XCTAssertEqual(mock.writeCallCount(Self.mockStdoutFD), 1,
            "Zero-byte stdout write must break the inner loop (not retry): same POSIX-undefined " +
            "trade-off as the socket-side zero-write.")
    }
}
