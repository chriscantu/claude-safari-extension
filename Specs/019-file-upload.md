# Spec 019 — file_upload

## Overview

`file_upload` uploads one or multiple files from the local filesystem to a `<input type="file">`
element on the page. Unlike clicking a file input (which opens a native file picker dialog
that automation cannot interact with), this tool directly sets the file input's value
programmatically.

This is a **hybrid tool**: the native Swift app reads the file(s) from disk, and the
extension injects them into the page's file input element.

## Scope

- Native: `ClaudeInSafari/Services/FileService.swift` (reads files from disk)
- Native: `ClaudeInSafari/MCP/ToolRouter.swift` (intercepts `file_upload`, calls FileService, injects wire payload)
- Background: `ClaudeInSafari Extension/Resources/tools/file-upload.js`
- Content: Injected into active tab via `browser.tabs.executeScript`
- Tool name: `"file_upload"`
- Entitlements: `ClaudeInSafari/ClaudeInSafari.entitlements` (temporary-exception read access)

## Tool Arguments

```ts
{
  paths: string[];  // Absolute paths to files on the local machine (required, non-empty)
  ref:   string;    // Element ref_id of the file input (required)
  tabId?: number;   // Virtual tab ID. Defaults to active tab.
}
```

## Implementation

### Phase 1: ToolRouter Intercept (Native App)

`ToolRouter.handleToolCall` intercepts `file_upload` before the extension queue:

```swift
} else if toolName == "file_upload" {
    handleFileUpload(arguments: arguments, id: id, clientId: clientId)
}
```

`handleFileUpload` follows the same shape as `handleUploadImage`:

1. Validate `paths` and `ref` are present and non-empty (return error immediately if not).
2. Delegate to `fileService.readFiles(paths:)`.
3. On failure, return the error immediately — no extension forwarding.
4. On success, build the wire payload (see Wire Format below), inject it as `"files"` into
   the forwarded args, then call `forwardToExtension` as usual.

`FileService` is injected into `ToolRouter` via the testable initialiser:

```swift
init(screenshotService: ScreenshotService, gifService: GifService, fileService: FileService) { … }
```

The production `convenience init()` creates `FileService()` with no arguments. The
`AppDelegate` and all `ToolRouterTests` that construct `ToolRouter` must be updated to
pass the third argument.

### Phase 2: File Reading (FileService)

`FileService.readFiles(paths: [String]) -> Result<[FileDescriptor], FileReadError>` validates
and reads all paths **fail-fast**: it stops at the first invalid or unreadable path and
returns that error without reading subsequent files.

Validation order per path (applied in this order):

1. Reject paths containing `..` components — `"Path must not contain '..' components: <path>"`.
2. Reject non-absolute paths (does not start with `/`) — `"Path must be absolute: <path>"`.
3. Symlinks — resolve via `URL.resolvingSymlinksInPath()` before further checks (transparent).
4. Check existence and readability — `"File not found: <path>"` / `"Cannot read file: <path>"`.
5. Check size ≤ 100 MB — `"File exceeds 100 MB limit: <path>"`.
6. Read contents into `Data`.
7. Determine MIME type (see MIME Type Detection below).

```swift
struct FileDescriptor {
    let filename: String   // Last path component (after symlink resolution)
    let mimeType: String
    let data: Data         // Raw file contents
    let size: Int          // Byte count (pre-base64)
}
```

### Wire Format (Native → Extension)

`ToolRouter.handleFileUpload` base64-encodes each file's `data` and injects a `"files"` key
into the args dict before forwarding:

```swift
// Injected key — matches what file-upload.js reads from args.files
enrichedArgs["files"] = descriptors.map { d in
    [
        "base64": d.data.base64EncodedString(),
        "filename": d.filename,
        "mimeType": d.mimeType,
        "size": d.size
    ]
}
```

`file-upload.js` reads from `args.files` (an array of `{base64, filename, mimeType, size}`
objects). The original `paths` and `ref` keys remain in args unchanged.

### Phase 3: File Injection (Extension — file-upload.js)

The extension handler (`globalThis.registerTool('file_upload', ...)`) follows the same
structure as `upload-image.js`:

1. Validate `args.files` is present and non-empty (guard clause — native should always
   inject it, but fail clearly if not).
2. Validate `args.ref` is present.
3. Resolve tab via `globalThis.resolveTab(tabId)`.
4. Call `globalThis.executeScriptWithTabGuard` with an injected IIFE.

The injected IIFE (`injectedFileUpload`) is self-contained (no closure refs, no extension
APIs). It receives `{ files, ref }` serialized via `JSON.stringify`.

Inside the IIFE:

1. Use `CSS.escape(ref)` in `querySelector('[data-claude-ref="..."]')` to prevent selector
   injection — the same pattern required in `upload-image.js`.
2. Verify the element is `<input type="file">`.
3. If `files.length > 1` and the input lacks the `multiple` attribute, return
   `isError: true`, `"File input does not support multiple files"`.
4. For each file descriptor, construct:
   ```js
   function makeFile(base64, filename, mimeType) {
     try {
       const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
       const blob = new Blob([bytes], { type: mimeType });
       return new File([blob], filename, { type: mimeType, lastModified: Date.now() });
     } catch (e) {
       return null;
     }
   }
   ```
   Return `isError: true`, `"Failed to decode file data: <filename>"` if `makeFile` returns null.
5. Add all `File` objects to a single `DataTransfer`.
6. Set `element.files = dataTransfer.files`.
7. Dispatch `input` then `change` events (`{ bubbles: true }`).
8. Check `accept` attribute (see Accept Validation below).
9. Return success text (see Return Value).

**Catch block** (mirrors `upload-image.js`):
```js
} catch (err) {
  if (err && /was closed during/.test(err.message)) throw err;
  throw globalThis.classifyExecuteScriptError('file_upload', resolvedTabId, err);
}
```

### Accept Attribute Validation

After a successful upload, if the input has an `accept` attribute, check each uploaded
file's MIME type and extension against the accept list. If any file does not match, append
a warning line to the success response text:

```
// Single file — no warning
"Uploaded report.pdf (340 KB) to file input upload-ref"

// Single file — accept mismatch warning
"Uploaded photo.png (56 KB) to file input upload-ref\nWarning: file input accepts \".pdf\" — photo.png may be rejected by the page"

// Multiple files — warning appended after the file list
"Uploaded 2 files to file input upload-ref:\n  - report.pdf (340 KB)\n  - photo.png (56 KB)\nWarning: file input accepts \".pdf\" — photo.png may be rejected by the page"
```

Do **not** return `isError: true` for accept mismatches.

### Multi-File Support

- Input has `multiple` attribute: all files are added.
- Input does **not** have `multiple` and `files.length > 1`: return
  `isError: true`, `"File input does not support multiple files"`.
  This check happens in the injected IIFE (after element resolution), not in `FileService`.

## Return Value

```ts
// Success — single file (no accept warning)
{
  content: [{ type: "text", text: "Uploaded <filename> (<size>) to file input <ref>" }]
}

// Success — multiple files (no accept warning)
{
  content: [{
    type: "text",
    text: "Uploaded <N> files to file input <ref>:\n  - <filename1> (<size1>)\n  - <filename2> (<size2>)"
  }]
}

// Success — with accept warning (single or multiple, warning appended)
{
  content: [{
    type: "text",
    text: "<success text>\nWarning: file input accepts \"<accept>\" — <filename> may be rejected by the page"
  }]
}
```

Size is human-readable (e.g., `"1.2 MB"`, `"340 KB"`, `"56 B"`). Computed in the
injected IIFE from the `size` field in the wire payload.

## Error Handling

| Condition | Where detected | Behavior |
|-----------|---------------|----------|
| `paths` missing or empty array | ToolRouter | `isError: true`, "paths is required and must be a non-empty array" |
| `ref` missing | ToolRouter | `isError: true`, "ref parameter is required" |
| Path contains `..` components | FileService | `isError: true`, "Path must not contain '..' components: `<path>`" |
| Path is not absolute | FileService | `isError: true`, "Path must be absolute: `<path>`" |
| File does not exist | FileService | `isError: true`, "File not found: `<path>`" |
| File is not readable | FileService | `isError: true`, "Cannot read file: `<path>`" |
| File too large (> 100 MB) | FileService | `isError: true`, "File exceeds 100 MB limit: `<path>`" |
| Failed to decode file data | Injected IIFE | `isError: true`, "Failed to decode file data: `<filename>`" |
| `ref` element not found | Injected IIFE | `isError: true`, "Element '`<ref>`' not found" |
| `ref` element is not a file input | Injected IIFE | `isError: true`, "Element is not a file input" |
| Multiple files to non-multiple input | Injected IIFE | `isError: true`, "File input does not support multiple files" |
| Tab not accessible | file-upload.js | `isError: true`, "Cannot access tab `<tabId>`" |
| Accept mismatch | Injected IIFE | Warning appended to success text (not an error) |

All path validation errors use **fail-fast**: `FileService.readFiles` stops and returns on
the first bad path.

## Safari Considerations

### ⚠ Safari Must Be Frontmost

The extension-side file injection via `browser.tabs.executeScript` requires Safari
to be the active application.

### Hybrid Native + Extension Architecture

```
MCP Client → ToolRouter.handleFileUpload
    → FileService.readFiles(paths)     (validates + reads all files)
    → inject enrichedArgs["files"]     (base64 wire payload)
    → forwardToExtension               (file queue → background.js)
    → file-upload.js                   (executeScriptWithTabGuard)
    → injected IIFE                    (DataTransfer → file input)
    → response file → ToolRouter → CLI
```

Chrome handles this entirely in its service worker (which can read files via the native
messaging host). Our split architecture adds:
- An extra serialization step (file → base64 → native message → extension).
- A file size concern: base64 encoding inflates data by ~33%. A 100 MB file becomes
  ~133 MB in transit through the native messaging bridge.

**Impact:** Uploads of large files are slower than Chrome due to the serialization
overhead. The 100 MB limit prevents excessive memory usage.

### ⚠ File Access Permissions

The native app needs file read access. Options:
1. **App Sandbox with user-selected read-write** — the app can read any file the user has
   explicitly selected. But MCP tool calls specify paths programmatically without user
   selection, so this doesn't work.
2. **Temporary exception entitlement** (recommended) —
   `com.apple.security.temporary-exception.files.absolute-path.read-only` with path `/`.
   Add to `ClaudeInSafari/ClaudeInSafari.entitlements`. Note: this entitlement is
   **not App Store-compatible** and will need to be revisited for Phase 7 distribution.
3. **Disable App Sandbox** — not feasible for Safari Web Extensions. The extension host
   app is subject to App Sandbox by default.

For initial implementation, option 2 is required.

### MIME Type Detection

`FileService.swift` uses `UTType` (Uniform Type Identifiers):

```swift
import UniformTypeIdentifiers

func mimeType(for path: String) -> String {
    let ext = (path as NSString).pathExtension
    if let utType = UTType(filenameExtension: ext) {
        return utType.preferredMIMEType ?? "application/octet-stream"
    }
    return "application/octet-stream"
}
```

Unknown extensions (e.g. `.wasm`) fall back to `"application/octet-stream"`.

### CSS.escape Requirement

The injected IIFE MUST use `CSS.escape(ref)` when building the `querySelector` selector
string, preventing selector injection via a crafted `ref` value:

```js
const el = document.querySelector('[data-claude-ref="' + CSS.escape(ref) + '"]');
```

`CSS.escape` is available in all Safari 16.4+ page contexts. No polyfill is required at
runtime, but the Jest vm sandbox for `file-upload.test.js` must include the same
`CSS.escape` polyfill added to `upload-image.test.js`.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Upload single file to file input | ✅ | ✅ | None |
| Upload multiple files | ✅ | ✅ | None |
| Absolute path resolution | ✅ | ✅ | None |
| MIME type detection | ✅ | ✅ | None |
| DataTransfer injection | ✅ | ✅ | None |
| change/input events dispatched | ✅ | ✅ | None |
| Works when browser in background | ✅ | ❌ | Safari must be frontmost |
| File reading | Native host direct | Hybrid (native + extension) | Extra serialization |
| Large file performance | Fast | Slower (base64 overhead) | ~33% overhead |
| File access permissions | Native host runs unsandboxed | App sandbox constraints | Needs entitlement |

## Test Cases

### JavaScript Tests (`Tests/JS/file-upload.test.js`)

| ID | Layer | Input | Expected Output |
|----|-------|-------|-----------------|
| T1 | IIFE | Single file descriptor + ref to `<input type="file">` | File uploaded, success text with name/size |
| T2 | IIFE | Two file descriptors + ref to `<input multiple>` | Both files uploaded, multi-file success text |
| T3 | IIFE | Two file descriptors + ref to input without `multiple` | `isError: true`, "File input does not support multiple files" |
| T7 | IIFE | `ref` not present in DOM | `isError: true`, "Element '...' not found" |
| T8 | IIFE | `ref` points to `<div>` (not file input) | `isError: true`, "Element is not a file input" |
| T10 | IIFE | Successful upload | Both `change` and `input` events fired with `bubbles: true` |
| T11 | IIFE | File with `mimeType: "application/octet-stream"` (`.wasm`) | File created with correct type |
| T13 | IIFE | Input with `accept=".pdf"`, uploading `.png` | Success text includes warning line |
| T15 | Handler | `args.ref` missing | `isError: true`, "ref parameter is required" |
| T16 | Handler | `args.files` missing | `isError: true` (internal guard) |
| T12 | Handler | `resolveTab` returns null | `isError: true`, "Cannot access tab ..." |

### Swift Tests (`Tests/Swift/FileServiceTests.swift`)

| ID | Layer | Input | Expected Output |
|----|-------|-------|-----------------|
| T4 | FileService | Path to non-existent file | `.failure`, "File not found" |
| T5 | FileService | Relative path `./file.txt` | `.failure`, "Path must be absolute" |
| T6 | FileService | Empty paths array | `.failure`, "paths is required..." |
| T9 | FileService | File > 100 MB | `.failure`, "File exceeds 100 MB limit" |
| T14_ref | FileService | `ref` missing — validated in ToolRouter before FileService is called | ToolRouter returns error directly |
| T_mimeType | FileService | Path with `.wasm` extension | `mimeType == "application/octet-stream"` |
| T_symlink | FileService | Symlinked path | Resolves to canonical path, reads successfully |
| T_dotdot | FileService | Path `"/tmp/../etc/passwd"` | `.failure`, "must not contain '..'" |

### Swift Tests (`Tests/Swift/ToolRouterTests.swift`)

| ID | Layer | Input | Expected |
|----|-------|-------|----------|
| T_router_missing_paths | ToolRouter | `file_upload` call, no `paths` arg | Error "paths is required" without reaching FileService |
| T_router_missing_ref | ToolRouter | `file_upload` call, `paths` present, no `ref` | Error "ref parameter is required" |
| T_router_happy | ToolRouter | Valid `paths` + `ref`, MockFileService returns descriptors | Reaches `forwardToExtension` (enriched args contain `"files"` key) |

### Regression Tests

Add Section 15 to `docs/regression-tests.md` covering:
- Single file upload to `<input type="file" data-claude-ref="upload-test">` (reuse `/tmp/upload-test.html`)
- Multiple files to a `multiple` input
- Fast-fail: non-existent path
- Fast-fail: relative path
