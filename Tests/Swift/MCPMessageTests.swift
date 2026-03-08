import XCTest
@testable import ClaudeInSafari

/// Tests for the FIFO queue Codable contracts and per-request UserDefaults key isolation.
/// Covers the data-layer invariants that underpin FIFO correctness without requiring
/// an App Group sandbox.
final class MCPMessageTests: XCTestCase {

    // MARK: - QueuedToolRequest round-trip (FIFO serialisation format)

    func testQueuedToolRequestEncodesAndDecodes() throws {
        let original = QueuedToolRequest(
            requestId: "req-1",
            tool: "read_page",
            args: ["depth": AnyCodable(3)],
            context: NativeMessageContext(clientId: "client-abc", tabGroupId: "tg-1")
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(QueuedToolRequest.self, from: data)

        XCTAssertEqual(decoded.requestId, "req-1")
        XCTAssertEqual(decoded.tool, "read_page")
        XCTAssertEqual(decoded.args["depth"]?.value as? Int, 3)
        XCTAssertEqual(decoded.context?.clientId, "client-abc")
        XCTAssertEqual(decoded.context?.tabGroupId, "tg-1")
    }

    func testQueuedToolRequestWithNilContext() throws {
        let original = QueuedToolRequest(
            requestId: "req-2",
            tool: "navigate",
            args: ["url": AnyCodable("https://example.com")],
            context: nil
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(QueuedToolRequest.self, from: data)

        XCTAssertEqual(decoded.requestId, "req-2")
        XCTAssertNil(decoded.context)
    }

    /// Multiple items encode as independent JSON strings — simulates the FIFO array format.
    func testFIFOArrayOrderIsPreserved() throws {
        let items = ["req-A", "req-B", "req-C"].map { id in
            QueuedToolRequest(requestId: id, tool: "test_tool", args: [:], context: nil)
        }

        let strings = try items.map { item -> String in
            let data = try JSONEncoder().encode(item)
            return String(data: data, encoding: .utf8)!
        }

        // Encode the whole queue as a JSON array (as the FIFO file does)
        let queueData = try JSONEncoder().encode(strings)
        let decodedStrings = try JSONDecoder().decode([String].self, from: queueData)

        XCTAssertEqual(decodedStrings.count, 3)

        // Decode each item and verify order
        let decodedItems = try decodedStrings.map { str -> QueuedToolRequest in
            let data = str.data(using: .utf8)!
            return try JSONDecoder().decode(QueuedToolRequest.self, from: data)
        }

        XCTAssertEqual(decodedItems[0].requestId, "req-A")
        XCTAssertEqual(decodedItems[1].requestId, "req-B")
        XCTAssertEqual(decodedItems[2].requestId, "req-C")
    }

    // MARK: - Per-request UserDefaults key isolation

    /// Two different requestIds produce distinct UserDefaults keys — no cross-request collision.
    func testToolResponseKeysAreRequestScoped() {
        let prefix = AppConstants.UserDefaultsKeys.toolResponsePrefix
        let key1 = prefix + "req-111"
        let key2 = prefix + "req-222"
        XCTAssertNotEqual(key1, key2)
    }

    func testToolResponseKeyIncludesRequestId() {
        let requestId = "unique-uuid-xyz"
        let key = AppConstants.UserDefaultsKeys.toolResponsePrefix + requestId
        XCTAssertTrue(key.hasSuffix(requestId))
    }

    // MARK: - NativeMessage enum Codable round-trip

    func testNativeMessagePollEncodes() throws {
        let data = try JSONEncoder().encode(NativeMessage.poll)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "poll")
    }

    func testNativeMessageToolRequestRoundTrip() throws {
        let original = NativeMessage.toolRequest(
            requestId: "r1",
            tool: "navigate",
            args: ["url": AnyCodable("https://example.com")],
            context: NativeMessageContext(clientId: "c1", tabGroupId: nil)
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(NativeMessage.self, from: data)

        guard case .toolRequest(let rid, let tool, let args, let ctx) = decoded else {
            XCTFail("Expected toolRequest, got \(decoded)")
            return
        }
        XCTAssertEqual(rid, "r1")
        XCTAssertEqual(tool, "navigate")
        XCTAssertEqual(args["url"]?.value as? String, "https://example.com")
        XCTAssertEqual(ctx?.clientId, "c1")
        XCTAssertNil(ctx?.tabGroupId)
    }

    func testNativeMessageToolResponseRoundTrip() throws {
        let original = NativeMessage.toolResponse(
            requestId: "r2",
            result: ToolResponseContent(content: [ContentBlock(type: "text", text: "done")]),
            error: nil
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(NativeMessage.self, from: data)

        guard case .toolResponse(let rid, let result, let error) = decoded else {
            XCTFail("Expected toolResponse, got \(decoded)")
            return
        }
        XCTAssertEqual(rid, "r2")
        XCTAssertNotNil(result)
        XCTAssertNil(error)
        XCTAssertEqual(result?.content.first?.text, "done")
    }

    // MARK: - ContentBlock image block support

    func testContentBlockImageBlockEncodesWithoutText() throws {
        let block = ContentBlock(type: "image", data: "abc123==", mediaType: "image/png")
        let data = try JSONEncoder().encode(block)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "image")
        XCTAssertEqual(json["data"] as? String, "abc123==")
        XCTAssertEqual(json["mediaType"] as? String, "image/png")
        XCTAssertNil(json["text"])  // must not emit null "text" key
    }

    func testContentBlockTextBlockEncodesWithoutImageFields() throws {
        let block = ContentBlock(type: "text", text: "hello")
        let data = try JSONEncoder().encode(block)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "text")
        XCTAssertEqual(json["text"] as? String, "hello")
        XCTAssertNil(json["data"])
        XCTAssertNil(json["mediaType"])
    }
}
