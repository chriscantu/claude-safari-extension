// safari-mcp-bridge/BridgeRelay.swift
import Foundation

/// App Group ID — owned by the bridge target to avoid coupling to the main app's Constants.swift.
/// Must match AppConstants.appGroupId in Shared/Constants.swift.
let bridgeAppGroupId = "group.com.chriscantu.claudeinsafari"

/// Discovers the MCP socket and relays stdin↔socket using newline-delimited JSON.
enum BridgeRelay {

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

    /// Runs the stdio↔socket relay loop. Terminates the process when either side closes.
    static func run() -> Never {
        guard let socketPath = findNewestSocket(in: socketDirectory) else {
            fputs("{\"error\": \"Claude in Safari is not running. Launch the app and try again.\"}\n", stderr)
            exit(1)
        }

        let fd: Int32
        do {
            fd = try connectToSocket(at: socketPath)
        } catch let error as BridgeError {
            switch error {
            case .socketCreationFailed(let code):
                fputs("{\"error\": \"Failed to create socket: \(String(cString: strerror(code)))\"}\n", stderr)
            case .connectionFailed(let code):
                fputs("{\"error\": \"Socket connection failed: \(String(cString: strerror(code))). Restart Claude in Safari.\"}\n", stderr)
            }
            exit(1)
        } catch {
            fputs("{\"error\": \"Unexpected error: \(error.localizedDescription)\"}\n", stderr)
            exit(1)
        }

        // Use raw file descriptors for stdin/stdout to avoid stdio buffering issues.
        // fwrite/fflush to stdout on GCD threads does not reliably flush when stdout
        // is a pipe (as when spawned by Claude Code). Raw write() bypasses this entirely.
        let stdinFD = fileno(stdin)
        let stdoutFD = fileno(stdout)

        let group = DispatchGroup()
        let errorLock = NSLock()
        var hadError = false

        // stdin → socket
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            let bufSize = 65536
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            defer { buf.deallocate() }
            while true {
                let n = Darwin.read(stdinFD, buf, bufSize)
                if n == 0 { break } // EOF — stdin closed normally
                if n < 0 {
                    if errno == EINTR { continue }
                    fputs("Bridge: read from stdin failed: \(String(cString: strerror(errno)))\n", stderr)
                    errorLock.lock()
                    hadError = true
                    errorLock.unlock()
                    break
                }
                var written = 0
                while written < n {
                    let w = Darwin.write(fd, buf.advanced(by: written), n - written)
                    if w < 0 {
                        if errno == EINTR { continue }
                        fputs("Bridge: write to socket failed: \(String(cString: strerror(errno)))\n", stderr)
                        errorLock.lock()
                        hadError = true
                        errorLock.unlock()
                        shutdown(fd, SHUT_WR) // unblock socket→stdout read
                        group.leave()
                        return
                    }
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
                let n = Darwin.read(fd, buf, bufSize)
                if n == 0 { break } // EOF — socket closed normally
                if n < 0 {
                    if errno == EINTR { continue }
                    fputs("Bridge: read from socket failed: \(String(cString: strerror(errno)))\n", stderr)
                    errorLock.lock()
                    hadError = true
                    errorLock.unlock()
                    break
                }
                var written = 0
                while written < n {
                    let w = Darwin.write(stdoutFD, buf.advanced(by: written), n - written)
                    if w < 0 {
                        if errno == EINTR { continue }
                        fputs("Bridge: write to stdout failed: \(String(cString: strerror(errno)))\n", stderr)
                        errorLock.lock()
                        hadError = true
                        errorLock.unlock()
                        group.leave()
                        return
                    }
                    if w == 0 { break }
                    written += w
                }
            }
            group.leave()
        }

        group.wait()
        close(fd)
        errorLock.lock()
        let exitCode: Int32 = hadError ? 1 : 0
        errorLock.unlock()
        exit(exitCode)
    }

    /// Performs a full MCP handshake (initialize + tools/list) and returns the tool count.
    /// Uses a 5-second socket read timeout. Returns nil on any failure. Used by --install --verify.
    static func verifyConnection(socketPath: String) -> Int? {
        guard let fd = try? connectToSocket(at: socketPath) else { return nil }
        defer { close(fd) }

        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        // Shared read buffer — carries leftover bytes across calls in case the server
        // delivers multiple newline-delimited messages in one TCP segment.
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
