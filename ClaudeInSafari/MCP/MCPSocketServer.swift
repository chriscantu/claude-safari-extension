import Foundation

/// Delegate protocol for MCP socket server events.
protocol MCPSocketServerDelegate: AnyObject {
    func socketServer(_ server: MCPSocketServer, didReceiveMessage data: Data, from clientId: String)
    func socketServer(_ server: MCPSocketServer, didConnect clientId: String)
    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String)
}

/// A Unix domain socket server that accepts MCP client connections.
/// See Spec 001 for full specification.
class MCPSocketServer {
    weak var delegate: MCPSocketServerDelegate?

    private static let readBufferSize = 65_536

    private let framer: MessageFramer
    private let delegateQueue = DispatchQueue(label: "com.chriscantu.claudeinsafari.mcpserver.delegate")
    private let ioQueue = DispatchQueue(label: "com.chriscantu.claudeinsafari.mcpserver.io", attributes: .concurrent)

    private var serverFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var clients: [String: ClientConnection] = [:]
    private let clientsLock = NSLock()

    private(set) var socketPath: String = ""
    private(set) var isListening: Bool = false

    init(framer: MessageFramer) {
        self.framer = framer
    }

    deinit {
        stop()
    }

    /// Start listening on a Unix domain socket.
    func start() throws {
        let username = NSUserName()
        let directory = "/tmp/claude-mcp-browser-bridge-\(username)"
        let pid = ProcessInfo.processInfo.processIdentifier
        socketPath = "\(directory)/\(pid).sock"

        // Create directory with 0700 permissions
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        // Remove any stale socket files from previous processes
        if let contents = try? FileManager.default.contentsOfDirectory(atPath: directory) {
            for file in contents where file.hasSuffix(".sock") {
                try? FileManager.default.removeItem(atPath: "\(directory)/\(file)")
            }
        }

        // Create socket
        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            throw MCPSocketServerError.socketCreationFailed(errno)
        }

        // Bind
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { ptr in
                strcpy(ptr, cstr)
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            close(serverFD)
            throw MCPSocketServerError.bindFailed(errno)
        }

        // Listen
        guard listen(serverFD, 5) == 0 else {
            close(serverFD)
            throw MCPSocketServerError.listenFailed(errno)
        }

        // Accept connections via GCD
        acceptSource = DispatchSource.makeReadSource(fileDescriptor: serverFD, queue: ioQueue)
        acceptSource?.setEventHandler { [weak self] in
            self?.acceptConnection()
        }
        acceptSource?.setCancelHandler { [weak self] in
            if let fd = self?.serverFD, fd >= 0 {
                close(fd)
            }
        }
        acceptSource?.resume()

        isListening = true
    }

    /// Stop the server and clean up.
    func stop() {
        guard isListening else { return }
        isListening = false

        acceptSource?.cancel()
        acceptSource = nil

        clientsLock.lock()
        let allClients = clients
        clients.removeAll()
        clientsLock.unlock()

        for (_, client) in allClients {
            client.readSource?.cancel()
            close(client.fd)
        }

        if serverFD >= 0 {
            close(serverFD)
            serverFD = -1
        }

        unlink(socketPath)
    }

    /// Send framed data to a specific client.
    /// Loops until all bytes are written or the connection is closed (handles partial writes).
    /// Disconnects the client if a write error occurs to avoid framing corruption.
    func send(data: Data, to clientId: String) {
        clientsLock.lock()
        let client = clients[clientId]
        clientsLock.unlock()

        guard let client = client else { return }

        let framed = framer.frame(data)
        let writeError = framed.withUnsafeBytes { ptr -> Bool in
            guard var base = ptr.baseAddress else { return false }
            var remaining = framed.count
            while remaining > 0 {
                let written = Darwin.write(client.fd, base, remaining)
                if written <= 0 { return true }  // connection closed or error
                remaining -= written
                base = base.advanced(by: written)
            }
            return false
        }

        if writeError {
            NSLog("MCPSocketServer: write error for client \(clientId), disconnecting")
            // Remove from clients dict first so no subsequent send() call can obtain a reference
            // to this client before the readSource cancel handler fires.
            clientsLock.lock()
            clients.removeValue(forKey: clientId)
            let shouldNotifyWrite = !client.disconnectNotified
            if shouldNotifyWrite { client.disconnectNotified = true }
            clientsLock.unlock()
            client.readSource?.cancel()
            if shouldNotifyWrite {
                delegateQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.delegate?.socketServer(self, didDisconnect: clientId)
                }
            }
        }
    }

    // MARK: - Private

    private func acceptConnection() {
        var clientAddr = sockaddr_un()
        var clientAddrLen = socklen_t(MemoryLayout<sockaddr_un>.size)

        let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                accept(serverFD, sockPtr, &clientAddrLen)
            }
        }

        guard clientFD >= 0 else { return }

        let clientId = UUID().uuidString
        let connection = ClientConnection(fd: clientFD, buffer: Data())

        // Set up read source for this client
        let readSource = DispatchSource.makeReadSource(fileDescriptor: clientFD, queue: ioQueue)
        connection.readSource = readSource

        clientsLock.lock()
        clients[clientId] = connection
        clientsLock.unlock()

        readSource.setEventHandler { [weak self] in
            self?.readFromClient(clientId: clientId)
        }
        readSource.setCancelHandler { [weak self] in
            close(clientFD)
            self?.clientsLock.lock()
            self?.clients.removeValue(forKey: clientId)
            self?.clientsLock.unlock()
        }
        readSource.resume()

        delegateQueue.async { [weak self] in
            guard let self = self else { return }
            self.delegate?.socketServer(self, didConnect: clientId)
        }
    }

    private func readFromClient(clientId: String) {
        clientsLock.lock()
        guard let client = clients[clientId] else {
            clientsLock.unlock()
            return
        }
        clientsLock.unlock()

        var buf = [UInt8](repeating: 0, count: MCPSocketServer.readBufferSize)
        let bytesRead = read(client.fd, &buf, buf.count)

        if bytesRead <= 0 {
            // Client disconnected or error
            client.readSource?.cancel()
            clientsLock.lock()
            let shouldNotifyRead = !client.disconnectNotified
            if shouldNotifyRead { client.disconnectNotified = true }
            clientsLock.unlock()
            if shouldNotifyRead {
                delegateQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.delegate?.socketServer(self, didDisconnect: clientId)
                }
            }
            return
        }

        client.buffer.append(contentsOf: buf[0..<bytesRead])

        // Try to deframe complete messages
        do {
            while let message = try framer.deframe(&client.buffer) {
                let msg = message
                delegateQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.delegate?.socketServer(self, didReceiveMessage: msg, from: clientId)
                }
            }
        } catch {
            // Malformed data — disconnect client
            NSLog("Malformed data from client \(clientId): \(error)")
            client.readSource?.cancel()
            clientsLock.lock()
            let shouldNotifyMalformed = !client.disconnectNotified
            if shouldNotifyMalformed { client.disconnectNotified = true }
            clientsLock.unlock()
            if shouldNotifyMalformed {
                delegateQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.delegate?.socketServer(self, didDisconnect: clientId)
                }
            }
        }
    }
}

/// Internal representation of a connected client.
class ClientConnection {
    let fd: Int32
    var buffer: Data
    var readSource: DispatchSourceRead?
    var disconnectNotified = false

    init(fd: Int32, buffer: Data) {
        self.fd = fd
        self.buffer = buffer
    }
}

enum MCPSocketServerError: Error {
    case socketCreationFailed(Int32)
    case bindFailed(Int32)
    case listenFailed(Int32)
}
