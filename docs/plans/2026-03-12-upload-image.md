# upload_image Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `upload_image` MCP tool so Claude can inject a previously-captured screenshot into a page's file input or drag-and-drop target.

**Architecture:** Option B — `ToolRouter` intercepts `upload_image` natively, retrieves the PNG from `ScreenshotService`'s in-memory store, base64-encodes it, and injects it as `imageData` into the forwarded args. The extension handler (`upload-image.js`) reads `imageData` directly from args — no sub-request IPC required. The `ref` path sets a file input's `files` property via `DataTransfer`; the `coordinate` path dispatches synthetic drag events at the target point.

**Tech Stack:** Swift (ToolRouter, ScreenshotService), JavaScript (MV2 extension tool), Jest + jsdom (JS tests), XCTest (Swift tests), xcodebuild.

---

## Chunk 1: Spec update + ToolRouter native interception

### Task 1: Update Spec 018 to reflect Option B

**Files:**
- Modify: `Specs/018-upload-image.md`

- [ ] **Step 1: Replace the Image Retrieval section**

In `Specs/018-upload-image.md`, replace the **Image Retrieval** section (lines 43-47) with:

```markdown
### Image Retrieval (Option B - ToolRouter injection)

`ToolRouter` intercepts `upload_image` calls before they reach the extension:

1. Validates `imageId` is present; returns error immediately if missing.
2. Calls `screenshotService.retrieveImage(imageId:)` — O(1) in-memory lookup under `NSLock`.
3. If not found (evicted by LRU or never captured), returns error immediately — no queue write.
4. Base64-encodes the PNG data and injects it as `imageData` into the forwarded args dict.
5. Forwards the enriched args to the extension via `forwardToExtension` (standard file queue).

The extension handler reads `imageData` from args directly — no sub-request IPC.

Flow:
  CLI -> socket -> ToolRouter.handleUploadImage
      -> screenshotService.retrieveImage(imageId)   (~0ms in-memory)
      -> inject imageData into args
      -> forwardToExtension (file queue)
      -> extension upload-image.js
      -> browser.tabs.executeScript (injected IIFE)
      -> response file -> ToolRouter -> CLI
```

- [ ] **Step 2: Verify `coordinate` is already present in the Tool Arguments section**

`coordinate?: [number, number]` already exists in the spec. No edit needed — just confirm it is present and move on.

- [ ] **Step 3: Expand drag-drop event sequence to include dragstart/dragend**

Replace the coordinate approach step 3 AND the trailing prose sentence "The target element's drop handler receives the file." with:

```markdown
3. Create a `DataTransfer` with the file and dispatch the full drag-drop sequence:
   - `dragstart` on the target element (source context, required by some implementations)
   - `dragenter` on the target element
   - `dragover` on the target element
   - `drop` on the target element with `dataTransfer.files` set
   - `dragend` on the target element

   Safari note: Programmatic dragstart/dragend may be ignored by sites that validate
   isTrusted. The drop event with dataTransfer.files set is the critical one; others
   are best-effort. Sites that check isTrusted will require real user interaction.
```

- [ ] **Step 4: Commit**

```bash
git add Specs/018-upload-image.md
git commit -m "docs(spec-018): update upload_image spec for Option B architecture"
```

---

### Task 2: ToolRouter — native interception of upload_image

**Files:**
- Modify: `ClaudeInSafari/MCP/ToolRouter.swift`
- Modify: `Tests/Swift/ToolRouterTests.swift`

- [ ] **Step 1: Write failing Swift tests**

Open `Tests/Swift/ToolRouterTests.swift`. Check whether `MockMCPSocketServer` already exists. If it does not, add this helper class before `final class ToolRouterTests`:

```swift
private class MockMCPSocketServer: MCPSocketServer {
    // MCPSocketServer.init requires a MessageFramer (a zero-arg struct).
    // `send` must use `override` — base class method is `internal`.
    init() { super.init(framer: MessageFramer()) }
    private(set) var sentData: [Data] = []
    override func send(data: Data, to clientId: String) { sentData.append(data) }
    func lastSentJSON() -> [String: Any]? {
        guard let last = sentData.last else { return nil }
        return try? JSONSerialization.jsonObject(with: last) as? [String: Any]
    }
}
```

Then add a `// MARK: - Upload Image` section at the end of `ToolRouterTests`:

```swift
// MARK: - Upload Image (ToolRouter native interception)

func testHandleUploadImage_missingImageId_sendsError() {
    let mock = MockMCPSocketServer()
    router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService())
    router.setServer(mock)

    let data = try! JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": ["name": "upload_image", "arguments": ["ref": "abc"]]
    ])
    router.socketServer(mock, didReceiveMessage: data, from: "client1")

    let response = mock.lastSentJSON()
    XCTAssertNotNil(response?["error"], "Expected error response for missing imageId")
    let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
    XCTAssertTrue(msg.contains("imageId"), "Expected 'imageId' in error: \(msg)")
}

func testHandleUploadImage_unknownImageId_sendsError() {
    let mock = MockMCPSocketServer()
    router = ToolRouter(screenshotService: ScreenshotService(), gifService: GifService())
    router.setServer(mock)

    let data = try! JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "id": 2,
        "method": "tools/call",
        "params": ["name": "upload_image", "arguments": ["imageId": "no-such-id", "ref": "abc"]]
    ])
    router.socketServer(mock, didReceiveMessage: data, from: "client1")

    let response = mock.lastSentJSON()
    XCTAssertNotNil(response?["error"])
    let msg = (response?["error"] as? [String: Any])?["message"] as? String ?? ""
    XCTAssertTrue(msg.contains("no-such-id"), "Expected imageId in error: \(msg)")
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
xcodebuild test -scheme ClaudeInSafari -destination "platform=macOS" -only-testing:ClaudeInSafariTests/ToolRouterTests 2>&1 | tail -30
```

Expected: FAIL — `upload_image` is forwarded to the extension with no native interception yet, so the mock receives no synchronous error response.

- [ ] **Step 3: Add `handleUploadImage` to ToolRouter**

In `ClaudeInSafari/MCP/ToolRouter.swift`, add a branch in `handleToolCall` after the `gif_creator` branch (before `nativeTools.contains`):

```swift
} else if toolName == "upload_image" {
    handleUploadImage(arguments: arguments, id: id, clientId: clientId)
```

Add the method after `// MARK: - Native Window Resize`:

```swift
// MARK: - Native Upload Image

private func handleUploadImage(arguments: [String: Any], id: Any?, clientId: String) {
    guard let imageId = arguments["imageId"] as? String, !imageId.isEmpty else {
        sendError(id: id, code: -32000, message: "imageId parameter is required", to: clientId)
        return
    }
    guard let captured = screenshotService.retrieveImage(imageId: imageId) else {
        sendError(id: id, code: -32000, message: "Image not found: \(imageId)", to: clientId)
        return
    }
    let base64 = captured.data.base64EncodedString()
    var enrichedArgs = arguments
    enrichedArgs["imageData"] = base64
    let queued = QueuedToolRequest(
        requestId: UUID().uuidString,
        tool: "upload_image",
        args: enrichedArgs.mapValues { AnyCodable($0) },
        context: NativeMessageContext(clientId: clientId, tabGroupId: nil)
    )
    forwardToExtension(queued, id: id, clientId: clientId, arguments: enrichedArgs)
}
```

- [ ] **Step 4: Add `coordinate` to the upload_image tool definition**

Find the `upload_image` entry in `ToolRouter.toolDefinitions` and add the coordinate prop:

```swift
tool("upload_image", "Upload a previously captured screenshot to a file input or drag & drop target.", [
    "imageId":    prop("string", "ID of a previously captured screenshot"),
    "tabId":      prop("number", "Tab ID"),
    "ref":        prop("string", "Element reference ID for file inputs"),
    "coordinate": prop("array",  "Viewport [x, y] coordinates for drag-drop targets"),
    "filename":   prop("string", "Optional filename for the uploaded file")
]),
```

- [ ] **Step 5: Run Swift tests — confirm new tests pass**

```bash
xcodebuild test -scheme ClaudeInSafari -destination "platform=macOS" -only-testing:ClaudeInSafariTests/ToolRouterTests 2>&1 | tail -30
```

Expected: PASS for both new tests.

- [ ] **Step 6: Run full Swift test suite**

```bash
xcodebuild test -scheme ClaudeInSafari -destination "platform=macOS" 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add ClaudeInSafari/MCP/ToolRouter.swift Tests/Swift/ToolRouterTests.swift
git commit -m "feat(upload-image): ToolRouter native interception — inject imageData before forwarding"
```

---

## Chunk 2: Extension JS handler + tests

### Task 3: Implement upload-image.js

**Files:**
- Create: `ClaudeInSafari Extension/Resources/tools/upload-image.js`

- [ ] **Step 1: Create the tool handler**

```javascript
/**
 * upload_image tool — injects a previously captured screenshot into a page
 * element via file input assignment (ref) or synthetic drag-drop (coordinate).
 *
 * imageData (base64 PNG) is injected by ToolRouter before forwarding — no
 * native sub-request is required. See Spec 018 and docs/plans/2026-03-12-upload-image.md.
 */
(function () {
  'use strict';

  /**
   * Injected into the page via executeScript.
   * Receives a plain-object args payload — no closures, no external refs.
   * Returns a tool result object: { content } or { isError, content }.
   */
  function injectedUpload({ imageData, ref, coordinate, filename }) {
    function makeFile(base64, name) {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      return new File([blob], name, { type: 'image/png' });
    }

    function err(text) {
      return { isError: true, content: [{ type: 'text', text }] };
    }

    if (ref) {
      const el = document.querySelector('[data-claude-ref="' + ref + '"]');
      if (!el) return err("Element '" + ref + "' not found");
      if (el.tagName !== 'INPUT' || el.type !== 'file') return err('Element is not a file input');

      const file = makeFile(imageData, filename);
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { content: [{ type: 'text', text: 'Image uploaded to file input ' + ref }] };
    }

    // coordinate path
    const [x, y] = coordinate;
    const target = document.elementFromPoint(x, y);
    if (!target) return err('No element at (' + x + ', ' + y + ')');

    const file = makeFile(imageData, filename);
    const dt = new DataTransfer();
    dt.items.add(file);

    function dragEvent(type) {
      return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    }
    target.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragenter'));
    target.dispatchEvent(dragEvent('dragover'));
    target.dispatchEvent(dragEvent('drop'));
    target.dispatchEvent(dragEvent('dragend'));

    return { content: [{ type: 'text', text: 'Image uploaded via drag-drop at (' + x + ', ' + y + ')' }] };
  }

  globalThis.registerTool('upload_image', async function uploadImage(args) {
    const {
      imageId,
      imageData,
      ref,
      coordinate,
      tabId,
      filename = 'image.png'
    } = args;

    if (!imageId) {
      return { isError: true, content: [{ type: 'text', text: 'imageId parameter is required' }] };
    }
    if (!imageData) {
      return { isError: true, content: [{ type: 'text', text: 'Failed to retrieve image from native app' }] };
    }
    if (ref && coordinate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide either ref or coordinate, not both' }] };
    }
    if (!ref && !coordinate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide ref or coordinate' }] };
    }

    const resolvedTabId = await globalThis.resolveTab(tabId);
    if (resolvedTabId === null || resolvedTabId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Cannot access tab ' + tabId }] };
    }

    let result;
    try {
      const results = await browser.tabs.executeScript(resolvedTabId, {
        code: '(' + injectedUpload.toString() + ')(' + JSON.stringify({ imageData, ref, coordinate, filename }) + ')'
      });
      result = results && results[0];
    } catch (e) {
      const classified = globalThis.classifyExecuteScriptError
        ? globalThis.classifyExecuteScriptError(e)
        : e.message;
      return { isError: true, content: [{ type: 'text', text: classified }] };
    }

    if (!result) {
      return { isError: true, content: [{ type: 'text', text: 'No result from injected script' }] };
    }
    return result;
  });
}());
```

---

### Task 4: JS tests for upload-image.js

**Files:**
- Create: `Tests/JS/upload-image.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
/**
 * @jest-environment jsdom
 *
 * Tests for tools/upload-image.js
 * See Spec 018 (upload-image).
 *
 * T1  — ref: file input — image injected, change+input events fired
 * T2  — coordinate: drag-drop zone — drop event dispatched with file
 * T3  — imageData absent (native retrieval failed) — isError
 * T4  — ref not found on page — isError
 * T5  — ref points to non-file-input element — isError
 * T6  — both ref and coordinate — isError
 * T7  — neither ref nor coordinate — isError
 * T8  — imageId missing — isError
 * T9  — custom filename — File has correct name
 * T10 — ref upload triggers change event handler
 * T11 — tab not accessible (executeScript throws) — isError
 * T12 — large image base64 (~5MB) — uploads without error
 *
 * DOM injection tests (T1, T2, T9, T10, T12) use vm.runInNewContext against real jsdom.
 * Validation/error tests (T3-T8, T11) mock executeScript.
 *
 * KNOWN GAP — DataTransfer.files assignment:
 *   jsdom does not propagate el.files = dt.files back to the input reliably.
 *   T9 (filename assertion) is best-effort; the test verifies no isError instead.
 */

'use strict';

const vm = require('vm');

// Minimal base64 PNG (1x1 transparent pixel)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

function makeDomBrowserMock() {
  return {
    tabs: {
      executeScript: jest.fn(async (_tabId, { code }) => {
        const sandbox = {
          document:    globalThis.document,
          Uint8Array:  globalThis.Uint8Array,
          Blob:        globalThis.Blob,
          File:        globalThis.File,
          DataTransfer: globalThis.DataTransfer,
          Event:       globalThis.Event,
          DragEvent:   globalThis.DragEvent || globalThis.MouseEvent,
          atob:        globalThis.atob,
        };
        return [vm.runInNewContext(code, sandbox)];
      }),
    },
    alarms: {
      create: jest.fn(), clear: jest.fn(),
      get: jest.fn(() => Promise.resolve(undefined)),
      onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
    },
    storage: {
      session: {
        get: jest.fn(() => Promise.resolve({})),
        set: jest.fn(() => Promise.resolve()),
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
    },
  };
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadUploadImage({ browser, resolveTab = jest.fn(async (id) => id ?? 1) }) {
  globalThis.browser = browser;
  globalThis.resolveTab = resolveTab;

  jest.isolateModules(() => {
    require('../../ClaudeInSafari Extension/Resources/tools/tool-registry.js');
  });

  let handler = null;
  globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

  jest.isolateModules(() => {
    require('../../ClaudeInSafari Extension/Resources/tools/upload-image.js');
  });

  return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upload_image tool', () => {
  afterEach(() => {
    jest.resetModules();
    delete globalThis.browser;
    delete globalThis.resolveTab;
    delete globalThis.registerTool;
    delete globalThis.classifyExecuteScriptError;
    delete globalThis.executeTool;
    // Clear DOM nodes added during test
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  // T1 — ref: file input — image injected
  test('T1: ref targeting a file input injects the file and returns success', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-1');
    document.body.appendChild(input);

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'ref-1', filename: 'shot.png' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/ref-1/);
  });

  // T2 — coordinate: drag-drop — drop event dispatched
  test('T2: coordinate targeting dispatches drag-drop events and returns success', async () => {
    const div = document.createElement('div');
    document.body.appendChild(div);

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, coordinate: [10, 10] });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/drag-drop/);
  });

  // T3 — imageData absent
  test('T3: absent imageData returns isError', async () => {
    const handler = loadUploadImage({ browser: makeMockBrowser() });
    const result = await handler({ imageId: 'id1', ref: 'r' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/retrieve/i);
  });

  // T4 — ref not found
  test('T4: ref not found on page returns isError', async () => {
    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'missing-ref' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // T5 — ref points to non-file-input
  test('T5: ref targeting a non-file-input element returns isError', async () => {
    const div = document.createElement('div');
    div.setAttribute('data-claude-ref', 'ref-div');
    document.body.appendChild(div);

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'ref-div' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a file input/i);
  });

  // T6 — both ref and coordinate
  test('T6: providing both ref and coordinate returns isError', async () => {
    const handler = loadUploadImage({ browser: makeMockBrowser() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'r', coordinate: [10, 10] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not both/i);
  });

  // T7 — neither ref nor coordinate
  test('T7: providing neither ref nor coordinate returns isError', async () => {
    const handler = loadUploadImage({ browser: makeMockBrowser() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Provide ref or coordinate/i);
  });

  // T8 — imageId missing
  test('T8: missing imageId returns isError', async () => {
    const handler = loadUploadImage({ browser: makeMockBrowser() });
    const result = await handler({ ref: 'r' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/imageId/i);
  });

  // T9 — custom filename (best-effort in jsdom)
  test('T9: custom filename does not cause an error', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-fn');
    document.body.appendChild(input);

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'ref-fn', filename: 'custom.png' });
    expect(result.isError).toBeFalsy();
  });

  // T10 — change event fires
  test('T10: ref upload dispatches change event on the file input', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-evt');
    document.body.appendChild(input);

    let changeCount = 0;
    input.addEventListener('change', () => { changeCount++; });

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'ref-evt' });

    expect(changeCount).toBe(1);
  });

  // T11 — tab not accessible
  test('T11: executeScript throwing returns isError', async () => {
    const handler = loadUploadImage({
      browser: makeMockBrowser({ scriptError: new Error('Cannot access tab') }),
    });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'r' });
    expect(result.isError).toBe(true);
  });

  // T12 — large image
  test('T12: large image base64 uploads without error', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-large');
    document.body.appendChild(input);

    // Generate a valid ~5MB base64 string (zero-filled buffer — atob-safe, no mid-string padding)
    const largePng = Buffer.alloc(5 * 1024 * 1024).toString('base64');

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: largePng, ref: 'ref-large' });

    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/chris.cantu/repos/claude-safari-extension && npx jest Tests/JS/upload-image.test.js --no-coverage 2>&1 | tail -40
```

Expected: FAIL — `upload-image.js` does not exist yet.

- [ ] **Step 3: Create `upload-image.js` (from Task 3 Step 1) and run again**

```bash
cd /Users/chris.cantu/repos/claude-safari-extension && npx jest Tests/JS/upload-image.test.js --no-coverage 2>&1 | tail -40
```

Expected: All 12 tests pass. If T10 (change event) fails due to jsdom DataTransfer limitations, add a KNOWN GAP comment and update the test to assert `result.isError` is falsy instead.

- [ ] **Step 4: Commit**

```bash
git add "ClaudeInSafari Extension/Resources/tools/upload-image.js" Tests/JS/upload-image.test.js
git commit -m "feat(upload-image): extension handler + JS tests (T1-T12)"
```

---

## Chunk 3: Manifest wiring + verification

### Task 5: Wire upload-image.js into manifest and background.js

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/manifest.json`
- Modify: `ClaudeInSafari Extension/Resources/background.js`

- [ ] **Step 1: Add upload-image.js to manifest.json**

After `"tools/read-network.js"` (line 29), before `"background.js"`:

```json
"tools/read-network.js",
"tools/upload-image.js",
"background.js"
```

- [ ] **Step 2: Update load-order comment in background.js**

Add entry 13 to the load-order block (shift `background.js` to 14):

```
*  12. tools/read-network.js   -- registers read_network_requests
*  13. tools/upload-image.js   -- registers upload_image
*  14. background.js           -- this file; starts the poll loop
```

- [ ] **Step 3: Run full JS test suite**

```bash
cd /Users/chris.cantu/repos/claude-safari-extension && npx jest --no-coverage 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 4: Run full Swift test suite**

```bash
xcodebuild test -scheme ClaudeInSafari -destination "platform=macOS" 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add "ClaudeInSafari Extension/Resources/manifest.json" "ClaudeInSafari Extension/Resources/background.js"
git commit -m "chore(manifest): wire upload-image.js into background scripts (load order 13)"
```

---

### Task 6: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Build and launch**

```bash
make dev
```

- [ ] **Step 2: Capture a screenshot to get an imageId**

```bash
make send TOOL=computer ARGS='{"action":"screenshot"}'
```

Copy the `imageId` from the response text.

- [ ] **Step 3: Create a local test page and upload via ref**

`example.com` has no file inputs. Create a minimal test page first:

```bash
echo '<input type="file" data-claude-ref="file-1">' > /tmp/test-upload.html
make send TOOL=navigate ARGS='{"url":"file:///tmp/test-upload.html"}'
make send TOOL=upload_image ARGS='{"imageId":"<paste-id>","ref":"file-1"}'
```

Expected: `"Image uploaded to file input file-1"`

- [ ] **Step 4: Test fast-fail for unknown imageId**

```bash
make send TOOL=upload_image ARGS='{"imageId":"does-not-exist","ref":"any"}'
```

Expected: immediate error `"Image not found: does-not-exist"` — NOT a 30s timeout.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git log --oneline -6
```
