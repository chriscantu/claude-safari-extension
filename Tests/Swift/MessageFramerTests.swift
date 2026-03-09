import XCTest
@testable import ClaudeInSafari

/// Tests for MessageFramer — newline-delimited MCP stdio transport.
final class MessageFramerTests: XCTestCase {
    let framer = MessageFramer()

    // MARK: - frame() tests

    func testFrameEmptyData() {
        let result = framer.frame(Data())
        XCTAssertEqual(result, Data([0x0A])) // just a newline
    }

    func testFrameSmallMessage() {
        let data = "hello".data(using: .utf8)!
        let result = framer.frame(data)
        let expected = data + Data([0x0A])
        XCTAssertEqual(result, expected)
    }

    func testFrameAppendsNewline() {
        let data = "{}".data(using: .utf8)!
        let result = framer.frame(data)
        XCTAssertEqual(result.last, 0x0A)
        XCTAssertEqual(result.count, data.count + 1)
    }

    func testFrameJSONMessage() {
        let json = #"{"jsonrpc":"2.0","method":"initialize","id":0}"#.data(using: .utf8)!
        let result = framer.frame(json)
        XCTAssertEqual(result, json + Data([0x0A]))
    }

    // MARK: - deframe() tests

    func testDeframeCompleteMessage() throws {
        var buffer = "hello".data(using: .utf8)! + Data([0x0A])
        let result = try framer.deframe(&buffer)
        XCTAssertEqual(result, "hello".data(using: .utf8)!)
        XCTAssertTrue(buffer.isEmpty)
    }

    func testDeframeIncompleteMessage() throws {
        var buffer = "hello".data(using: .utf8)! // no newline yet
        let result = try framer.deframe(&buffer)
        XCTAssertNil(result)
        XCTAssertEqual(buffer.count, 5) // buffer unchanged
    }

    func testDeframeEmptyBuffer() throws {
        var buffer = Data()
        let result = try framer.deframe(&buffer)
        XCTAssertNil(result)
    }

    func testDeframeMultipleMessages() throws {
        let msg1 = "hello".data(using: .utf8)!
        let msg2 = "world".data(using: .utf8)!
        var buffer = framer.frame(msg1) + framer.frame(msg2)

        let result1 = try framer.deframe(&buffer)
        XCTAssertEqual(result1, msg1)

        let result2 = try framer.deframe(&buffer)
        XCTAssertEqual(result2, msg2)

        XCTAssertTrue(buffer.isEmpty)
    }

    func testDeframeConsumesNewline() throws {
        var buffer = "hi".data(using: .utf8)! + Data([0x0A]) + "there".data(using: .utf8)!
        _ = try framer.deframe(&buffer)
        XCTAssertEqual(buffer, "there".data(using: .utf8)!)
    }

    func testDeframeOversizedMessage() {
        let bigPayload = Data(repeating: 0x41, count: MessageFramer.maxMessageSize + 1)
        var buffer = bigPayload + Data([0x0A])

        XCTAssertThrowsError(try framer.deframe(&buffer)) { error in
            guard case MessageFramerError.messageTooLarge = error else {
                XCTFail("Expected messageTooLarge error, got \(error)")
                return
            }
        }
    }

    // MARK: - Round-trip tests

    func testRoundTrip() throws {
        let original = #"{"tool":"read_page","args":{}}"#.data(using: .utf8)!
        var buffer = framer.frame(original)
        let result = try framer.deframe(&buffer)
        XCTAssertEqual(result, original)
    }

    func testRoundTripWithJSON() throws {
        let json: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": ["name": "navigate", "arguments": ["url": "https://example.com"]],
            "id": 1
        ]
        let original = try JSONSerialization.data(withJSONObject: json)
        var buffer = framer.frame(original)
        let result = try framer.deframe(&buffer)
        XCTAssertEqual(result, original)
    }

    func testRoundTripEmptyMessage() throws {
        let original = Data()
        var buffer = framer.frame(original)
        let result = try framer.deframe(&buffer)
        XCTAssertEqual(result, original)
    }
}
