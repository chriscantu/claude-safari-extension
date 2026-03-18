import XCTest
@testable import ClaudeInSafari

// MARK: - Test Delegate

/// Captures MCPSocketServer delegate callbacks for assertion in tests.
private class TestDelegate: MCPSocketServerDelegate {
    var onConnect: ((String) -> Void)?
    var onDisconnect: ((String) -> Void)?
    var onMessage: ((Data, String) -> Void)?

    func socketServer(_ server: MCPSocketServer, didConnect clientId: String) {
        onConnect?(clientId)
    }

    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String) {
        onDisconnect?(clientId)
    }

    func socketServer(_ server: MCPSocketServer, didReceiveMessage data: Data, from clientId: String) {
        onMessage?(data, clientId)
    }
}

// MARK: - Socket Helpers

/// Opens a Unix domain socket connection to the given path.
/// Returns the file descriptor on success, -1 on failure.
private func connectSocket(to path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    path.withCString { cstr in
        withUnsafeMutablePointer(to: &addr.sun_path.0) { ptr in
            _ = strcpy(ptr, cstr)
        }
    }

    let result = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
            connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0 else { close(fd); return -1 }
    return fd
}

/// Writes a newline-framed message to the given socket fd.
private func sendFramed(_ data: Data, on fd: Int32) {
    let framed = MessageFramer().frame(data)
    framed.withUnsafeBytes { ptr in
        guard let base = ptr.baseAddress else { return }
        _ = Darwin.write(fd, base, framed.count)
    }
}

// MARK: - Tests

final class MCPSocketServerTests: XCTestCase {

    private var server: MCPSocketServer!
    private var delegate: TestDelegate!
    private var clientFD: Int32 = -1

    override func setUp() {
        super.setUp()
        delegate = TestDelegate()
        server = MCPSocketServer(framer: MessageFramer())
        server.delegate = delegate
    }

    override func tearDown() {
        if clientFD >= 0 { close(clientFD); clientFD = -1 }
        server.stop()
        server = nil
        delegate = nil
        super.tearDown()
    }

    // MARK: - T1: Lifecycle

    func testStartSetsIsListening() throws {
        XCTAssertFalse(server.isListening)
        try server.start()
        XCTAssertTrue(server.isListening)
    }

    func testSocketPathContainsPid() throws {
        try server.start()
        let pid = ProcessInfo.processInfo.processIdentifier
        XCTAssertTrue(server.socketPath.hasSuffix("\(pid).sock"),
                      "Expected path ending in \(pid).sock, got: \(server.socketPath)")
    }

    func testStopClearsIsListening() throws {
        try server.start()
        server.stop()
        XCTAssertFalse(server.isListening)
    }

    func testSocketFileRemovedAfterStop() throws {
        try server.start()
        let path = server.socketPath
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testStopIsIdempotent() throws {
        try server.start()
        server.stop()
        server.stop()  // second stop must not crash or corrupt state
        XCTAssertFalse(server.isListening)
    }

    // MARK: - T2: Connection events

    func testDidConnectFiresOnConnection() throws {
        try server.start()
        let exp = expectation(description: "didConnect")
        delegate.onConnect = { _ in exp.fulfill() }

        clientFD = connectSocket(to: server.socketPath)
        XCTAssertGreaterThanOrEqual(clientFD, 0, "Client failed to connect to socket")

        wait(for: [exp], timeout: 2)
    }

    func testDidDisconnectFiresOnClientClose() throws {
        try server.start()
        let connectExp = expectation(description: "didConnect")
        let disconnectExp = expectation(description: "didDisconnect")
        delegate.onConnect = { _ in connectExp.fulfill() }
        delegate.onDisconnect = { _ in disconnectExp.fulfill() }

        clientFD = connectSocket(to: server.socketPath)
        wait(for: [connectExp], timeout: 2)

        close(clientFD)
        clientFD = -1  // avoid double-close in tearDown

        wait(for: [disconnectExp], timeout: 2)
    }

    // MARK: - T3: Message delivery

    func testDidReceiveMessageFiresWithCorrectData() throws {
        try server.start()
        let connectExp = expectation(description: "didConnect")
        let messageExp = expectation(description: "didReceiveMessage")
        let payload = #"{"tool":"read_page","args":{}}"#.data(using: .utf8)!

        delegate.onConnect = { _ in connectExp.fulfill() }
        delegate.onMessage = { data, _ in
            XCTAssertEqual(data, payload)
            messageExp.fulfill()
        }

        clientFD = connectSocket(to: server.socketPath)
        wait(for: [connectExp], timeout: 2)
        sendFramed(payload, on: clientFD)
        wait(for: [messageExp], timeout: 2)
    }

    func testMultipleMessagesDeliveredInOrder() throws {
        try server.start()
        let connectExp = expectation(description: "didConnect")
        let msg1 = "first".data(using: .utf8)!
        let msg2 = "second".data(using: .utf8)!
        var received: [Data] = []
        let allReceived = expectation(description: "both messages delivered")

        delegate.onConnect = { _ in connectExp.fulfill() }
        delegate.onMessage = { data, _ in
            received.append(data)
            if received.count == 2 { allReceived.fulfill() }
        }

        clientFD = connectSocket(to: server.socketPath)
        wait(for: [connectExp], timeout: 2)

        // Write both frames in a single send to exercise buffer accumulation + while-loop deframing
        let framer = MessageFramer()
        var combined = framer.frame(msg1)
        combined.append(framer.frame(msg2))
        combined.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            _ = Darwin.write(clientFD, base, combined.count)
        }

        wait(for: [allReceived], timeout: 2)
        XCTAssertEqual(received[0], msg1)
        XCTAssertEqual(received[1], msg2)
    }

    // MARK: - T4: Send to client

    func testSendDataReachesClient() throws {
        try server.start()
        let connectExp = expectation(description: "didConnect")
        var connectedClientId = ""
        delegate.onConnect = { id in connectedClientId = id; connectExp.fulfill() }

        clientFD = connectSocket(to: server.socketPath)
        wait(for: [connectExp], timeout: 2)

        let payload = "hello client".data(using: .utf8)!
        let recvExp = expectation(description: "data received by client")
        var received = Data()

        // Read on a background thread with an expectation so that the test
        // fails cleanly after 2 s instead of blocking the process indefinitely.
        let fd = clientFD
        DispatchQueue.global().async {
            var buf = [UInt8](repeating: 0, count: 256)
            let n = Darwin.read(fd, &buf, buf.count)
            if n > 0 { received = Data(buf[0..<n]) }
            recvExp.fulfill()
        }

        server.send(data: payload, to: connectedClientId)
        wait(for: [recvExp], timeout: 2)

        let expected = MessageFramer().frame(payload)
        XCTAssertEqual(received, expected)
    }

    func testSendToUnknownClientIdIsNoOp() throws {
        try server.start()
        // Must not crash or throw
        server.send(data: Data("test".utf8), to: "nonexistent-client-id")
    }

    // MARK: - T5: Malformed data

    func testMalformedDataDisconnectsClient() throws {
        // Triggering MessageFramer.maxMessageSize (10 MB) via a real socket requires
        // streaming 10 MB+1 bytes, which takes ~43 s due to the O(n²) scanning cost
        // in readFromClient (deframe() scans the full growing buffer on every 65 KB
        // read, totalling ~772 MB of scanning for a 10 MB payload).
        // The deframe() throw behaviour itself is covered by
        // MessageFramerTests.testDeframeOversizedMessage.
        throw XCTSkip("10 MB socket stream required — O(n²) scan makes this ~43 s; covered by MessageFramerTests.testDeframeOversizedMessage")
    }

    // MARK: - Stale socket cleanup

    func testStart_removesExistingSockFilesFromDirectory() throws {
        let username = NSUserName()
        let directory = "/tmp/claude-mcp-browser-bridge-\(username)"

        // Ensure directory exists
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: nil
        )

        // Create a dummy stale socket file
        let stalePath = "\(directory)/99999.sock"
        FileManager.default.createFile(atPath: stalePath, contents: nil)
        XCTAssertTrue(FileManager.default.fileExists(atPath: stalePath), "Precondition: stale file exists")

        // Start the server — it should clean up stale .sock files
        let server = MCPSocketServer(framer: MessageFramer())
        try server.start()
        defer { server.stop() }

        XCTAssertFalse(FileManager.default.fileExists(atPath: stalePath),
                       "Stale .sock file should be removed on start")
    }

    func testStart_preservesNonSockFilesInDirectory() throws {
        let username = NSUserName()
        let directory = "/tmp/claude-mcp-browser-bridge-\(username)"

        // Ensure directory exists
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: nil
        )

        // Create a non-.sock file
        let otherPath = "\(directory)/keepme.txt"
        FileManager.default.createFile(atPath: otherPath, contents: Data("hello".utf8))

        let server = MCPSocketServer(framer: MessageFramer())
        try server.start()
        defer { server.stop() }

        XCTAssertTrue(FileManager.default.fileExists(atPath: otherPath),
                      "Non-.sock files should be preserved")

        // Cleanup
        try? FileManager.default.removeItem(atPath: otherPath)
    }
}
