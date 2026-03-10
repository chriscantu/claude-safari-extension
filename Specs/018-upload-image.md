# Spec 018 — upload_image

## Overview

`upload_image` uploads a previously captured screenshot (from the `computer` tool's
`screenshot` action) or other stored image to a file input element or drag-and-drop target
on the page. It supports two targeting approaches: `ref` for element-based targeting
(especially hidden file inputs) and `coordinate` for drag-and-drop to visible locations.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/upload-image.js`
- Native: `ScreenshotService.swift` (stores captured images referenced by `imageId`)
- Content: Injected into active tab via `browser.tabs.executeScript`
- Tool name: `"upload_image"`

## Tool Arguments

```ts
{
  imageId:     string;            // ID of a previously captured screenshot (required)
  ref?:        string;            // Element ref_id for file inputs. Provide ref OR coordinate.
  coordinate?: [number, number];  // [x, y] viewport pixels for drag-drop. Provide ref OR coordinate.
  tabId?:      number;            // Virtual tab ID. Defaults to active tab.
  filename?:   string;            // Optional filename. Default: "image.png".
}
```

### Targeting Approaches

- **`ref`** — Target a specific element by its `data-claude-ref` ID. Best for `<input type="file">`
  elements, including hidden ones that can't be drag-dropped onto. The tool programmatically
  sets the file input's `files` property.
- **`coordinate`** — Target a visible location by viewport coordinates. Best for drag-and-drop
  zones (e.g., Google Docs, image editors). The tool dispatches drag-drop events at the
  specified point.

Exactly one of `ref` or `coordinate` must be provided.

## Implementation

### Image Retrieval

1. The native app's `ScreenshotService` stores captured images by `imageId` (Spec 011).
2. The tool handler requests the image data from the native app via native messaging.
3. The native app responds with the base64-encoded PNG data.
4. The extension converts it to a `Blob` → `File` object for injection.

### ref Approach (File Input)

1. Resolve the element by `data-claude-ref`.
2. Verify it is an `<input type="file">` (or has a `file` accept attribute).
3. Create a `File` object from the image data. **Do not use `fetch(data:...)` — this
   is blocked by Content Security Policy on many pages.** Use direct decoding:
   ```js
   const bytes = Uint8Array.from(atob(imageData), c => c.charCodeAt(0));
   const blob = new Blob([bytes], { type: "image/png" });
   const file = new File([blob], filename, { type: "image/png" });
   ```
4. Create a `DataTransfer` object and add the file:
   ```js
   const dataTransfer = new DataTransfer();
   dataTransfer.items.add(file);
   element.files = dataTransfer.files;
   ```
5. Dispatch `change` and `input` events on the file input.

### coordinate Approach (Drag and Drop)

1. Find the element at the target coordinates via `document.elementFromPoint(x, y)`.
2. Create a `File` object from the image data (same as above).
3. Create a `DataTransfer` with the file and dispatch the drag-drop event sequence:
   - `dragenter` on the target element
   - `dragover` on the target element
   - `drop` on the target element with `dataTransfer.files` set
4. The target element's drop handler receives the file.

## Return Value

```ts
// Success (ref)
{
  content: [{
    type: "text",
    text: "Image uploaded to file input <ref>"
  }]
}

// Success (coordinate)
{
  content: [{
    type: "text",
    text: "Image uploaded via drag-drop at (<x>, <y>)"
  }]
}
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `imageId` missing | `isError: true`, "imageId parameter is required" |
| Neither `ref` nor `coordinate` provided | `isError: true`, "Provide ref or coordinate" |
| Both `ref` and `coordinate` provided | `isError: true`, "Provide either ref or coordinate, not both" |
| `imageId` not found in storage | `isError: true`, "Image not found: `<imageId>`" |
| `ref` element not found | `isError: true`, "Element '`<ref>`' not found" |
| `ref` element is not a file input | `isError: true`, "Element is not a file input" |
| Drag-drop target not found at coordinates | `isError: true`, "No element at (`<x>`, `<y>`)" |
| Tab not accessible | `isError: true`, "Cannot access tab `<tabId>`" |
| Native app image retrieval fails | `isError: true`, "Failed to retrieve image from native app" |

## Safari Considerations

### ⚠ Safari Must Be Frontmost

The content script injection via `browser.tabs.executeScript` requires Safari to be
the active application.

### Hybrid Native + Extension Flow

Unlike Chrome (where screenshots are stored in the service worker's memory and accessed
directly), Safari's screenshots are stored in the **native app** (`ScreenshotService.swift`).
The upload flow requires an extra round-trip:

```
Extension (upload-image.js)
    → Native message: "get image <imageId>"
    → Native app (ScreenshotService)
    → Native message response: { base64: "...", format: "png" }
    → Extension injects File into page
```

**Impact:** Slightly slower than Chrome due to the native messaging round-trip (~10-50ms).
Functionally identical.

### DataTransfer Compatibility

Safari's `DataTransfer` constructor and `dataTransfer.items.add(file)` are supported in
Safari 14.1+. The `element.files = dataTransfer.files` setter for file inputs is supported
in Safari 15+. Both are well within the deployment target (Safari 16.4+).

### File Input Security

Safari enforces that `<input type="file">` can only have its `files` property set via
`DataTransfer`. Direct assignment of a `FileList` is blocked for security. The
`DataTransfer` approach in the implementation section is the correct workaround and works
in both Chrome and Safari.

## Chrome Parity Notes

| Feature | Chrome | Safari | Gap |
|---------|--------|--------|-----|
| Upload via ref (file input) | ✅ | ✅ | None |
| Upload via coordinate (drag-drop) | ✅ | ✅ | None |
| Reference previously captured screenshot | ✅ | ✅ | None |
| Custom filename | ✅ | ✅ | None |
| Works when browser in background | ✅ | ❌ | Safari must be frontmost |
| Image retrieval speed | In-process | Native round-trip | ~10-50ms slower |

## Test Cases

| ID | Input | Expected Output |
|----|-------|-----------------|
| T1 | `imageId` + `ref` pointing to file input | Image uploaded to file input |
| T2 | `imageId` + `coordinate` on drag-drop zone | Image dropped at coordinates |
| T3 | `imageId` not found | `isError: true` |
| T4 | `ref` not found on page | `isError: true` |
| T5 | `ref` points to non-file-input element | `isError: true` |
| T6 | Both `ref` and `coordinate` provided | `isError: true` |
| T7 | Neither `ref` nor `coordinate` | `isError: true` |
| T8 | `imageId` missing | `isError: true` |
| T9 | Custom `filename: "screenshot.png"` | File has correct name |
| T10 | Upload triggers `change` event on file input | Event handler fires |
| T11 | Tab not accessible | `isError: true` |
| T12 | Large image (5MB+) | Uploads successfully (no size limit) |
