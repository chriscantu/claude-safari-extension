// safari-mcp-bridge/BridgeRelay.swift
import Foundation

/// App Group ID — owned by the bridge target to avoid coupling to the main app's Constants.swift.
/// Must match AppConstants.appGroupId in Shared/Constants.swift.
let bridgeAppGroupId = "group.com.chriscantu.claudeinsafari"

/// Discovers the MCP socket and relays stdin↔socket using newline-delimited JSON.
enum BridgeRelay {

    /// Reason the relay loop exited.
    enum RelayExitReason {
        case stdinEOF
        case socketError
    }

    /// Session metrics — written by run(), read by StatusReporter.
    static var bridgeSessionStart: Date?
    static var bridgeReconnectCount: Int = 0

    /// App Group container socket directory path.
    /// Uses a hardcoded path pattern rather than FileManager.containerURL(forSecurityApplicationGroupIdentifier:)
    /// because that API returns nil without the app group entitlement. The bridge binary intentionally
    /// has no entitlements (it runs unsandboxed as a subprocess of Claude Code/Desktop).
    static let socketDirectory: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Group Containers/\(bridgeAppGroupId)/sockets"
    }()

    /// Finds the newest *.sock file in the given directory by modification time.
    static func findNewestSocket(in directory: String) -> String? {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: directory) else { return nil }
        let socks = entries.filter { $0.hasSuffix(".sock") }
        guard !socks.isEmpty else { return nil }
        return socks
            .map { (directory as NSString).appendingPathComponent($0) }
            .max { path1, path2 in
                let m1 = (try? fm.attributesOfItem(atPath: path1)[.modificationDate] as? Date) ?? .distantPast
                let m2 = (try? fm.attributesOfItem(atPath: path2)[.modificationDate] as? Date) ?? .distantPast
                return m1 < m2
            }
    }

    /// Connects to the Unix domain socket at the given path.
    static func connectToSocket(at path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw BridgeError.socketCreationFailed(errno) }

        let maxPathLen = MemoryLayout.size(ofValue: sockaddr_un().sun_path) // 104 on macOS
        guard path.utf8.count < maxPathLen else {
            close(fd)
            throw BridgeError.connectionFailed(ENAMETOOLONG)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        path.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { ptr in
                _ = strlcpy(ptr, cstr, maxPathLen)
            }
        }

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { close(fd); throw BridgeError.connectionFailed(errno) }
        return fd
    }

    /// Maximum time (milliseconds) to wait for a connectable socket.
    /// Covers the case where an MCP client launches the bridge before
    /// the Claude in Safari app has finished starting, or when a stale
    /// socket file exists from a previous session.
    static let socketWaitTimeoutMs: UInt64 = 30_000
    static let backoffBaseUs: UInt64 = 100_000  // 100ms in microseconds
    static let backoffMaxUs: UInt64 = 2_000_000 // 2s in microseconds

    /// Returns the exponential backoff delay in microseconds for the given attempt number.
    /// Doubles from backoffBaseUs up to backoffMaxUs. Attempt 0 → 100ms, 1 → 200ms, ..., 5+ → 2s.
    static func backoffDelay(attempt: Int) -> UInt64 {
        min(backoffBaseUs * (1 << UInt64(min(attempt, 20))), backoffMaxUs)
    }

    /// Discovers and connects to the MCP socket with exponential backoff.
    /// Blocks until a connectable socket is found or socketWaitTimeoutMs elapses.
    /// Logs the connection time on success.
    /// Returns the connected file descriptor, or -1 on timeout/failure.
    static func discoverSocket(logPrefix: String = "bridge") -> Int32 {
        var waited = false
        var attempt = 0
        let startUs = clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000 // ns → µs
        let timeoutUs = socketWaitTimeoutMs * 1_000                   // ms → µs

        while true {
            if let path = findNewestSocket(in: socketDirectory) {
                do {
                    let fd = try connectToSocket(at: path)
                    let nowUs = clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000
                    let elapsedMs = (nowUs - startUs) / 1_000
                    fputs("\(logPrefix): connected in \(elapsedMs)ms (attempt \(attempt))\n", stderr)
                    return fd
                } catch let error as BridgeError {
                    if case .socketCreationFailed(let code) = error {
                        // Non-transient local error (e.g. EMFILE) — fast-fail
                        fputs("{\"error\": \"Failed to create socket: \(String(cString: strerror(code)))\"}\n", stderr)
                        exit(1)
                    }
                    // connectionFailed — stale socket or app still starting, retry
                } catch {
                    // Unexpected error — retry
                }
            }

            // First failure — print waiting message
            if !waited {
                fputs("Waiting for Claude in Safari to start...\n", stderr)
                waited = true
            }

            let nowUs = clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000
            if nowUs - startUs >= timeoutUs {
                break
            }

            usleep(UInt32(min(backoffDelay(attempt: attempt), UInt64(UInt32.max))))
            attempt += 1
        }

        return -1
    }

    /// Perform MCP initialize + notifications/initialized handshake on the given fd.
    /// Returns true on success. Does NOT perform tools/list (unlike verifyConnection).
    static func performHandshake(fd: Int32) -> Bool {
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        if setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size)) != 0 {
            fputs("bridge: handshake failed — could not set read timeout: \(String(cString: strerror(errno)))\n", stderr)
            return false
        }

        var leftover = Data()

        func sendLine(_ json: String) -> Bool {
            let data = (json + "\n").data(using: .utf8)!
            return data.withUnsafeBytes { ptr -> Bool in
                guard let base = ptr.baseAddress else { return false }
                let w = Darwin.write(fd, base, data.count)
                return w == data.count
            }
        }

        func parseJSON(_ msgData: Data) -> [String: Any]? {
            do {
                return try JSONSerialization.jsonObject(with: msgData) as? [String: Any]
            } catch {
                let raw = String(data: msgData, encoding: .utf8) ?? "<non-UTF8, \(msgData.count) bytes>"
                fputs("bridge: handshake failed — invalid JSON from server: \(raw)\n", stderr)
                return nil
            }
        }

        func readNextLine() -> [String: Any]? {
            if let idx = leftover.firstIndex(of: 0x0A) {
                let msgData = leftover[leftover.startIndex..<idx]
                leftover = Data(leftover[(idx + 1)...])
                return parseJSON(msgData)
            }
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 65536)
            defer { buf.deallocate() }
            while true {
                let n = Darwin.read(fd, buf, 65536)
                if n <= 0 { return nil }
                leftover.append(buf, count: n)
                if let idx = leftover.firstIndex(of: 0x0A) {
                    let msgData = leftover[leftover.startIndex..<idx]
                    leftover = Data(leftover[(idx + 1)...])
                    return parseJSON(msgData)
                }
            }
        }

        guard sendLine("{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"safari-mcp-bridge\",\"version\":\"1.0.0\"}}}") else {
            fputs("bridge: handshake failed — could not send initialize request\n", stderr)
            return false
        }
        guard readNextLine() != nil else {
            fputs("bridge: handshake failed — no response to initialize (timeout or socket closed)\n", stderr)
            return false
        }

        guard sendLine("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}") else {
            fputs("bridge: handshake failed — could not send initialized notification\n", stderr)
            return false
        }
        // No sleep needed here — unlike verifyConnection (which sends tools/list next),
        // the relay just forwards whatever the MCP client sends. The server processes
        // notifications/initialized asynchronously; the first real request from the
        // client serves as the implicit readiness signal.

        // Remove read timeout for relay phase
        tv = timeval(tv_sec: 0, tv_usec: 0)
        if setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size)) != 0 {
            fputs("bridge: warning — could not clear read timeout: \(String(cString: strerror(errno)))\n", stderr)
        }

        fputs("bridge: session initialized\n", stderr)
        return true
    }

    /// Read syscall closure: matches `Darwin.read(_:_:_:)` shape. Mock by setting
    /// thread-local `errno` before returning -1.
    typealias ReadFn = (Int32, UnsafeMutableRawPointer, Int) -> Int

    /// Write syscall closure: matches `Darwin.write(_:_:_:)` shape. Mock by setting
    /// thread-local `errno` before returning -1.
    typealias WriteFn = (Int32, UnsafeRawPointer, Int) -> Int

    /// Run the stdin↔socket relay. Returns the reason it stopped.
    /// `readFn`/`writeFn` are injectable for testing the EINTR-retry and
    /// partial-write paths; defaults call the real syscalls.
    static func relay(
        stdinFD: Int32,
        stdoutFD: Int32,
        socketFD fd: Int32,
        readFn: @escaping ReadFn = { Darwin.read($0, $1, $2) },
        writeFn: @escaping WriteFn = { Darwin.write($0, $1, $2) }
    ) -> RelayExitReason {
        let group = DispatchGroup()
        let lock = NSLock()
        var exitReason: RelayExitReason = .socketError // default if socket side dies

        // stdin → socket
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            let bufSize = 65536
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            defer { buf.deallocate() }
            while true {
                let n = readFn(stdinFD, buf, bufSize)
                if n == 0 {
                    // EOF — stdin closed normally
                    lock.lock()
                    exitReason = .stdinEOF
                    lock.unlock()
                    break
                }
                if n < 0 {
                    if errno == EINTR { continue }
                    fputs("Bridge: read from stdin failed: \(String(cString: strerror(errno)))\n", stderr)
                    lock.lock()
                    exitReason = .stdinEOF // treat stdin error as client done
                    lock.unlock()
                    break
                }
                var written = 0
                while written < n {
                    let w = writeFn(fd, buf.advanced(by: written), n - written)
                    if w < 0 {
                        if errno == EINTR { continue }
                        fputs("Bridge: write to socket failed: \(String(cString: strerror(errno)))\n", stderr)
                        lock.lock()
                        exitReason = .socketError
                        lock.unlock()
                        shutdown(fd, SHUT_WR) // unblock socket→stdout read
                        group.leave()
                        return
                    }
                    // write(2) returning 0 on a blocking fd is undefined per POSIX; break
                    // (rather than continue) to avoid an infinite loop. The unwritten tail
                    // is dropped — acceptable because this path is unreachable in practice.
                    if w == 0 { break }
                    written += w
                }
            }
            shutdown(fd, SHUT_WR)
            group.leave()
        }

        // socket → stdout
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            let bufSize = 65536
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            defer { buf.deallocate() }
            while true {
                let n = readFn(fd, buf, bufSize)
                if n == 0 {
                    // Socket closed — shutdown socket writes so the stdin→socket thread's
                    // next write(fd, ...) fails immediately with EPIPE instead of buffering.
                    // Note: the stdin→socket thread may still be blocked on read(stdinFD) —
                    // it will unblock when the MCP client sends its next request, at which
                    // point the write fails and the thread exits. This is by design: the
                    // reconnect happens on the next MCP request, not instantly.
                    shutdown(fd, SHUT_RDWR)
                    break
                }
                if n < 0 {
                    if errno == EINTR { continue }
                    fputs("Bridge: read from socket failed: \(String(cString: strerror(errno)))\n", stderr)
                    shutdown(fd, SHUT_RDWR)
                    break
                }
                var written = 0
                while written < n {
                    let w = writeFn(stdoutFD, buf.advanced(by: written), n - written)
                    if w < 0 {
                        if errno == EINTR { continue }
                        fputs("Bridge: write to stdout failed: \(String(cString: strerror(errno)))\n", stderr)
                        shutdown(fd, SHUT_RDWR)
                        group.leave()
                        return
                    }
                    // write(2) returning 0 on a blocking fd is undefined per POSIX; break
                    // (rather than continue) to avoid an infinite loop. The unwritten tail
                    // is dropped — acceptable because this path is unreachable in practice.
                    if w == 0 { break }
                    written += w
                }
            }
            group.leave()
        }

        group.wait()
        return exitReason
    }

    /// Runs the stdio↔socket relay loop with auto-reconnect on socket errors.
    /// Terminates the process on stdin EOF or unrecoverable failure.
    static func run() -> Never {
        // Wait for a connectable socket, retrying both discovery and connection.
        // MCP clients (Claude Code, Claude Desktop) may launch the bridge before
        // the app is fully running, or a stale socket file may exist from a crash.
        var fd = discoverSocket()

        guard fd >= 0 else {
            fputs("{\"error\": \"Claude in Safari is not running after waiting up to \(socketWaitTimeoutMs / 1000)s. Launch the app and try again.\"}\n", stderr)
            exit(1)
        }

        // Initial MCP handshake
        if !performHandshake(fd: fd) {
            fputs("{\"error\": \"MCP handshake failed after initial connection.\"}\n", stderr)
            close(fd)
            exit(1)
        }

        BridgeRelay.bridgeSessionStart = Date()

        // Use raw file descriptors for stdin/stdout to avoid stdio buffering issues.
        // fwrite/fflush to stdout on GCD threads does not reliably flush when stdout
        // is a pipe (as when spawned by Claude Code). Raw write() bypasses this entirely.
        let stdinFD = fileno(stdin)
        let stdoutFD = fileno(stdout)

        // Outer reconnect loop
        while true {
            let exitReason = relay(stdinFD: stdinFD, stdoutFD: stdoutFD, socketFD: fd)

            switch exitReason {
            case .stdinEOF:
                close(fd)
                exit(0)

            case .socketError:
                close(fd)
                fputs("bridge: connection lost, reconnecting...\n", stderr)
                BridgeRelay.bridgeReconnectCount += 1

                fd = discoverSocket(logPrefix: "bridge")
                guard fd >= 0 else {
                    fputs("bridge: reconnect failed after \(socketWaitTimeoutMs / 1000)s, exiting\n", stderr)
                    exit(1)
                }

                guard performHandshake(fd: fd) else {
                    fputs("bridge: MCP re-initialization failed after reconnect, exiting\n", stderr)
                    close(fd)
                    exit(1)
                }

                fputs("bridge: reconnected and session re-initialized\n", stderr)
            }
        }
    }

    /// Performs a full MCP handshake (initialize + tools/list) and returns the tool count.
    /// Uses a 5-second socket read timeout. Returns nil on any failure. Used by --install --verify.
    static func verifyConnection(socketPath: String) -> Int? {
        guard let fd = try? connectToSocket(at: socketPath) else { return nil }
        defer { close(fd) }

        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        // Shared read buffer — carries leftover bytes across calls in case the server
        // delivers multiple newline-delimited messages in a single read.
        var leftover = Data()

        func sendLine(_ json: String) -> Bool {
            let data = (json + "\n").data(using: .utf8)!
            return data.withUnsafeBytes { ptr -> Bool in
                guard let base = ptr.baseAddress else { return false }
                let w = Darwin.write(fd, base, data.count)
                return w == data.count
            }
        }

        func readNextLine() -> [String: Any]? {
            // Check leftover first
            if let idx = leftover.firstIndex(of: 0x0A) {
                let msgData = leftover[leftover.startIndex..<idx]
                leftover = Data(leftover[(idx + 1)...])
                return try? JSONSerialization.jsonObject(with: msgData) as? [String: Any]
            }

            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 65536)
            defer { buf.deallocate() }
            while true {
                let n = Darwin.read(fd, buf, 65536)
                if n <= 0 { return nil }
                leftover.append(buf, count: n)
                if let idx = leftover.firstIndex(of: 0x0A) {
                    let msgData = leftover[leftover.startIndex..<idx]
                    leftover = Data(leftover[(idx + 1)...])
                    return try? JSONSerialization.jsonObject(with: msgData) as? [String: Any]
                }
            }
        }

        guard sendLine("{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"safari-mcp-bridge\",\"version\":\"1.0.0\"}}}") else { return nil }
        guard readNextLine() != nil else { return nil }

        guard sendLine("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}") else { return nil }
        usleep(50_000)

        guard sendLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}") else { return nil }
        guard let response = readNextLine(),
              let result = response["result"] as? [String: Any],
              let tools = result["tools"] as? [[String: Any]] else { return nil }

        return tools.count
    }
}

enum BridgeError: Error {
    case socketCreationFailed(Int32)
    case connectionFailed(Int32)
}
