import Foundation

/// Encodes and decodes length-prefixed messages per Spec 002.
///
/// Wire format: [4 bytes: big-endian UInt32 length] [N bytes: UTF-8 JSON payload]
/// This matches the Chrome native messaging host protocol.
struct MessageFramer {
    /// Maximum allowed message size (10 MB) to protect against corrupt frames.
    static let maxMessageSize: UInt32 = 10_000_000

    /// Encode a message for transmission by prepending a 4-byte big-endian length prefix.
    func frame(_ data: Data) -> Data {
        var length = UInt32(data.count).bigEndian
        var framed = Data(bytes: &length, count: 4)
        framed.append(data)
        return framed
    }

    /// Attempt to extract a complete message from a buffer.
    ///
    /// On success, removes the consumed bytes from the buffer and returns the message payload.
    /// Returns `nil` if the buffer doesn't contain a complete message yet.
    /// Throws `MessageFramerError.messageTooLarge` if the length prefix exceeds `maxMessageSize`.
    func deframe(_ buffer: inout Data) throws -> Data? {
        guard buffer.count >= 4 else { return nil }

        let length = buffer.withUnsafeBytes { ptr in
            ptr.load(as: UInt32.self).bigEndian
        }

        guard length <= Self.maxMessageSize else {
            throw MessageFramerError.messageTooLarge(length)
        }

        let totalLength = 4 + Int(length)
        guard buffer.count >= totalLength else { return nil }

        let message = buffer.subdata(in: 4..<totalLength)
        buffer.removeSubrange(0..<totalLength)
        return message
    }
}

enum MessageFramerError: Error, Equatable {
    case messageTooLarge(UInt32)
}
