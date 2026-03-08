import Foundation

/// Represents an incoming MCP tool request from the CLI client.
struct ToolRequest: Codable {
    let method: String
    let params: ToolRequestParams
}

struct ToolRequestParams: Codable {
    let clientId: String
    let tool: String
    let args: [String: AnyCodable]

    enum CodingKeys: String, CodingKey {
        case clientId = "client_id"
        case tool
        case args
    }
}

/// Represents an outgoing MCP tool response to the CLI client.
struct ToolResponse: Codable {
    let type: String
    let result: ToolResponseContent?
    let error: ToolResponseContent?

    static func success(content: String) -> ToolResponse {
        ToolResponse(
            type: "tool_response",
            result: ToolResponseContent(content: [ContentBlock(type: "text", text: content)]),
            error: nil
        )
    }

    static func failure(message: String) -> ToolResponse {
        ToolResponse(
            type: "tool_response",
            result: nil,
            error: ToolResponseContent(content: [ContentBlock(type: "text", text: message)])
        )
    }
}

struct ToolResponseContent: Codable {
    let content: [ContentBlock]
}

struct ContentBlock: Codable {
    let type: String
    let text: String
}

/// A tool request queued in the App Group FIFO file for the extension to pick up.
/// Encoded as a JSON string in the pending_requests.json array.
/// The extension JS reads requestId, tool, args, and context from the decoded payload.
struct QueuedToolRequest: Codable {
    let requestId: String
    let tool: String
    let args: [String: AnyCodable]
    let context: NativeMessageContext?
}

/// Type-erased Codable wrapper for heterogeneous JSON values.
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "Unsupported type"))
        }
    }
}
