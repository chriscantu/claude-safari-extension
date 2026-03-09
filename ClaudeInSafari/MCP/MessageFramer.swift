import Foundation

/// Encodes and decodes newline-delimited JSON messages per the MCP stdio transport spec.
///
/// Wire format: [N bytes: UTF-8 JSON payload] [1 byte: 0x0A newline]
/// This matches the MCP stdio transport used by Claude Code CLI.
struct MessageFramer {
    /// Maximum allowed message size (10 MB) to protect against corrupt frames.
    static let maxMessageSize: Int = 10_000_000

    /// Encode a message for transmission by appending a newline delimiter.
    func frame(_ data: Data) -> Data {
        var framed = data
        framed.append(0x0A) // \n
        return framed
    }

    /// Attempt to extract a complete message from a buffer.
    ///
    /// On success, removes the consumed bytes (including the newline) from the buffer
    /// and returns the message payload without the newline.
    /// Returns `nil` if the buffer doesn't contain a complete message yet.
    /// Throws `MessageFramerError.messageTooLarge` if the message exceeds `maxMessageSize`.
    func deframe(_ buffer: inout Data) throws -> Data? {
        guard let newlineIndex = buffer.firstIndex(of: 0x0A) else { return nil }

        let message = buffer.subdata(in: 0..<newlineIndex)

        guard message.count <= Self.maxMessageSize else {
            throw MessageFramerError.messageTooLarge(UInt32(message.count))
        }

        buffer.removeSubrange(0...newlineIndex)
        return message
    }
}

enum MessageFramerError: Error, Equatable {
    case messageTooLarge(UInt32)
}
