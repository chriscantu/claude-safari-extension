# file_upload Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `file_upload` MCP tool that reads local files via the native Swift app and injects them into a `<input type="file">` element using the Safari extension.

**Architecture:** `ToolRouter` intercepts `file_upload` calls, delegates file reading to `FileService`, base64-encodes the results, and injects them as `enrichedArgs["files"]` before forwarding to `file-upload.js` via the existing extension queue. The extension handler uses an injected IIFE with `CSS.escape(ref)` for safe element resolution and `DataTransfer` for file injection.

**Tech Stack:** Swift (FileService, ToolRouter), JavaScript (file-upload.js), XCTest (FileServiceTests, ToolRouterTests), Jest/jsdom/vm (file-upload.test.js)

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `ClaudeInSafari/ClaudeInSafari.entitlements` | Modify | Add `temporary-exception.files.absolute-path.read-only` entitlement |
| `ClaudeInSafari/Services/FileService.swift` | Replace stub | `FileDescriptor`, `FileReadError`, `readFiles(paths:)` |
| `Tests/Swift/FileServiceTests.swift` | Create | TDD tests for FileService validation and reading |
| `ClaudeInSafari/MCP/ToolRouter.swift` | Modify | Add `fileService` injection, `handleFileUpload`, branch in `handleToolCall` |
| `Tests/Swift/ToolRouterTests.swift` | Modify | Add 3 `file_upload` router tests; update 5 existing `ToolRouter(screenshotService:gifService:)` calls |
| `ClaudeInSafari Extension/Resources/tools/file-upload.js` | Create | Extension handler + injected IIFE |
| `Tests/JS/file-upload.test.js` | Create | Jest tests for file-upload.js |
| `ClaudeInSafari Extension/Resources/manifest.json` | Modify | Add `file-upload.js` to `background.scripts` before `background.js` |
| `docs/regression-tests.md` | Modify | Add Section 15 for manual `file_upload` tests |

---

## Chunk 1: Entitlement + FileService

### Task 1: Add file-read entitlement

**Files:**
- Modify: `ClaudeInSafari/ClaudeInSafari.entitlements`

The native app runs in the App Sandbox. Without a `temporary-exception` entitlement, `FileManager.default.contents(atPath:)` silently returns `nil` for any path outside the app's container. This is a developer-tool-only entitlement — not App Store compatible.

- [ ] **Step 1: Add the entitlement**

In `ClaudeInSafari/ClaudeInSafari.entitlements`, add inside the `<dict>`:

```xml
<key>com.apple.security.temporary-exception.files.absolute-path.read-only</key>
<array>
    <string>/</string>
</array>
```

Final file should look like:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>group.com.chriscantu.claudeinsafari</string>
    </array>
    <key>com.apple.security.temporary-exception.apple-events</key>
    <array>
        <string>com.apple.Safari</string>
    </array>
    <key>com.apple.security.temporary-exception.files.absolute-path.read-only</key>
    <array>
        <string>/</string>
    </array>
</dict>
</plist>
```

- [ ] **Step 2: Verify build still passes**

```fish
make test-swift
```

Expected: all existing Swift tests pass, 0 failures.

---

### Task 2: FileService — TDD

**Files:**
- Create: `Tests/Swift/FileServiceTests.swift`
- Modify: `ClaudeInSafari/Services/FileService.swift`

`FileService` is the only component with purely synchronous, deterministic behavior — ideal for pure unit testing. Tests write real temp files to disk using `FileManager`; no mocks needed.

- [ ] **Step 1: Write the failing tests**

Create `Tests/Swift/FileServiceTests.swift`:

```swift
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

    // Helper — write content to a temp file and return its path
    private func tmpFile(name: String, content: Data = Data("hello".utf8)) -> String {
        let url = tmpDir.appendingPathComponent(name)
        try! content.write(to: url)
        return url.path
    }

    // T_dotdot — path with .. components
    func test_readFiles_dotDotPath_returnsError() {
        let result = service.readFiles(paths: ["/tmp/../etc/passwd"])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for .. path"); return
        }
        XCTAssertTrue(err.userMessage.contains("'..'"),
                      "Expected '..' in message, got: \(err.userMessage)")
    }

    // T5 — relative path
    func test_readFiles_relativePath_returnsError() {
        let result = service.readFiles(paths: ["./relative.txt"])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for relative path"); return
        }
        XCTAssertTrue(err.userMessage.contains("absolute"),
                      "Expected 'absolute' in message, got: \(err.userMessage)")
    }

    // T4 — non-existent file
    func test_readFiles_nonExistentFile_returnsError() {
        let result = service.readFiles(paths: ["/tmp/this-file-does-not-exist-\(UUID().uuidString).txt"])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for non-existent file"); return
        }
        XCTAssertTrue(err.userMessage.lowercased().contains("not found"),
                      "Expected 'not found' in message, got: \(err.userMessage)")
    }

    // T_mimeType — known extension
    func test_mimeType_knownExtension_returnsCorrectMime() {
        XCTAssertEqual(service.mimeType(for: "/tmp/document.pdf"), "application/pdf")
        XCTAssertEqual(service.mimeType(for: "/tmp/image.png"), "image/png")
        XCTAssertEqual(service.mimeType(for: "/tmp/data.json"), "application/json")
    }

    // T11 — unknown extension falls back to octet-stream
    func test_mimeType_unknownExtension_returnsOctetStream() {
        XCTAssertEqual(service.mimeType(for: "/tmp/binary.wasm"), "application/octet-stream")
        XCTAssertEqual(service.mimeType(for: "/tmp/no-extension"), "application/octet-stream")
    }

    // T1 — single file happy path
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

    // T2 — multiple files happy path
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

    // Fail-fast: first path valid, second invalid — returns error for second
    func test_readFiles_secondPathInvalid_failsFast() {
        let path1 = tmpFile(name: "ok.txt")
        let path2 = "/tmp/does-not-exist-\(UUID().uuidString).txt"

        let result = service.readFiles(paths: [path1, path2])
        guard case .failure(let err) = result else {
            XCTFail("Expected failure for second path"); return
        }
        XCTAssertTrue(err.userMessage.lowercased().contains("not found"))
    }

    // T_symlink — symlink resolves transparently
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
        // filename comes from the resolved (real) file, not the link
        XCTAssertEqual(descriptors[0].filename, "real.txt")
    }
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```fish
make test-swift 2>&1 | grep -E "error:|FAILED|FileService"
```

Expected: compile error — `FileService` has no `readFiles`, no `FileDescriptor`, no `FileReadError`.

- [ ] **Step 3: Implement FileService**

Replace `ClaudeInSafari/Services/FileService.swift` with:

```swift
import Foundation
import UniformTypeIdentifiers

/// Reads local files for the file_upload tool.
/// See Spec 019 for full specification.
///
/// Requires `com.apple.security.temporary-exception.files.absolute-path.read-only`
/// entitlement in ClaudeInSafari.entitlements for App Sandbox access.
class FileService {

    enum FileReadError: Error {
        case dotDotComponent(path: String)
        case notAbsolute(path: String)
        case notFound(path: String)
        case notReadable(path: String)
        case tooLarge(path: String, size: Int)

        var userMessage: String {
            switch self {
            case .dotDotComponent(let p): return "Path must not contain '..' components: \(p)"
            case .notAbsolute(let p):     return "Path must be absolute: \(p)"
            case .notFound(let p):        return "File not found: \(p)"
            case .notReadable(let p):     return "Cannot read file: \(p)"
            case .tooLarge(let p, _):     return "File exceeds 100 MB limit: \(p)"
            }
        }
    }

    struct FileDescriptor {
        let filename: String
        let mimeType: String
        let data: Data
        let size: Int
    }

    static let maxFileSize = 100 * 1024 * 1024  // 100 MB

    /// Reads all paths fail-fast: stops at the first invalid or unreadable path.
    func readFiles(paths: [String]) -> Result<[FileDescriptor], FileReadError> {
        var descriptors: [FileDescriptor] = []
        for path in paths {
            switch readFile(path: path) {
            case .success(let descriptor): descriptors.append(descriptor)
            case .failure(let error):      return .failure(error)
            }
        }
        return .success(descriptors)
    }

    private func readFile(path: String) -> Result<FileDescriptor, FileReadError> {
        // 1. Reject .. components
        if path.contains("..") {
            return .failure(.dotDotComponent(path: path))
        }
        // 2. Must be absolute
        guard path.hasPrefix("/") else {
            return .failure(.notAbsolute(path: path))
        }
        // 3. Resolve symlinks transparently
        let resolvedURL = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let resolvedPath = resolvedURL.path

        // 4. Check existence
        let fm = FileManager.default
        guard fm.fileExists(atPath: resolvedPath) else {
            return .failure(.notFound(path: path))
        }
        // 5. Check readability
        guard fm.isReadableFile(atPath: resolvedPath) else {
            return .failure(.notReadable(path: path))
        }
        // 6. Check size
        let attrs = try? fm.attributesOfItem(atPath: resolvedPath)
        let fileSize = (attrs?[.size] as? Int) ?? 0
        guard fileSize <= Self.maxFileSize else {
            return .failure(.tooLarge(path: path, size: fileSize))
        }
        // 7. Read contents
        guard let data = fm.contents(atPath: resolvedPath) else {
            return .failure(.notReadable(path: path))
        }

        return .success(FileDescriptor(
            filename: resolvedURL.lastPathComponent,
            mimeType: mimeType(for: resolvedPath),
            data: data,
            size: data.count
        ))
    }

    func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension
        if !ext.isEmpty, let utType = UTType(filenameExtension: ext) {
            return utType.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
    }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```fish
make test-swift 2>&1 | grep -E "FileService|PASSED|FAILED|error:"
```

Expected: all `FileServiceTests` pass, 0 failures.

- [ ] **Step 5: Commit**

```fish
git add ClaudeInSafari/ClaudeInSafari.entitlements \
        ClaudeInSafari/Services/FileService.swift \
        Tests/Swift/FileServiceTests.swift
git commit -m "feat(file-upload): implement FileService with TDD + add file-read entitlement"
```

---

## Chunk 2: ToolRouter Integration

### Task 3: Wire ToolRouter to FileService — TDD

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift`
- Modify: `Tests/Swift/ToolRouterTests.swift`

`ToolRouter` is the bridge between the MCP socket and both native services and the extension. The pattern mirrors `handleUploadImage` exactly: guard clauses first, native work second, `forwardToExtension` last.

**Important:** Adding `fileService` to `ToolRouter`'s testable `init` requires updating every existing call site in `ToolRouterTests.swift` that uses `ToolRouter(screenshotService:gifService:)`. There are 5 such call sites — all need a `fileService: FileService()` argument appended.

- [ ] **Step 1: Write the failing router tests**

Append to `ToolRouterTests.swift`, inside `ToolRouterTests` class (before the closing `}`):

```swift
// MARK: - File Upload (ToolRouter native interception)

func testHandleFileUpload_missingPaths_sendsError() {
    let mock = MockMCPSocketServer()
    router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
    router.setServer(mock)

    let data = try! JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "id": 10,
        "method": "tools/call",
        "params": ["name": "file_upload", "arguments": ["ref": "upload-ref"]]
    ])
    router.socketServer(mock, didReceiveMessage: data, from: "client1")

    let response = mock.lastSentJSON()
    XCTAssertNotNil(response?["error"], "Expected error for missing paths")
    let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
    XCTAssertTrue(msg.contains("paths"), "Expected 'paths' in error: \(msg)")
}

func testHandleFileUpload_missingRef_sendsError() {
    let mock = MockMCPSocketServer()
    router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
    router.setServer(mock)

    let data = try! JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "id": 11,
        "method": "tools/call",
        "params": ["name": "file_upload", "arguments": ["paths": ["/tmp/test.txt"]]]
    ])
    router.socketServer(mock, didReceiveMessage: data, from: "client1")

    let response = mock.lastSentJSON()
    XCTAssertNotNil(response?["error"], "Expected error for missing ref")
    let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
    XCTAssertTrue(msg.contains("ref"), "Expected 'ref' in error: \(msg)")
}

func testHandleFileUpload_fileServiceError_sendsError() {
    let mock = MockMCPSocketServer()
    router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())
    router.setServer(mock)

    // Non-existent file — FileService returns .notFound
    let data = try! JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "id": 12,
        "method": "tools/call",
        "params": ["name": "file_upload", "arguments": [
            "paths": ["/tmp/no-such-file-\(UUID().uuidString).txt"],
            "ref": "upload-ref"
        ]]
    ])
    router.socketServer(mock, didReceiveMessage: data, from: "client1")

    let response = mock.lastSentJSON()
    XCTAssertNotNil(response?["error"], "Expected error for non-existent file")
    let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
    XCTAssertTrue(msg.lowercased().contains("not found"), "Expected 'not found' in error: \(msg)")
}
```

- [ ] **Step 2: Run to confirm new tests fail**

```fish
make test-swift 2>&1 | grep -E "testHandleFileUpload|error:"
```

Expected: compile error — `ToolRouter` has no `fileService` parameter.

- [ ] **Step 3: Update ToolRouter.swift**

**3a. Add `fileService` property and update inits** (lines 6–23 of `ToolRouter.swift`):

Change:
```swift
class ToolRouter: MCPSocketServerDelegate {
    private weak var server: MCPSocketServer?
    private let screenshotService: ScreenshotService
    private let appleScriptBridge = AppleScriptBridge()
    private let gifService: GifService

    // Production init — all services created fresh
    convenience init() {
        self.init(
            screenshotService: ScreenshotService(),
            gifService: GifService()
        )
    }

    // Testable init — inject mock services for unit tests
    init(screenshotService: ScreenshotService, gifService: GifService) {
        self.screenshotService = screenshotService
        self.gifService = gifService
    }
```

To:
```swift
class ToolRouter: MCPSocketServerDelegate {
    private weak var server: MCPSocketServer?
    private let screenshotService: ScreenshotService
    private let appleScriptBridge = AppleScriptBridge()
    private let gifService: GifService
    private let fileService: FileService

    // Production init — all services created fresh
    convenience init() {
        self.init(
            screenshotService: ScreenshotService(),
            gifService: GifService(),
            fileService: FileService()
        )
    }

    // Testable init — inject mock services for unit tests
    init(screenshotService: ScreenshotService, gifService: GifService, fileService: FileService) {
        self.screenshotService = screenshotService
        self.gifService = gifService
        self.fileService = fileService
    }
```

**3b. Add `file_upload` branch in `handleToolCall`** — insert after the `upload_image` branch (around line 114):

```swift
        } else if toolName == "file_upload" {
            handleFileUpload(arguments: arguments, id: id, clientId: clientId)
```

**3c. Add `handleFileUpload` method** — add a new `// MARK: - Native File Upload` section after `handleUploadImage`:

```swift
// MARK: - Native File Upload

private func handleFileUpload(arguments: [String: Any], id: Any?, clientId: String) {
    guard let rawPaths = arguments["paths"] as? [Any],
          !rawPaths.isEmpty,
          let paths = rawPaths as? [String] else {
        sendError(id: id, code: -32000,
                  message: "paths is required and must be a non-empty array", to: clientId)
        return
    }
    guard let ref = arguments["ref"] as? String, !ref.isEmpty else {
        sendError(id: id, code: -32000, message: "ref parameter is required", to: clientId)
        return
    }

    switch fileService.readFiles(paths: paths) {
    case .failure(let error):
        sendError(id: id, code: -32000, message: error.userMessage, to: clientId)
    case .success(let descriptors):
        let filesPayload: [[String: Any]] = descriptors.map { d in
            [
                "base64":   d.data.base64EncodedString(),
                "filename": d.filename,
                "mimeType": d.mimeType,
                "size":     d.size
            ]
        }
        var enrichedArgs = arguments
        enrichedArgs["files"] = filesPayload
        let queued = QueuedToolRequest(
            requestId: UUID().uuidString,
            tool: "file_upload",
            args: enrichedArgs.mapValues { AnyCodable($0) },
            context: NativeMessageContext(clientId: clientId, tabGroupId: nil)
        )
        forwardToExtension(queued, id: id, clientId: clientId, arguments: enrichedArgs)
    }
}
```

**3d. Update the 5 existing call sites in `ToolRouterTests.swift`** that use `ToolRouter(screenshotService:gifService:)` — append `fileService: FileService()` to each:

Search for `ToolRouter(screenshotService:` in the file. There are 5 occurrences (lines 274, 292, 310, 345, 389). Each becomes:

```swift
// Before:
ToolRouter(screenshotService: ScreenshotService(), gifService: GifService())
// After:
ToolRouter(screenshotService: ScreenshotService(), gifService: GifService(), fileService: FileService())

// Before (line 345 — uses mockService):
ToolRouter(screenshotService: mockService, gifService: GifService())
// After:
ToolRouter(screenshotService: mockService, gifService: GifService(), fileService: FileService())

// Before (line 389 — ToolRouterGifHookTests.setUp):
ToolRouter(screenshotService: screenshotService, gifService: gifService)
// After:
ToolRouter(screenshotService: screenshotService, gifService: gifService, fileService: FileService())
```

- [ ] **Step 4: Run all Swift tests**

```fish
make test-swift
```

Expected: all Swift tests pass including the 3 new `testHandleFileUpload_*` tests.

- [ ] **Step 5: Commit**

```fish
git add ClaudeInSafari/MCP/ToolRouter.swift \
        Tests/Swift/ToolRouterTests.swift
git commit -m "feat(file-upload): wire ToolRouter to FileService with handleFileUpload"
```

---

## Chunk 3: Extension Handler

### Task 4: file-upload.js + Jest tests — TDD

**Files:**
- Create: `Tests/JS/file-upload.test.js`
- Create: `ClaudeInSafari Extension/Resources/tools/file-upload.js`

The JS handler mirrors `upload-image.js` closely. The injected IIFE is self-contained — no extension API access, only `document`, `CSS`, `DataTransfer`, `File`, `Blob`, `Uint8Array`, `atob`, `Event`. Tests use the same `vm.runInNewContext` + `makeDomBrowserMock` pattern from `upload-image.test.js`.

- [ ] **Step 1: Write the failing tests**

Create `Tests/JS/file-upload.test.js`:

```js
/**
 * @jest-environment jsdom
 *
 * Tests for tools/file-upload.js
 * See Spec 019 (file-upload).
 *
 * T1  — single file + ref to file input — uploaded, success text with name/size
 * T2  — two files + ref to <input multiple> — both uploaded, multi-file success text
 * T3  — two files to input without multiple attribute — isError
 * T7  — ref not found on page — isError
 * T8  — ref points to non-file-input element — isError
 * T10 — successful upload dispatches both change and input events
 * T11 — file with mimeType application/octet-stream — created correctly
 * T13 — input with accept=".pdf", uploading .png — success with warning
 * T15 — args.ref missing — isError
 * T16 — args.files missing — isError (internal guard)
 * T12 — resolveTab returns null — isError
 * T17 — tab closed mid-execution — re-throws without classification
 * T18 — invalid base64 — isError from injected IIFE
 *
 * DOM injection tests (T1, T2, T3, T7, T8, T10, T11, T13, T18) evaluate the injected
 * IIFE via vm.runInNewContext so the real injected code runs.
 * Guard tests (T15, T16, T12) mock executeScript entirely.
 * T17 expects a throw.
 */

'use strict';

const vm = require('vm');

// Minimal valid base64 payload for a single byte
const TINY_B64 = Buffer.from([0]).toString('base64');

// Two-file wire payload for multi-file tests
function makeFiles(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    base64:   TINY_B64,
    filename: 'file' + (i + 1) + '.txt',
    mimeType: 'text/plain',
    size:     1,
  }));
}

// ---------------------------------------------------------------------------
// Browser mock helpers (mirrors upload-image.test.js)
// ---------------------------------------------------------------------------

function makeElementProxy(el) {
  return new Proxy(el, {
    set(target, prop, value) {
      if (prop === 'files') return true;
      target[prop] = value;
      return true;
    },
  });
}

function makeDomBrowserMock() {
  const DataTransferPolyfill = globalThis.DataTransfer || class DataTransfer {
    constructor() {
      this._files = [];
      this.items = { add: (file) => { this._files.push(file); } };
      this.files = this._files;
    }
  };

  const docProxy = new Proxy(globalThis.document, {
    get(target, prop) {
      if (prop === 'querySelector') {
        return (selector) => {
          const el = target.querySelector(selector);
          return el ? makeElementProxy(el) : null;
        };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });

  return {
    tabs: {
      executeScript: jest.fn(async (_tabId, { code }) => {
        const sandbox = {
          document:     docProxy,
          Uint8Array:   globalThis.Uint8Array,
          Blob:         globalThis.Blob,
          File:         globalThis.File,
          DataTransfer: DataTransferPolyfill,
          Event:        globalThis.Event,
          atob:         globalThis.atob,
          CSS:          globalThis.CSS || {
            escape: (s) => String(s).replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&')
                                    .replace(/^\d/, '\\3$& '),
          },
        };
        return [vm.runInNewContext(code, sandbox)];
      }),
      onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
    },
    alarms: {
      create: jest.fn(), clear: jest.fn(),
      get: jest.fn(() => Promise.resolve(undefined)),
      onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
    },
    storage: {
      session: {
        get:    jest.fn(() => Promise.resolve({})),
        set:    jest.fn(() => Promise.resolve()),
        remove: jest.fn(() => Promise.resolve()),
      },
    },
  };
}

function makeMockBrowser(opts = {}) {
  const { scriptResult = null, scriptError = null } = opts;
  return {
    tabs: {
      executeScript: jest.fn(async () => {
        if (scriptError) throw scriptError;
        return scriptResult;
      }),
      onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
    },
  };
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadFileUpload({ browser, resolveTab = jest.fn(async (id) => id ?? 1) }) {
  globalThis.browser = browser;
  globalThis.resolveTab = resolveTab;

  jest.isolateModules(() => {
    require('../../ClaudeInSafari Extension/Resources/tools/tool-registry.js');
  });

  let handler = null;
  globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

  jest.isolateModules(() => {
    require('../../ClaudeInSafari Extension/Resources/tools/file-upload.js');
  });

  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('file_upload tool', () => {
  afterEach(() => {
    jest.resetModules();
    delete globalThis.browser;
    delete globalThis.resolveTab;
    delete globalThis.registerTool;
    delete globalThis.classifyExecuteScriptError;
    delete globalThis.executeScriptWithTabGuard;
    delete globalThis.executeTool;
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  // T1 — single file upload
  test('T1: single file + ref to file input returns success with filename and size', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-1');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: makeFiles(1), ref: 'ref-1' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/file1\.txt/);
    expect(result.content[0].text).toMatch(/ref-1/);
  });

  // T2 — multiple files to <input multiple>
  test('T2: two files + multiple input returns multi-file success text', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('multiple', '');
    input.setAttribute('data-claude-ref', 'ref-multi');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: makeFiles(2), ref: 'ref-multi' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/2 files/);
    expect(result.content[0].text).toMatch(/file1\.txt/);
    expect(result.content[0].text).toMatch(/file2\.txt/);
  });

  // T3 — multiple files to non-multiple input
  test('T3: two files to non-multiple input returns isError', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-single');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: makeFiles(2), ref: 'ref-single' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/multiple/i);
  });

  // T7 — ref not found
  test('T7: ref not found on page returns isError', async () => {
    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: makeFiles(1), ref: 'missing-ref' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // T8 — ref points to non-file-input
  test('T8: ref pointing to a div returns isError', async () => {
    const div = document.createElement('div');
    div.setAttribute('data-claude-ref', 'ref-div');
    document.body.appendChild(div);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: makeFiles(1), ref: 'ref-div' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a file input/i);
  });

  // T10 — both change and input events dispatched
  test('T10: upload dispatches both change and input events', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-evt');
    document.body.appendChild(input);

    let changeCount = 0;
    let inputCount = 0;
    input.addEventListener('change', () => { changeCount++; });
    input.addEventListener('input',  () => { inputCount++;  });

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    await handler({ files: makeFiles(1), ref: 'ref-evt' });

    expect(changeCount).toBe(1);
    expect(inputCount).toBe(1);
  });

  // T11 — application/octet-stream mimeType
  test('T11: file with application/octet-stream mimeType does not error', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-wasm');
    document.body.appendChild(input);

    const wasmFile = [{ base64: TINY_B64, filename: 'module.wasm', mimeType: 'application/octet-stream', size: 1 }];
    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: wasmFile, ref: 'ref-wasm' });

    expect(result.isError).toBeFalsy();
  });

  // T13 — accept attribute mismatch produces warning, not error
  test('T13: accept mismatch appends warning to success text', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('accept', '.pdf');
    input.setAttribute('data-claude-ref', 'ref-accept');
    document.body.appendChild(input);

    const pngFile = [{ base64: TINY_B64, filename: 'photo.png', mimeType: 'image/png', size: 1 }];
    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: pngFile, ref: 'ref-accept' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Warning/i);
    expect(result.content[0].text).toMatch(/\.pdf/);
  });

  // T15 — ref missing
  test('T15: missing ref returns isError before executeScript', async () => {
    const handler = loadFileUpload({ browser: makeMockBrowser() });
    const result = await handler({ files: makeFiles(1) });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ref/i);
  });

  // T16 — files payload missing
  test('T16: missing files payload returns isError', async () => {
    const handler = loadFileUpload({ browser: makeMockBrowser() });
    const result = await handler({ ref: 'r' });

    expect(result.isError).toBe(true);
  });

  // T12 — resolveTab returns null
  test('T12: resolveTab returning null returns isError', async () => {
    const handler = loadFileUpload({
      browser: makeMockBrowser(),
      resolveTab: jest.fn(async () => null),
    });
    const result = await handler({ files: makeFiles(1), ref: 'r' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot access tab/i);
  });

  // T17 — tab closed mid-execution
  test('T17: tab-closed error re-throws without classification', async () => {
    const handler = loadFileUpload({ browser: makeMockBrowser() });
    globalThis.executeScriptWithTabGuard = jest.fn(async () => {
      throw new Error('Tab was closed during executeScript');
    });
    await expect(
      handler({ files: makeFiles(1), ref: 'r' })
    ).rejects.toThrow(/was closed during/i);
  });

  // T18 — invalid base64 in files payload
  test('T18: invalid base64 returns isError from injected IIFE', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-bad64');
    document.body.appendChild(input);

    const badFile = [{ base64: 'not!!valid$$base64', filename: 'bad.txt', mimeType: 'text/plain', size: 0 }];
    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const result = await handler({ files: badFile, ref: 'ref-bad64' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/decode/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```fish
npm test -- --testPathPattern="file-upload" 2>&1 | tail -20
```

Expected: `Cannot find module '...file-upload.js'`.

- [ ] **Step 3: Implement file-upload.js**

Create `ClaudeInSafari Extension/Resources/tools/file-upload.js`:

```js
/**
 * file_upload tool — uploads local files from the filesystem to a <input type="file">
 * element on the page.
 *
 * files (array of {base64, filename, mimeType, size}) is injected by ToolRouter before
 * forwarding — no native sub-request is required. See Spec 019.
 */
(function () {
  'use strict';

  /**
   * Injected into the page via executeScript.
   * Runs in the page's JavaScript context — no access to browser extension APIs or globalThis.
   * Receives a plain-object args payload — no closures, no external refs.
   * Returns a tool result object: { content } or { isError, content }.
   */
  function injectedFileUpload({ files, ref }) {
    function makeFile(base64, filename, mimeType) {
      try {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: mimeType });
        return new File([blob], filename, { type: mimeType, lastModified: Date.now() });
      } catch (e) {
        return null;
      }
    }

    function err(text) {
      return { isError: true, content: [{ type: 'text', text }] };
    }

    function formatSize(bytes) {
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      if (bytes >= 1024)        return Math.round(bytes / 1024) + ' KB';
      return bytes + ' B';
    }

    function checkAccept(el, builtFiles) {
      const accept = el.getAttribute('accept');
      if (!accept) return null;
      const acceptList = accept.split(',').map(function (s) { return s.trim().toLowerCase(); });
      for (var i = 0; i < builtFiles.length; i++) {
        var f = builtFiles[i];
        var ext = '.' + f.name.split('.').pop().toLowerCase();
        var mime = f.type.toLowerCase();
        var matched = acceptList.some(function (a) {
          if (a === mime) return true;
          if (a === ext) return true;
          if (a.endsWith('/*') && mime.startsWith(a.slice(0, -2))) return true;
          return false;
        });
        if (!matched) {
          return 'Warning: file input accepts "' + accept + '" — ' + f.name + ' may be rejected by the page';
        }
      }
      return null;
    }

    // CSS.escape(ref) prevents selector injection via a crafted ref value.
    var el = document.querySelector('[data-claude-ref="' + CSS.escape(ref) + '"]');
    if (!el) return err("Element '" + ref + "' not found");
    if (el.tagName !== 'INPUT' || el.type !== 'file') return err('Element is not a file input');

    if (files.length > 1 && !el.hasAttribute('multiple')) {
      return err('File input does not support multiple files');
    }

    var dt = new DataTransfer();
    var builtFiles = [];
    for (var j = 0; j < files.length; j++) {
      var fd = files[j];
      var f = makeFile(fd.base64, fd.filename, fd.mimeType);
      if (!f) return err('Failed to decode file data: ' + fd.filename);
      dt.items.add(f);
      builtFiles.push(f);
    }

    el.files = dt.files;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    var warning = checkAccept(el, builtFiles);
    var text;
    if (files.length === 1) {
      text = 'Uploaded ' + files[0].filename + ' (' + formatSize(files[0].size) + ') to file input ' + ref;
    } else {
      var lines = files.map(function (fd) {
        return '  - ' + fd.filename + ' (' + formatSize(fd.size) + ')';
      }).join('\n');
      text = 'Uploaded ' + files.length + ' files to file input ' + ref + ':\n' + lines;
    }
    if (warning) text += '\n' + warning;

    return { content: [{ type: 'text', text: text }] };
  }

  globalThis.registerTool('file_upload', async function fileUpload(args) {
    const { files, ref, tabId } = args;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return { isError: true, content: [{ type: 'text', text: 'files payload missing or empty (internal error)' }] };
    }
    if (!ref) {
      return { isError: true, content: [{ type: 'text', text: 'ref parameter is required' }] };
    }

    const resolvedTabId = await globalThis.resolveTab(tabId);
    if (resolvedTabId === null || resolvedTabId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Cannot access tab ' + tabId }] };
    }

    // If the tab is removed mid-execution Safari may never settle the executeScript
    // promise, blocking the tool. executeScriptWithTabGuard provides an onRemoved
    // guard, settled-flag race prevention, and a 30s timeout (defined in
    // tool-registry.js executeScriptWithTabGuard).
    // @note MV2 non-persistent risk: see executeScriptWithTabGuard JSDoc in tool-registry.js
    // for background-page suspension caveats.
    let results;
    try {
      results = await globalThis.executeScriptWithTabGuard(
        resolvedTabId,
        '(' + injectedFileUpload.toString() + ')(' + JSON.stringify({ files, ref }) + ')',
        'file_upload'
      );
    } catch (err) {
      if (err && /was closed during/.test(err.message)) throw err;
      throw globalThis.classifyExecuteScriptError('file_upload', resolvedTabId, err);
    }

    const result = results && results[0];
    if (!result) {
      return { isError: true, content: [{ type: 'text', text: 'No result from injected script' }] };
    }
    return result;
  });
}());
```

- [ ] **Step 4: Run JS tests and confirm they pass**

```fish
npm test -- --testPathPattern="file-upload" 2>&1 | tail -20
```

Expected: all 13 tests pass, 0 failures.

- [ ] **Step 5: Run full JS test suite**

```fish
npm test
```

Expected: all existing tests plus the new 13 pass.

- [ ] **Step 6: Commit**

```fish
git add "ClaudeInSafari Extension/Resources/tools/file-upload.js" \
        Tests/JS/file-upload.test.js
git commit -m "feat(file-upload): implement file-upload.js extension handler with TDD"
```

---

## Chunk 4: Manifest + Regression Tests

### Task 5: Wire manifest and update regression tests

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/manifest.json`
- Modify: `ClaudeInSafari Extension/Resources/background.js` (load-order comment)
- Modify: `STRUCTURE.md` (add `file-upload.test.js` to JS test listing)
- Modify: `docs/regression-tests.md`

`file-upload.js` must appear in `manifest.json` before `background.js` but after all other tool files. Without this entry, Safari will never load the tool handler and all `file_upload` calls will return "Unknown tool".

- [ ] **Step 1: Update manifest.json**

In `ClaudeInSafari Extension/Resources/manifest.json`, add `"tools/file-upload.js"` to `background.scripts`, between `upload-image.js` and `background.js`:

```json
"background": {
    "scripts": [
        "tools/constants.js",
        "tools/tool-registry.js",
        "tools/tabs-manager.js",
        "tools/navigate.js",
        "tools/read-page.js",
        "tools/find.js",
        "tools/form-input.js",
        "tools/get-page-text.js",
        "tools/computer.js",
        "tools/javascript-tool.js",
        "tools/read-console.js",
        "tools/read-network.js",
        "tools/upload-image.js",
        "tools/file-upload.js",
        "background.js"
    ],
    "persistent": false
},
```

- [ ] **Step 1b: Update load-order comment in background.js**

In `ClaudeInSafari Extension/Resources/background.js`, update the numbered comment block to add entry 14 and renumber `background.js` to 15:

```js
 *  13. tools/upload-image.js   — registers upload_image
 *  14. tools/file-upload.js    — registers file_upload
 *  15. background.js           — this file; starts the poll loop
```

- [ ] **Step 1c: Update STRUCTURE.md**

In `STRUCTURE.md`, in the JS test directory listing (after the `network-monitor.test.js` line), add:

```
│           └── file-upload.test.js
```

(Replace the existing `└── network-monitor.test.js` with `├── network-monitor.test.js` and add `└── file-upload.test.js` below it.)

- [ ] **Step 2: Add Section 15 to docs/regression-tests.md**

Append to `docs/regression-tests.md`:

```markdown
---

## 15  File Upload

### 15.1  Fast-fail: missing paths

```fish
make send TOOL=file_upload ARGS='{"ref":"upload-test"}'
```

- [ ] Returns error "paths is required and must be a non-empty array"

### 15.2  Fast-fail: relative path

```fish
make send TOOL=file_upload ARGS='{"paths":["./relative.txt"],"ref":"upload-test"}'
```

- [ ] Returns error "Path must be absolute"

### 15.3  Fast-fail: non-existent file

```fish
make send TOOL=file_upload ARGS='{"paths":["/tmp/no-such-file.txt"],"ref":"upload-test"}'
```

- [ ] Returns error "File not found"

### 15.4  E2E — single file upload *(requires extension loaded)*

Open `http://localhost:8765/upload-test.html` (start `python3 -m http.server 8765 --directory /tmp` first), then:

```fish
echo "regression test content" > /tmp/regression-test.txt
make send TOOL=tabs_create_mcp ARGS='{}' # note the virtual tabId
make send TOOL=navigate ARGS='{"url":"http://localhost:8765/upload-test.html","tabId":<tabId>}'
make send TOOL=read_page ARGS='{"tabId":<tabId>}'
# Note ref_id of the file input
make send TOOL=file_upload ARGS='{"paths":["/tmp/regression-test.txt"],"ref":"upload-test","tabId":<tabId>}'
```

- [ ] Returns "Uploaded regression-test.txt (...) to file input upload-test"
- [ ] Status div on page shows "File selected: regression-test.txt"
```

Also update the Checklist Summary at the end of the file to add:

```
- [ ] 15. File upload: fast-fail paths, E2E single file
```

- [ ] **Step 3: Run all tests one final time**

```fish
make test-all
```

Expected: all JS tests pass (including the 13 new file-upload tests), all Swift tests pass.

Also run the injected-script validator:

```fish
node scripts/validate-injected-scripts.js
```

Expected: all tool files pass syntax validation.

- [ ] **Step 4: Commit**

```fish
git add "ClaudeInSafari Extension/Resources/manifest.json" \
        docs/regression-tests.md
git commit -m "feat(file-upload): add to manifest background.scripts, add regression tests section 15"
```

---

## Final Step: PR

After all 4 tasks are committed and `make test-all` is green:

```fish
git push origin feature/file-upload
```

Then open a PR against `main`. The PR description must include the regression test checklist from `docs/regression-tests.md` Section 15, per PRINCIPLES.md Rule 8.
