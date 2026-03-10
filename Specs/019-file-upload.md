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
- Background: `ClaudeInSafari Extension/Resources/tools/file-upload.js`
- Content: Injected into active tab via `browser.tabs.executeScript`
- Tool name: `"file_upload"`

## Tool Arguments

```ts
{
  paths: string[];  // Absolute paths to files on the local machine (required, non-empty)
  ref:   string;    // Element ref_id of the file input (required)
  tabId?: number;   // Virtual tab ID. Defaults to active tab.
}
```

## Implementation

### Phase 1: File Reading (Native App)

1. `ToolRouter.swift` receives the `file_upload` request and forwards file-related work
   to `FileService.swift`.
2. `FileService` validates and reads each file path:
   a. Verify each path is an absolute path (starts with `/`).
   b. Verify each file exists and is readable.
   c. Read the file contents into `Data`.
   d. Determine the MIME type from the file extension (using `UTType`).
   e. Get the filename from the path.
3. `FileService` returns an array of file descriptors:
   ```swift
   struct FileDescriptor {
       let filename: String
       let mimeType: String
       let data: Data        // Raw file contents
       let size: Int
   }
   ```
4. The file data is base64-encoded and forwarded to the extension via native messaging.

### Phase 2: File Injection (Extension)

1. The extension receives the file descriptors (base64 data + metadata).
2. For each file, create a `File` object:
   ```js
   const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))],
                          { type: mimeType });
   const file = new File([blob], filename, { type: mimeType, lastModified: Date.now() });
   ```
3. Create a `DataTransfer` and add all files:
   ```js
   const dataTransfer = new DataTransfer();
   files.forEach(f => dataTransfer.items.add(f));
   ```
4. Resolve the target element by `ref` (`data-claude-ref`).
5. Verify it is an `<input type="file">`.
6. If the input has an `accept` attribute, validate that each file's MIME type or extension
   matches. Warn (but don't fail) if a file doesn't match.
7. Set `element.files = dataTransfer.files`.
8. Dispatch `change` and `input` events (bubbles: true).

### Multi-File Support

- If the file input has the `multiple` attribute: all files are added.
- If the file input does **not** have `multiple` and more than one path is provided:
  return `isError: true`, `"File input does not support multiple files"`.

## Return Value

```ts
// Success — single file
{
  content: [{
    type: "text",
    text: "Uploaded <filename> (<size>) to file input <ref>"
  }]
}

// Success — multiple files
{
  content: [{
    type: "text",
    text: "Uploaded <N> files to file input <ref>:\n  - <filename1> (<size1>)\n  - <filename2> (<size2>)"
  }]
}
```

Size is human-readable (e.g., "1.2 MB", "340 KB", "56 B").

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `paths` missing or empty array | `isError: true`, "paths is required and must be a non-empty array" |
| `ref` missing | `isError: true`, "ref parameter is required" |
| Path is not absolute | `isError: true`, "Path must be absolute: `<path>`" |
| File does not exist | `isError: true`, "File not found: `<path>`" |
| File is not readable | `isError: true`, "Cannot read file: `<path>`" |
| File too large (> 100 MB) | `isError: true`, "File exceeds 100 MB limit: `<path>`" |
| `ref` element not found | `isError: true`, "Element '`<ref>`' not found" |
| `ref` element is not a file input | `isError: true`, "Element is not a file input" |
| Multiple files to non-multiple input | `isError: true`, "File input does not support multiple files" |
| Tab not accessible | `isError: true`, "Cannot access tab `<tabId>`" |
| Path contains `..` components | `isError: true`, "Path must not contain '..' components: `<path>`" |
| Path is a symlink | Resolve to canonical path via `URL.resolvingSymlinksInPath()` before reading |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

The extension-side file injection via `browser.tabs.executeScript` requires Safari
to be the active application.

### Hybrid Native + Extension Architecture

This is the most architecturally complex tool because it spans both the native app and
the extension:

```
MCP Client → ToolRouter → FileService (read files)
    → base64 encode → native message → Extension (file-upload.js)
    → executeScript → content script → DataTransfer → file input
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
   This is the standard approach for developer tools that need unrestricted file read
   access. Add to the native app target's `.entitlements` file. Note: this entitlement is
   **not App Store-compatible** and will need to be revisited for Phase 7 distribution.
3. **Disable App Sandbox** — not feasible for Safari Web Extensions. The extension host
   app is subject to App Sandbox by default, and Apple's toolchain flags sandbox-disabled
   apps that embed Safari extensions.

For initial implementation, option 2 is required.

### MIME Type Detection

`FileService.swift` should use `UTType` (Uniform Type Identifiers) to determine MIME types:

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
| File access permissions | Native host runs unsandboxed | App sandbox constraints | May need entitlements |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | Single file path + ref to file input | File uploaded, confirmation with name/size |
| T2 | Multiple file paths + ref to `multiple` file input | All files uploaded |
| T3 | Multiple files to non-`multiple` input | `isError: true` |
| T4 | Non-existent file path | `isError: true`, file not found |
| T5 | Relative path (e.g., `./file.txt`) | `isError: true`, must be absolute |
| T6 | Empty paths array | `isError: true` |
| T7 | `ref` not found | `isError: true` |
| T8 | `ref` points to non-file-input | `isError: true` |
| T9 | File > 100 MB | `isError: true`, exceeds limit |
| T10 | Upload triggers `change` event | Event handler fires correctly |
| T11 | File with unusual MIME type (e.g., `.wasm`) | Uses `application/octet-stream` fallback |
| T12 | Tab not accessible | `isError: true` |
| T13 | File input with `accept=".pdf"` + upload `.png` | Uploads with warning (not error) |
| T14 | `ref` missing | `isError: true` |
