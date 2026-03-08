# Spec 001: MCP Socket Server

## Overview
A Unix domain socket server that accepts connections from Claude Code CLI. This is the entry point for all MCP communication — it replaces Chrome's Rust `chrome-native-host` binary.

## Responsibilities
- Create a Unix domain socket at `/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock`
- Accept multiple concurrent client connections
- Read length-prefixed messages from clients (see Spec 002)
- Route messages to the ToolRouter (see Spec 003)
- Write length-prefixed responses back to clients
- Clean up socket file on shutdown

## Interface

```swift
protocol MCPSocketServerDelegate: AnyObject {
    func socketServer(_ server: MCPSocketServer, didReceiveMessage message: Data, from clientId: String)
    func socketServer(_ server: MCPSocketServer, didConnect clientId: String)
    func socketServer(_ server: MCPSocketServer, didDisconnect clientId: String)
}

class MCPSocketServer {
    weak var delegate: MCPSocketServerDelegate?

    /// Start listening. Creates socket directory and file.
    func start() throws

    /// Stop listening. Closes all connections, removes socket file.
    func stop()

    /// Send a response to a specific client.
    func send(data: Data, to clientId: String)

    /// The path to the active socket file.
    var socketPath: String { get }

    /// Whether the server is currently listening.
    var isListening: Bool { get }
}
```

## Socket Path
- Directory: `/tmp/claude-mcp-browser-bridge-<username>/`
- File: `<pid>.sock`
- Directory permissions: `0700` (owner only)
- Must remove stale socket files on startup

## Connection Lifecycle
1. Server creates socket, binds, listens (backlog: 5)
2. Client connects → server generates a UUID `clientId`
3. Delegate receives `didConnect` callback
4. Server reads messages using MessageFramer (Spec 002)
5. Each complete message triggers `didReceiveMessage` callback
6. Server can send responses via `send(data:to:)`
7. On client disconnect → delegate receives `didDisconnect`
8. On server `stop()` → all connections closed, socket file removed

## Implementation Notes
- Use GCD (`DispatchSource`) for async I/O on POSIX sockets
- `NWListener` does NOT support Unix domain sockets — must use raw POSIX: `socket()`, `bind()`, `listen()`, `accept()`
- Each client connection gets its own `DispatchSource` for reading
- Must handle partial reads (message may arrive across multiple read calls)
- Thread-safe: delegate callbacks on a dedicated serial queue

## Edge Cases
- Socket file already exists at startup → `unlink()` it first
- Client sends malformed data → close that connection, don't crash server
- Client disconnects mid-message → clean up partial buffer
- Multiple clients connected simultaneously → each gets independent state
- Server `stop()` called while messages are in-flight → drain gracefully

## Message Format
See Spec 002 (Message Framing) for the wire protocol.

## Test Cases

| Test | Input | Expected Output |
|------|-------|-----------------|
| Server starts and creates socket | `start()` | Socket file exists at expected path |
| Client connects | TCP connect to socket | `didConnect` called with clientId |
| Client sends message | Valid framed message | `didReceiveMessage` called with decoded data |
| Server sends response | `send(data:to:)` | Client receives framed response |
| Client disconnects | Close connection | `didDisconnect` called |
| Server stops | `stop()` | Socket file removed, `isListening` is false |
| Stale socket cleanup | Pre-existing socket file | File unlinked, server starts successfully |
| Concurrent clients | 2 clients connect | Both get unique clientIds, messages routed independently |
| Malformed data | Random bytes, no valid frame | Connection closed gracefully, server stays up |
