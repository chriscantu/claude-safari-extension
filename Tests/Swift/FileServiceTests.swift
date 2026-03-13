import XCTest
@testable import ClaudeInSafari

final class FileServiceTests: XCTestCase {

    private var service: FileService!
    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        service = FileService()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("FileServiceTests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    private func tmpFile(name: String, content: Data = Data("hello".utf8)) -> String {
        let url = tmpDir.appendingPathComponent(name)
        try! content.write(to: url)
        return url.path
    }

    func test_readFiles_dotDotPath_returnsError() {
        let result = service.readFiles(paths: ["/tmp/../etc/passwd"])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for .. path"); return
        }
        XCTAssertTrue(err.userMessage.contains("'..'"),
                      "Expected '..' in message, got: \(err.userMessage)")
    }

    func test_readFiles_relativePath_returnsError() {
        let result = service.readFiles(paths: ["./relative.txt"])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for relative path"); return
        }
        XCTAssertTrue(err.userMessage.contains("absolute"),
                      "Expected 'absolute' in message, got: \(err.userMessage)")
    }

    func test_readFiles_nonExistentFile_returnsError() {
        let result = service.readFiles(paths: ["/tmp/this-file-does-not-exist-\(UUID().uuidString).txt"])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for non-existent file"); return
        }
        XCTAssertTrue(err.userMessage.lowercased().contains("not found"),
                      "Expected 'not found' in message, got: \(err.userMessage)")
    }

    func test_mimeType_knownExtension_returnsCorrectMime() {
        XCTAssertEqual(service.mimeType(for: "/tmp/document.pdf"), "application/pdf")
        XCTAssertEqual(service.mimeType(for: "/tmp/image.png"), "image/png")
        XCTAssertEqual(service.mimeType(for: "/tmp/data.json"), "application/json")
    }

    func test_mimeType_unknownExtension_returnsOctetStream() {
        XCTAssertEqual(service.mimeType(for: "/tmp/binary.wasm"), "application/octet-stream")
        XCTAssertEqual(service.mimeType(for: "/tmp/no-extension"), "application/octet-stream")
    }

    func test_readFiles_singleValidFile_returnsDescriptor() {
        let content = Data("test content".utf8)
        let path = tmpFile(name: "test.txt", content: content)

        let result = service.readFiles(paths: [path])
        guard case .success(let descriptors) = result else {
            XCTFail("Expected success, got: \(result)"); return
        }
        XCTAssertEqual(descriptors.count, 1)
        XCTAssertEqual(descriptors[0].data, content)
        XCTAssertEqual(descriptors[0].size, content.count)
        XCTAssertEqual(descriptors[0].filename, "test.txt")
    }

    func test_readFiles_multipleValidFiles_returnsAllDescriptors() {
        let path1 = tmpFile(name: "a.txt", content: Data("aaa".utf8))
        let path2 = tmpFile(name: "b.txt", content: Data("bbbb".utf8))

        let result = service.readFiles(paths: [path1, path2])
        guard case .success(let descriptors) = result else {
            XCTFail("Expected success"); return
        }
        XCTAssertEqual(descriptors.count, 2)
        XCTAssertEqual(descriptors[0].filename, "a.txt")
        XCTAssertEqual(descriptors[1].filename, "b.txt")
    }

    func test_readFiles_secondPathInvalid_failsFast() {
        let path1 = tmpFile(name: "ok.txt")
        let path2 = "/tmp/does-not-exist-\(UUID().uuidString).txt"

        let result = service.readFiles(paths: [path1, path2])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for second path"); return
        }
        XCTAssertTrue(err.userMessage.lowercased().contains("not found"))
    }

    func test_readFiles_symlinkPath_resolvesAndReadsContent() {
        let content = Data("symlinked content".utf8)
        let realPath = tmpFile(name: "real.txt", content: content)
        let linkURL = tmpDir.appendingPathComponent("link.txt")
        try! FileManager.default.createSymbolicLink(atPath: linkURL.path, withDestinationPath: realPath)

        let result = service.readFiles(paths: [linkURL.path])
        guard case .success(let descriptors) = result else {
            XCTFail("Expected success for symlink"); return
        }
        XCTAssertEqual(descriptors[0].data, content)
        XCTAssertEqual(descriptors[0].filename, "real.txt")
    }

    // Directory guard — directory path must return .notReadable
    func test_readFiles_directory_returnsNotReadable() {
        // tmpDir is a real directory
        let result = service.readFiles(paths: [tmpDir.path])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for directory path"); return
        }
        XCTAssertTrue(err.userMessage.lowercased().contains("cannot read"),
                      "Expected 'Cannot read' in message, got: \(err.userMessage)")
    }

    // T9 — file larger than 100 MB limit
    func test_readFiles_fileTooLarge_returnsError() {
        // Temporarily create a real file that exceeds the 100 MB limit by writing
        // a file and then mocking the attributes check.
        // Since writing 100 MB is impractical in tests, use a subclass to override
        // the static maxFileSize limit for this test.
        class TinyLimitFileService: FileService {
            static let testMaxFileSize = 10  // 10 bytes limit
        }

        // Use TinyLimitFileService's maxFileSize by writing a file > 10 bytes.
        // However, FileService.readFile reads Self.maxFileSize — we can't override static.
        // Instead, write a real oversized file (small) and temporarily patch maxFileSize.
        // Since maxFileSize is `static let` (not overridable), take a different approach:
        // write a real file larger than 100 MB ... that's impractical.
        // Best approach for static let: write a test that creates an actual 101 MB sparse file.

        // On macOS, we can create a sparse file using FileManager without allocating real disk space.
        // FileManager.attributesOfItem returns the logical size, not allocated size.
        // We'll create a file and resize it to 101 MB using truncate (via FileHandle).

        let oversizedPath = tmpDir.appendingPathComponent("oversized.bin")
        FileManager.default.createFile(atPath: oversizedPath.path, contents: Data())
        let handle = try! FileHandle(forWritingTo: oversizedPath)
        // Seek to 101 MB and write one byte to create a sparse file with logical size > 100 MB
        let targetSize = FileService.maxFileSize + 1  // 100 MB + 1 byte
        handle.seek(toFileOffset: UInt64(targetSize))
        handle.write(Data([0x00]))
        handle.closeFile()

        let result = service.readFiles(paths: [oversizedPath.path])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for oversized file"); return
        }
        XCTAssertTrue(err.userMessage.contains("100 MB"),
                      "Expected '100 MB' in message, got: \(err.userMessage)")
    }
}
