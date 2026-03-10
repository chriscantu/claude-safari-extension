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

    // MARK: - Per-request response file isolation

    /// Two different requestIds produce distinct response file URLs — no cross-request collision.
    func testResponseFileURLsAreRequestScoped() {
        let url1 = AppConstants.responseFileURL(for: "req-111")
        let url2 = AppConstants.responseFileURL(for: "req-222")
        XCTAssertNotNil(url1)
        XCTAssertNotNil(url2)
        XCTAssertNotEqual(url1, url2)
    }

    func testResponseFileURLIncludesRequestId() {
        let requestId = "unique-uuid-xyz"
        let url = AppConstants.responseFileURL(for: requestId)
        XCTAssertNotNil(url)
        XCTAssertTrue(url?.lastPathComponent.contains(requestId) == true)
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

    // MARK: - NativeMessage unknown type rejection

    func testNativeMessageUnknownTypeThrows() throws {
        let json = #"{"type":"unknown_type","requestId":"r99"}"#.data(using: .utf8)!
        XCTAssertThrowsError(try JSONDecoder().decode(NativeMessage.self, from: json))
    }

    // MARK: - NativeMessageContext snake_case wire format

    func testNativeMessageContextUsesSnakeCaseWireFormat() throws {
        let ctx = NativeMessageContext(clientId: "client-1", tabGroupId: "group-2")
        let data = try JSONEncoder().encode(ctx)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["client_id"] as? String, "client-1")
        XCTAssertEqual(json["tab_group_id"] as? String, "group-2")
        XCTAssertNil(json["clientId"])
        XCTAssertNil(json["tabGroupId"])
    }

    func testNativeMessageContextNilTabGroupIdRoundTrips() throws {
        let ctx = NativeMessageContext(clientId: "c1", tabGroupId: nil)
        let data = try JSONEncoder().encode(ctx)
        let decoded = try JSONDecoder().decode(NativeMessageContext.self, from: data)
        XCTAssertEqual(decoded.clientId, "c1")
        XCTAssertNil(decoded.tabGroupId)
    }

    // MARK: - ToolRouter.decodeExtensionResponse

    func testDecodeExtensionResponseSuccess() {
        let router = ToolRouter()
        let json = #"{"result":{"content":[{"type":"text","text":"hello"}]}}"#
        let response = router.decodeExtensionResponse(json)
        XCTAssertNotNil(response.result)
        XCTAssertNil(response.error)
        XCTAssertEqual(response.result?.content.first?.text, "hello")
    }

    func testDecodeExtensionResponseError() {
        let router = ToolRouter()
        let json = #"{"error":{"content":[{"type":"text","text":"something went wrong"}]}}"#
        let response = router.decodeExtensionResponse(json)
        XCTAssertNil(response.result)
        XCTAssertNotNil(response.error)
        XCTAssertEqual(response.error?.content.first?.text, "something went wrong")
    }

    func testDecodeExtensionResponseMalformedJson() {
        let router = ToolRouter()
        let response = router.decodeExtensionResponse("not-valid-json{{{")
        XCTAssertNil(response.result)
        XCTAssertNotNil(response.error)
        XCTAssertEqual(response.error?.content.first?.text, "Failed to decode extension response")
    }

    func testDecodeExtensionResponseMalformedStructure() {
        let router = ToolRouter()
        let response = router.decodeExtensionResponse(#"{"unexpected":"format"}"#)
        XCTAssertNil(response.result)
        XCTAssertNotNil(response.error)
        XCTAssertEqual(response.error?.content.first?.text, "Malformed extension response")
    }

    // MARK: - AnyCodable NSNumber/Bool coercion regression

    /// NSNumber(value: 1) must encode as JSON integer 1, not boolean true.
    /// Regression test for the ObjC bridging bug where integer args like tabId
    /// were re-encoded as JSON booleans through the Swift native bridge.
    func testAnyCodableEncodesNSNumberIntegerAsInt() throws {
        let value = AnyCodable(NSNumber(value: 1))
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(String(data: data, encoding: .utf8), "1")
    }

    func testAnyCodableEncodesNSNumberZeroAsInt() throws {
        let value = AnyCodable(NSNumber(value: 0))
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(String(data: data, encoding: .utf8), "0")
    }

    func testAnyCodableEncodesNSBooleanTrueAsBool() throws {
        let value = AnyCodable(NSNumber(value: true))
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(String(data: data, encoding: .utf8), "true")
    }

    func testAnyCodableEncodesNSBooleanFalseAsBool() throws {
        let value = AnyCodable(NSNumber(value: false))
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(String(data: data, encoding: .utf8), "false")
    }

    func testAnyCodableEncodesNSNumberDoubleAsDouble() throws {
        let value = AnyCodable(NSNumber(value: 3.14))
        let data = try JSONEncoder().encode(value)
        let str = String(data: data, encoding: .utf8)!
        XCTAssertTrue(str.starts(with: "3.14"))
    }

    /// End-to-end: a QueuedToolRequest with integer tabId must not coerce to boolean.
    func testQueuedToolRequestPreservesIntegerTabId() throws {
        let request = QueuedToolRequest(
            requestId: "req-tab",
            tool: "navigate",
            args: ["tabId": AnyCodable(NSNumber(value: 1)), "url": AnyCodable("https://example.com")],
            context: nil
        )
        let data = try JSONEncoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let args = json["args"] as! [String: Any]
        XCTAssertEqual(args["tabId"] as? Int, 1)
    }

    /// Round-trip from raw JSON: integers stay integers, booleans stay booleans.
    func testAnyCodableRoundTripPreservesTypesFromRawJSON() throws {
        let json = #"{"flag": true, "count": 1, "off": false, "zero": 0}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode([String: AnyCodable].self, from: json)
        let reencoded = try JSONEncoder().encode(decoded)
        let result = try JSONSerialization.jsonObject(with: reencoded) as! [String: Any]
        XCTAssertEqual(result["flag"] as? Bool, true)
        XCTAssertEqual(result["count"] as? Int, 1)
        XCTAssertEqual(result["off"] as? Bool, false)
        XCTAssertEqual(result["zero"] as? Int, 0)
    }

    func testDecodeExtensionResponseAllBlocksMalformed() {
        let router = ToolRouter()
        // Content array exists but all blocks are missing the required "type" key
        let json = #"{"result":{"content":[{"bad":"block"},{"also":"bad"}]}}"#
        let response = router.decodeExtensionResponse(json)
        XCTAssertNil(response.result)
        XCTAssertNotNil(response.error)
        XCTAssertEqual(response.error?.content.first?.text, "Extension response contained no valid content blocks")
    }
}
