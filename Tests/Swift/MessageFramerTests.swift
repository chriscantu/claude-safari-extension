import XCTest
@testable import ClaudeInSafari

/// Tests for MessageFramer per Spec 002.
final class MessageFramerTests: XCTestCase {
    let framer = MessageFramer()

    // MARK: - frame() tests

    func testFrameEmptyData() {
        let result = framer.frame(Data())
        XCTAssertEqual(result, Data([0x00, 0x00, 0x00, 0x00]))
    }

    func testFrameSmallMessage() {
        let data = "hello".data(using: .utf8)!
        let result = framer.frame(data)
        let expected = Data([0x00, 0x00, 0x00, 0x05]) + data
        XCTAssertEqual(result, expected)
    }

    func testFrameLargeMessage() {
        let data = Data(repeating: 0xFF, count: 1000)
        let result = framer.frame(data)
        // 1000 = 0x000003E8 in big-endian
        let expected = Data([0x00, 0x00, 0x03, 0xE8]) + data
        XCTAssertEqual(result, expected)
    }

    func testFrameEndianness() {
        let data = Data(repeating: 0xAA, count: 256)
        let result = framer.frame(data)
        // 256 = 0x00000100 in big-endian
        let header = Array(result.prefix(4))
        XCTAssertEqual(header, [0x00, 0x00, 0x01, 0x00])
    }

    // MARK: - deframe() tests

    func testDeframeCompleteMessage() throws {
        var buffer = Data([0x00, 0x00, 0x00, 0x05]) + "hello".data(using: .utf8)!
        let result = try framer.deframe(&buffer)
        XCTAssertEqual(result, "hello".data(using: .utf8)!)
        XCTAssertTrue(buffer.isEmpty)
    }

    func testDeframeIncompleteHeader() throws {
        var buffer = Data([0x00, 0x00, 0x00]) // only 3 bytes
        let result = try framer.deframe(&buffer)
        XCTAssertNil(result)
        XCTAssertEqual(buffer.count, 3) // buffer unchanged
    }

    func testDeframeIncompleteBody() throws {
        // Header says 10 bytes, but only 5 present
        var buffer = Data([0x00, 0x00, 0x00, 0x0A]) + Data(repeating: 0x42, count: 5)
        let result = try framer.deframe(&buffer)
        XCTAssertNil(result)
        XCTAssertEqual(buffer.count, 9) // buffer unchanged
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

    func testDeframeOversizedMessage() {
        // Length prefix > 10 MB
        let hugeLength: UInt32 = 11_000_000
        var lengthBytes = hugeLength.bigEndian
        var buffer = Data(bytes: &lengthBytes, count: 4)
        buffer.append(Data(repeating: 0x00, count: 10))

        XCTAssertThrowsError(try framer.deframe(&buffer)) { error in
            guard case MessageFramerError.messageTooLarge(let size) = error else {
                XCTFail("Expected messageTooLarge error, got \(error)")
                return
            }
            XCTAssertEqual(size, hugeLength)
        }
    }

    func testDeframeEmptyBuffer() throws {
        var buffer = Data()
        let result = try framer.deframe(&buffer)
        XCTAssertNil(result)
    }

    // MARK: - Round-trip tests

    func testRoundTrip() throws {
        let original = "{\"tool\": \"read_page\", \"args\": {}}".data(using: .utf8)!
        var buffer = framer.frame(original)
        let result = try framer.deframe(&buffer)
        XCTAssertEqual(result, original)
    }

    func testRoundTripWithJSON() throws {
        let json: [String: Any] = ["method": "execute_tool", "params": ["tool": "navigate", "args": ["url": "https://example.com"]]]
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
