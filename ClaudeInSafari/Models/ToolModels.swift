import Foundation

/// Typed representation of native messages exchanged between the Swift app and Safari extension.
/// Each case enforces exactly the fields required for that message type.
enum NativeMessage: Codable {
    /// Extension → Native: request the next queued tool request.
    case poll
    /// Native → Extension: a tool request to execute.
    case toolRequest(requestId: String, tool: String, args: [String: AnyCodable], context: NativeMessageContext?)
    /// Extension → Native: the result of executing a tool request.
    case toolResponse(requestId: String, result: ToolResponseContent?, error: ToolResponseContent?)

    private enum CodingKeys: String, CodingKey {
        case type, requestId, tool, args, context, result, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "poll":
            self = .poll
        case "tool_request":
            self = .toolRequest(
                requestId: try container.decode(String.self, forKey: .requestId),
                tool: try container.decode(String.self, forKey: .tool),
                args: try container.decode([String: AnyCodable].self, forKey: .args),
                context: try container.decodeIfPresent(NativeMessageContext.self, forKey: .context)
            )
        case "tool_response":
            self = .toolResponse(
                requestId: try container.decode(String.self, forKey: .requestId),
                result: try container.decodeIfPresent(ToolResponseContent.self, forKey: .result),
                error: try container.decodeIfPresent(ToolResponseContent.self, forKey: .error)
            )
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container,
                debugDescription: "Unknown NativeMessage type: \(type)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .poll:
            try container.encode("poll", forKey: .type)
        case .toolRequest(let requestId, let tool, let args, let context):
            try container.encode("tool_request", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(tool, forKey: .tool)
            try container.encode(args, forKey: .args)
            try container.encodeIfPresent(context, forKey: .context)
        case .toolResponse(let requestId, let result, let error):
            try container.encode("tool_response", forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encodeIfPresent(error, forKey: .error)
        }
    }
}

struct NativeMessageContext: Codable {
    let clientId: String
    let tabGroupId: String?

    enum CodingKeys: String, CodingKey {
        case clientId = "client_id"
        case tabGroupId = "tab_group_id"
    }
}
