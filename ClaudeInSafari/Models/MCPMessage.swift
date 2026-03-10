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

/// The decoded result of parsing an extension response JSON string.
/// Used by ToolRouter.decodeExtensionResponse and its tests.
struct DecodedExtensionResponse {
    var result: ToolResponseContent?
    var error: ToolResponseContent?

    static func success(_ content: ToolResponseContent) -> DecodedExtensionResponse {
        DecodedExtensionResponse(result: content, error: nil)
    }

    static func failure(_ message: String) -> DecodedExtensionResponse {
        DecodedExtensionResponse(
            result: nil,
            error: ToolResponseContent(content: [ContentBlock(type: "text", text: message)])
        )
    }
}

struct ContentBlock: Codable {
    let type: String
    let text: String?       // present for type "text"
    let data: String?       // base64 payload for type "image"
    let mediaType: String?  // MIME type for type "image"

    init(type: String, text: String? = nil, data: String? = nil, mediaType: String? = nil) {
        self.type = type
        self.text = text
        self.data = data
        self.mediaType = mediaType
    }

    enum CodingKeys: String, CodingKey { case type, text, data, mediaType }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(data, forKey: .data)
        try c.encodeIfPresent(mediaType, forKey: .mediaType)
    }
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
        // Decode Int before Bool: Swift's JSONDecoder decodes JSON booleans
        // as Int (true→1) via NSNumber bridging. Trying Int first is safe
        // because decode(Int.self) rejects JSON true/false tokens.
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
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
        case let number as NSNumber:
            // Bool, Int, and Double stored in Any all bridge to NSNumber via ObjC,
            // so pattern-matching `as Bool` or `as Int` is unreliable (e.g.,
            // NSNumber(1) matches both). Use CFBoolean type identity to distinguish
            // true JSON booleans from numeric values.
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                try container.encode(number.boolValue)
            } else {
                // NSNumber does not distinguish Int(1) from Double(1.0) at the
                // CFTypeID level. We prefer Int when the value is representable
                // without loss, matching JSON's typical treatment of whole numbers.
                let d = number.doubleValue
                if d.isFinite && d == Double(number.intValue) {
                    try container.encode(number.intValue)
                } else {
                    try container.encode(d)
                }
            }
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
