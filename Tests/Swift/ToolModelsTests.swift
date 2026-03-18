// Tests/Swift/ToolModelsTests.swift
import XCTest
@testable import ClaudeInSafari

final class ToolModelsTests: XCTestCase {

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - T1: Poll round-trip

    func testPollRoundTrip() throws {
        let original = NativeMessage.poll
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(NativeMessage.self, from: data)
        if case .poll = decoded { /* pass */ } else {
            XCTFail("Expected .poll, got \(decoded)")
        }
    }

    // MARK: - T2: ToolRequest round-trip (with context)

    func testToolRequestRoundTrip() throws {
        let original = NativeMessage.toolRequest(
            requestId: "req-1",
            tool: "computer",
            args: [
                "action": AnyCodable("click"),
                "x": AnyCodable(100),
                "doubleClick": AnyCodable(false),
            ],
            context: NativeMessageContext(clientId: "cli-1", tabGroupId: "tg-1")
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(NativeMessage.self, from: data)

        if case .toolRequest(let id, let tool, let args, let ctx) = decoded {
            XCTAssertEqual(id, "req-1")
            XCTAssertEqual(tool, "computer")
            XCTAssertEqual(args["action"]?.value as? String, "click")
            XCTAssertEqual((args["x"]?.value as? NSNumber)?.intValue, 100)
            // Bool must survive as Bool, not Int(0) — validates CFBoolean detection
            XCTAssertEqual(args["doubleClick"]?.value as? Bool, false)
            XCTAssertEqual(ctx?.clientId, "cli-1")
            XCTAssertEqual(ctx?.tabGroupId, "tg-1")
        } else {
            XCTFail("Expected .toolRequest, got \(decoded)")
        }
    }

    // MARK: - T3: ToolRequest round-trip (nil context)

    func testToolRequestNilContextRoundTrip() throws {
        let original = NativeMessage.toolRequest(
            requestId: "req-2",
            tool: "navigate",
            args: ["url": AnyCodable("https://example.com")],
            context: nil
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(NativeMessage.self, from: data)

        if case .toolRequest(let id, let tool, let args, let ctx) = decoded {
            XCTAssertEqual(id, "req-2")
            XCTAssertEqual(tool, "navigate")
            XCTAssertEqual(args["url"]?.value as? String, "https://example.com")
            XCTAssertNil(ctx)
        } else {
            XCTFail("Expected .toolRequest, got \(decoded)")
        }
    }

    // MARK: - T4: ToolResponse round-trip

    func testToolResponseRoundTrip() throws {
        let block = ContentBlock(type: "text", text: "done")
        let content = ToolResponseContent(content: [block])
        let original = NativeMessage.toolResponse(
            requestId: "req-3",
            result: content,
            error: nil
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(NativeMessage.self, from: data)

        if case .toolResponse(let id, let result, let error) = decoded {
            XCTAssertEqual(id, "req-3")
            XCTAssertEqual(result?.content.first?.text, "done")
            XCTAssertNil(error)
        } else {
            XCTFail("Expected .toolResponse, got \(decoded)")
        }
    }

    // MARK: - T5: Unknown type throws DecodingError

    func testUnknownTypeThrows() {
        let json = #"{"type":"unknown_thing"}"#.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(NativeMessage.self, from: json)) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
                return
            }
        }
    }

    // MARK: - T6: NativeMessageContext snake_case coding keys

    func testContextSnakeCaseCodingKeys() throws {
        let json = #"{"client_id":"cli-1","tab_group_id":"tg-1"}"#.data(using: .utf8)!
        let ctx = try decoder.decode(NativeMessageContext.self, from: json)
        XCTAssertEqual(ctx.clientId, "cli-1")
        XCTAssertEqual(ctx.tabGroupId, "tg-1")
    }
}
