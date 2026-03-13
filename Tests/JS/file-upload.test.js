/**
 * @jest-environment jsdom
 *
 * Tests for tools/file-upload.js
 * See Spec 019 (file_upload).
 *
 * T1  — single file descriptor + ref to <input type="file"> — uploaded, success text with name/size
 * T2  — two file descriptors + ref to <input multiple> — both uploaded, multi-file success text
 * T3  — two file descriptors + ref to input without multiple — isError: multiple not supported
 * T7  — ref not present in DOM — isError: Element '...' not found
 * T8  — ref points to <div> (not file input) — isError: Element is not a file input
 * T10 — successful upload — both change and input events fired with bubbles: true
 * T11 — file with mimeType application/octet-stream (.wasm) — File created with correct type
 * T13 — input with accept=".pdf", uploading .png — success with warning line
 * T15 — args.ref missing — isError: ref parameter is required
 * T16 — args.files missing — isError (internal guard)
 * T12 — resolveTab returns null — isError: Cannot access tab
 * T_multiSize — humanReadableSize: 56 B, 340 KB, 1.2 MB
 * T_makeFileNull — bad base64 — isError: Failed to decode file data
 *
 * DOM injection tests (T1, T2, T3, T7, T8, T10, T11, T13, T_multiSize, T_makeFileNull)
 * evaluate injected code via makeDomBrowserMock so the real IIFE runs inside vm.
 * Handler-level tests (T12, T15, T16) mock globalThis directly.
 */

'use strict';

const vm = require('vm');
const path = require('path');
const fs = require('fs');

// CSS.escape polyfill — not provided by jsdom vm sandbox
if (!globalThis.CSS) globalThis.CSS = {};
if (!globalThis.CSS.escape) {
  globalThis.CSS.escape = (value) => {
    return String(value).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1')
      .replace(/^([0-9])/, '\\3$1 ');
  };
}

// Tiny plain text file base64 — "hello"
const TINY_TXT_B64 = btoa('hello'); // aGVsbG8=
const TINY_PDF_B64 = btoa('%PDF-1.0'); // base64 of a fake PDF header

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an element in a Proxy so that `el.files = value` is silently swallowed
 * (jsdom throws TypeError when assigning a non-FileList to el.files).
 * The getter for `files` returns a fake FileList whose length matches the
 * last assigned value, so Fix 3's `el.files.length !== fileObjects.length`
 * check does not trigger under normal operation.
 * All other property accesses and dispatchEvent calls pass through to the real element.
 */
function makeElementProxy(el) {
  let assignedFilesLength = null;
  return new Proxy(el, {
    set(target, prop, value) {
      if (prop === 'files') {
        // Record the length of the assigned FileList-like object
        assignedFilesLength = (value && typeof value.length === 'number') ? value.length : 0;
        return true; // silent no-op for actual DOM assignment
      }
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop === 'files' && assignedFilesLength !== null) {
        return { length: assignedFilesLength };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

/**
 * Returns a browser mock that evaluates injected code using vm.runInNewContext
 * with a DataTransfer polyfill.
 * Used for DOM injection tests (T1, T2, T3, T7, T8, T10, T11, T13, T_multiSize, T_makeFileNull).
 */
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
          Date:         globalThis.Date,
          CSS:          globalThis.CSS || { escape: (s) => String(s).replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&').replace(/^\d/, '\\3$& ') },
        };
        return [vm.runInNewContext(code, sandbox)];
      }),
      onRemoved: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
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

/**
 * Returns { src, sandbox, document } for testing the injectedFileUpload IIFE
 * directly via vm.runInNewContext, without going through the handler layer.
 * `src` is the injectedFileUpload function source string.
 * `sandbox` is a minimal context with DataTransfer, document, etc.
 */
function makeIIFESandbox() {
  const fileContent = fs.readFileSync(
    path.join(__dirname, '../../ClaudeInSafari Extension/Resources/tools/file-upload.js'),
    'utf8'
  );
  // Extract the injectedFileUpload function body from the source file
  const fnMatch = fileContent.match(/function injectedFileUpload[\s\S]*?(?=\n\s{2}globalThis\.registerTool)/);
  if (!fnMatch) throw new Error('Could not extract injectedFileUpload from source');
  const src = fnMatch[0].trimEnd();

  const DataTransferPolyfill = globalThis.DataTransfer || class DataTransfer {
    constructor() {
      this._files = [];
      this.items = { add: (file) => { this._files.push(file); } };
      this.files = this._files;
    }
  };

  const docRef = globalThis.document;
  const docProxy = new Proxy(docRef, {
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

  const sandbox = {
    document:     docProxy,
    Uint8Array:   globalThis.Uint8Array,
    Blob:         globalThis.Blob,
    File:         globalThis.File,
    DataTransfer: DataTransferPolyfill,
    Event:        globalThis.Event,
    atob:         globalThis.atob,
    Date:         globalThis.Date,
    CSS:          globalThis.CSS || { escape: (s) => String(s).replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&').replace(/^\d/, '\\3$& ') },
  };

  return { src, sandbox, document: docRef };
}

function makeMockBrowser(opts = {}) {
  const { scriptResult = null, scriptError = null } = opts;
  return {
    tabs: {
      executeScript: jest.fn(async () => {
        if (scriptError) throw scriptError;
        return scriptResult;
      }),
      onRemoved: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadFileUpload({ browser, resolveTab = jest.fn(async (id) => id ?? 1) }) {
  globalThis.browser = browser;
  globalThis.resolveTab = resolveTab;

  // Load tool-registry.js first — sets globalThis.classifyExecuteScriptError
  // and globalThis.executeScriptWithTabGuard.
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
    // Clear DOM nodes added during test
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  // T1 — single file + ref → success text with name/size
  test('T1: single file + ref → uploaded, success text contains name and size', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'upload-ref');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: TINY_TXT_B64, filename: 'hello.txt', mimeType: 'text/plain', size: 5 }];
    const result = await handler({ files, ref: 'upload-ref' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('hello.txt');
    expect(result.content[0].text).toContain('5 B');
    expect(result.content[0].text).toContain('upload-ref');
  });

  // T2 — two files + multiple input → multi-file success text
  test('T2: two files + multiple input → both uploaded, multi-file success text', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('data-claude-ref', 'multi-ref');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [
      { base64: TINY_TXT_B64, filename: 'a.txt', mimeType: 'text/plain', size: 5 },
      { base64: TINY_TXT_B64, filename: 'b.txt', mimeType: 'text/plain', size: 5 },
    ];
    const result = await handler({ files, ref: 'multi-ref' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('2 files');
    expect(result.content[0].text).toContain('a.txt');
    expect(result.content[0].text).toContain('b.txt');
  });

  // T3 — two files + non-multiple input → isError
  test('T3: two files + non-multiple input → isError: multiple not supported', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    // no multiple attribute
    input.setAttribute('data-claude-ref', 'single-ref');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [
      { base64: TINY_TXT_B64, filename: 'a.txt', mimeType: 'text/plain', size: 5 },
      { base64: TINY_TXT_B64, filename: 'b.txt', mimeType: 'text/plain', size: 5 },
    ];
    const result = await handler({ files, ref: 'single-ref' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('multiple');
  });

  // T7 — ref not in DOM → isError
  test('T7: ref not present in DOM → isError: not found', async () => {
    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: TINY_TXT_B64, filename: 'x.txt', mimeType: 'text/plain', size: 5 }];
    const result = await handler({ files, ref: 'no-such-ref' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(result.content[0].text).toContain('no-such-ref');
  });

  // T8 — ref points to div → isError: not a file input
  test('T8: ref pointing to a div returns isError: not a file input', async () => {
    const div = document.createElement('div');
    div.setAttribute('data-claude-ref', 'div-ref');
    document.body.appendChild(div);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: TINY_TXT_B64, filename: 'x.txt', mimeType: 'text/plain', size: 5 }];
    const result = await handler({ files, ref: 'div-ref' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a file input');
  });

  // T10 — successful upload fires input and change events
  test('T10: successful upload dispatches both input and change events', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-evt');
    document.body.appendChild(input);

    const firedBubbles = [];
    input.addEventListener('input', (e) => firedBubbles.push({ type: 'input', bubbles: e.bubbles }));
    input.addEventListener('change', (e) => firedBubbles.push({ type: 'change', bubbles: e.bubbles }));

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: TINY_TXT_B64, filename: 'test.txt', mimeType: 'text/plain', size: 5 }];
    await handler({ files, ref: 'ref-evt' });

    const inputEvent = firedBubbles.find(e => e.type === 'input');
    const changeEvent = firedBubbles.find(e => e.type === 'change');
    expect(inputEvent).toBeDefined();
    expect(inputEvent.bubbles).toBe(true);
    expect(changeEvent).toBeDefined();
    expect(changeEvent.bubbles).toBe(true);
  });

  // T11 — application/octet-stream MIME (.wasm) → success
  test('T11: application/octet-stream mimeType creates file correctly', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'wasm-ref');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: TINY_TXT_B64, filename: 'binary.wasm', mimeType: 'application/octet-stream', size: 5 }];
    const result = await handler({ files, ref: 'wasm-ref' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('binary.wasm');
  });

  // T13 — accept=".pdf" input, uploading .png → success with warning
  test('T13: accept attribute mismatch → success with warning appended', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.setAttribute('data-claude-ref', 'pdf-only');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: TINY_TXT_B64, filename: 'photo.png', mimeType: 'image/png', size: 5 }];
    const result = await handler({ files, ref: 'pdf-only' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Warning: file input accepts ".pdf"');
    expect(result.content[0].text).toContain('photo.png may be rejected by the page');
  });

  // Tool registration assertion
  it('registers tool as file_upload', () => {
    loadFileUpload({ browser: makeMockBrowser() });
    expect(globalThis.registerTool).toHaveBeenCalledWith('file_upload', expect.any(Function));
  });

  // T15 — handler: missing ref → isError
  test('T15: missing ref → isError: ref parameter is required', async () => {
    const handler = loadFileUpload({ browser: makeMockBrowser() });
    const files = [{ base64: TINY_TXT_B64, filename: 'x.txt', mimeType: 'text/plain', size: 5 }];
    const result = await handler({ files });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ref');
  });

  // T16 — handler: missing files → isError
  test('T16: missing files → isError', async () => {
    const handler = loadFileUpload({ browser: makeMockBrowser() });
    const result = await handler({ ref: 'upload-ref' });

    expect(result.isError).toBe(true);
  });

  // T12 — resolveTab returns null → isError: Cannot access tab
  test('T12: resolveTab returning null → isError: Cannot access tab', async () => {
    const handler = loadFileUpload({
      browser: makeMockBrowser(),
      resolveTab: jest.fn(async () => null),
    });
    const files = [{ base64: TINY_TXT_B64, filename: 'x.txt', mimeType: 'text/plain', size: 5 }];
    const result = await handler({ files, ref: 'r' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot access tab/i);
  });

  // T_multiSize — humanReadableSize: 56 B, 340 KB, 1.2 MB
  test('T_multiSize: size formatting: 56 B, 340 KB, 1.2 MB', async () => {
    // 56 bytes
    const input56 = document.createElement('input');
    input56.type = 'file';
    input56.setAttribute('data-claude-ref', 'size-56');
    document.body.appendChild(input56);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });

    const r56 = await handler({
      files: [{ base64: TINY_TXT_B64, filename: 'f.txt', mimeType: 'text/plain', size: 56 }],
      ref: 'size-56',
    });
    expect(r56.content[0].text).toContain('56 B');

    // 340 KB
    const input340 = document.createElement('input');
    input340.type = 'file';
    input340.setAttribute('data-claude-ref', 'size-340');
    document.body.appendChild(input340);

    const r340 = await handler({
      files: [{ base64: TINY_TXT_B64, filename: 'f.txt', mimeType: 'text/plain', size: 340 * 1024 }],
      ref: 'size-340',
    });
    expect(r340.content[0].text).toContain('340 KB');

    // 1.2 MB
    const input1m = document.createElement('input');
    input1m.type = 'file';
    input1m.setAttribute('data-claude-ref', 'size-1m');
    document.body.appendChild(input1m);

    const r1m = await handler({
      files: [{ base64: TINY_TXT_B64, filename: 'f.txt', mimeType: 'text/plain', size: Math.round(1.2 * 1024 * 1024) }],
      ref: 'size-1m',
    });
    expect(r1m.content[0].text).toContain('1.2 MB');
  });

  // T_makeFileNull — bad base64 → isError: Failed to decode file data
  test('T_makeFileNull: bad base64 → isError: Failed to decode file data', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'bad-ref');
    document.body.appendChild(input);

    const handler = loadFileUpload({ browser: makeDomBrowserMock() });
    const files = [{ base64: '!!!NOT_VALID_BASE64!!!', filename: 'bad.bin', mimeType: 'application/octet-stream', size: 0 }];
    const result = await handler({ files, ref: 'bad-ref' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to decode file data: bad\.bin/);
    expect(result.content[0].text).toContain('bad.bin');
  });

  // T_filesAssignment — FileList assignment rejected → isError
  it('T_filesAssignment — FileList assignment rejected returns error', () => {
    const { src, sandbox, document: doc } = makeIIFESandbox();
    // Override querySelector to return an input whose files.length stays 0
    // even after assignment (simulates a framework-controlled input rejecting FileList).
    const realQuerySelector = doc.querySelector.bind(doc);
    sandbox.document = new Proxy(doc, {
      get(target, prop) {
        if (prop === 'querySelector') {
          return (sel) => {
            const el = realQuerySelector(sel);
            if (!el) return null;
            // Swallow files setter and always return length 0 from getter
            return new Proxy(el, {
              set(t, p, v) {
                if (p === 'files') return true; // swallow — no assignment
                t[p] = v;
                return true;
              },
              get(t, p) {
                if (p === 'files') return { length: 0 };
                return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
              },
            });
          };
        }
        return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      },
    });

    const input = doc.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'upload-ref');
    doc.body.appendChild(input);

    const files = [{ base64: TINY_TXT_B64, filename: 'x.txt', mimeType: 'text/plain', size: 5 }];
    const result = vm.runInNewContext(
      '(' + src + ')(' + JSON.stringify({ files, ref: 'upload-ref' }) + ')',
      sandbox
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File assignment failed');
  });

  // T_dataTransferUnavailable — DataTransfer constructor throws → isError
  it('T_dataTransferUnavailable — DataTransfer constructor throws returns error', () => {
    const { src, sandbox } = makeIIFESandbox();
    // Override DataTransfer to throw
    sandbox.DataTransfer = function() { throw new TypeError('DataTransfer is not defined'); };

    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'upload-ref');
    document.body.appendChild(input);

    const files = [{ base64: TINY_TXT_B64, filename: 'x.txt', mimeType: 'text/plain', size: 5 }];
    const result = vm.runInNewContext(
      '(' + src + ')(' + JSON.stringify({ files, ref: 'upload-ref' }) + ')',
      sandbox
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DataTransfer');
  });
});
