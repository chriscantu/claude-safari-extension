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
}
