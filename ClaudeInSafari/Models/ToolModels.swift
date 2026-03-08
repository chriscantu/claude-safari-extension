import Foundation

/// Represents a native message sent between the native app and Safari extension.
struct NativeMessage: Codable {
    let type: String
    let requestId: String?
    let tool: String?
    let args: [String: AnyCodable]?
    let context: NativeMessageContext?
    let result: ToolResponseContent?
    let error: ToolResponseContent?

    init(
        type: String,
        requestId: String? = nil,
        tool: String? = nil,
        args: [String: AnyCodable]? = nil,
        context: NativeMessageContext? = nil,
        result: ToolResponseContent? = nil,
        error: ToolResponseContent? = nil
    ) {
        self.type = type
        self.requestId = requestId
        self.tool = tool
        self.args = args
        self.context = context
        self.result = result
        self.error = error
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
