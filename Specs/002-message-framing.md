# Spec 002: Message Framing

## Overview
A stateless utility for encoding and decoding length-prefixed messages on the wire. Used by both the MCP socket server (Spec 001) and the native extension bridge (Spec 003).

## Wire Protocol
```
[4 bytes: message length (big-endian UInt32)] [N bytes: UTF-8 JSON payload]
```

This matches the Chrome native messaging host protocol used by `chrome-native-host`.

## Interface

```swift
struct MessageFramer {
    /// Encode a message for transmission: prepend 4-byte big-endian length prefix.
    static func frame(_ data: Data) -> Data

    /// Attempt to extract a complete message from a buffer.
    /// Returns the message data and advances the buffer past it.
    /// Returns nil if the buffer doesn't contain a complete message yet.
    static func deframe(_ buffer: inout Data) -> Data?
}
```

## Behavior

### `frame(_ data: Data) -> Data`
1. Take the byte count of `data` as a `UInt32`
2. Convert to big-endian byte order
3. Prepend those 4 bytes to `data`
4. Return the combined result

### `deframe(_ buffer: inout Data) -> Data?`
1. If `buffer.count < 4`, return `nil` (need more data)
2. Read first 4 bytes as big-endian `UInt32` → this is `messageLength`
3. If `messageLength > 10_000_000` (10 MB), throw/return error (protection against corrupt frames)
4. If `buffer.count < 4 + messageLength`, return `nil` (need more data)
5. Extract bytes `[4..<4+messageLength]` as the message
6. Remove bytes `[0..<4+messageLength]` from buffer (mutate in place)
7. Return the extracted message

## Constraints
- Maximum message size: 10 MB (safety limit)
- Framing is stateless — no session or sequence tracking
- Must handle being called repeatedly on a growing buffer (streaming reads)

## Test Cases

| Test | Input | Expected Output |
|------|-------|-----------------|
| Frame empty data | `Data()` | 4 zero bytes `[0x00, 0x00, 0x00, 0x00]` |
| Frame small message | `"hello"` (5 bytes) | `[0x00, 0x00, 0x00, 0x05]` + `"hello"` |
| Frame large message | 1000 bytes of `0xFF` | `[0x00, 0x00, 0x03, 0xE8]` + 1000 bytes |
| Deframe complete message | `[0x00, 0x00, 0x00, 0x05]` + `"hello"` | Returns `"hello"`, buffer now empty |
| Deframe incomplete header | 3 bytes only | Returns `nil`, buffer unchanged |
| Deframe incomplete body | Header says 10 bytes, only 5 present | Returns `nil`, buffer unchanged |
| Deframe multiple messages | Two framed messages concatenated | First call returns msg1, second returns msg2 |
| Deframe oversized message | Length prefix > 10 MB | Returns error/nil, doesn't allocate |
| Round-trip | frame → deframe | Original data recovered exactly |
| Endianness | Length 256 (`0x100`) | Bytes: `[0x00, 0x00, 0x01, 0x00]` |
