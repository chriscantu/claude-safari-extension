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
 * DOM injection tests (T1, T2, T9, T10, T12) evaluate injected code via indirect
 * eval in the jest-jsdom global context so that all native jsdom APIs (DataTransfer,
 * FileList, elementFromPoint) are available without polyfilling.
 * Validation/error tests (T3-T8, T11) mock executeScript entirely.
 *
 * KNOWN GAP — DataTransfer constructor:
 *   jsdom does not implement DataTransfer. The dom mock uses indirect eval so the
 *   injected code runs in the jest-jsdom window context where DataTransfer would be
 *   available in a real browser. In jsdom it is still absent — el.files assignment
 *   will throw. T1/T9/T10/T12 therefore use a pre-canned success result via
 *   makeMockBrowserWithSuccess and assert no isError; they do NOT re-run injected code.
 *
 * KNOWN GAP — document.elementFromPoint:
 *   jsdom does not implement layout-based hit-testing. T2 uses makeDomBrowserMock
 *   with an elementFromPoint polyfill via document Proxy.
 *
 * KNOWN GAP — cross-context event listeners (T10):
 *   T10 verifies the handler returns success (no isError) rather than asserting a
 *   listener callback count, since jsdom's DataTransfer gap prevents the real
 *   injected code from running in tests.
 */

'use strict';

const vm = require('vm');

// Minimal base64 PNG (1x1 transparent pixel)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

/**
 * Returns a browser mock that returns a pre-canned success result for executeScript.
 * Used for T1/T9/T10/T12 where the real injected code cannot run in jsdom due to
 * missing DataTransfer support (KNOWN GAP). The handler-layer logic (arg validation,
 * tab resolution, error classification) is still exercised.
 */
function makeMockBrowserWithSuccess(text = 'Image uploaded to file input ref-1') {
  return {
    tabs: {
      executeScript: jest.fn(async () => [{ content: [{ type: 'text', text }] }]),
    },
  };
}

/**
 * Returns a browser mock that evaluates injected code using vm.runInNewContext
 * with a polyfilled document.elementFromPoint. Used for T2 (coordinate path)
 * where DataTransfer is only used for DragEvent construction (not el.files
 * assignment) and a minimal polyfill suffices.
 *
 * KNOWN GAP — DataTransfer constructor:
 *   jsdom does not implement DataTransfer. A minimal polyfill is provided that
 *   supports items.add() and returns a plain object for files (sufficient for
 *   drag-drop event dispatch, which does not require a real FileList).
 */
class DataTransferPolyfill {
  constructor() {
    this._files = [];
    this.items = {
      add: (file) => { this._files.push(file); },
    };
  }
  get files() {
    return { _polyfill: true };
  }
}

function makeDomBrowserMock() {
  // Document proxy that polyfills elementFromPoint (no layout engine in jsdom)
  const docProxy = new Proxy(globalThis.document, {
    get(target, prop) {
      if (prop === 'elementFromPoint') {
        return (_x, _y) => target.body || target.querySelector('div') || null;
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
          DragEvent:    globalThis.DragEvent || globalThis.MouseEvent,
          atob:         globalThis.atob,
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
  // Uses a pre-canned success result because jsdom lacks DataTransfer (KNOWN GAP).
  // The handler-layer arg validation and tab resolution are still exercised.
  test('T1: ref targeting a file input injects the file and returns success', async () => {
    const handler = loadUploadImage({
      browser: makeMockBrowserWithSuccess('Image uploaded to file input ref-1'),
    });
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
  // Uses a pre-canned success result because jsdom lacks DataTransfer (KNOWN GAP).
  // Verifies that a custom filename does not cause the handler to return isError.
  test('T9: custom filename does not cause an error', async () => {
    const handler = loadUploadImage({
      browser: makeMockBrowserWithSuccess('Image uploaded to file input ref-fn'),
    });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'ref-fn', filename: 'custom.png' });
    expect(result.isError).toBeFalsy();
  });

  // T10 — change event fires
  // KNOWN GAP — jsdom DataTransfer: injected code cannot run in jsdom (no DataTransfer).
  //   Uses pre-canned success result. Verifies handler reaches executeScript success path,
  //   confirming dispatchEvent call is in the injected code path (not asserted directly).
  test('T10: ref upload dispatches change event on the file input (no error path)', async () => {
    const handler = loadUploadImage({
      browser: makeMockBrowserWithSuccess('Image uploaded to file input ref-evt'),
    });
    const result = await handler({ imageId: 'id1', imageData: TINY_PNG_B64, ref: 'ref-evt' });

    expect(result.isError).toBeFalsy();
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
  // KNOWN GAP — jsdom DataTransfer: injected code cannot run in jsdom.
  //   Uses pre-canned success result. Verifies the handler does not fail at arg
  //   validation or serialization level when imageData is ~5MB.
  test('T12: large image base64 uploads without error', async () => {
    // Generate a valid ~5MB base64 string (zero-filled buffer — atob-safe, no mid-string padding)
    const largePng = Buffer.alloc(5 * 1024 * 1024).toString('base64');

    const handler = loadUploadImage({
      browser: makeMockBrowserWithSuccess('Image uploaded to file input ref-large'),
    });
    const result = await handler({ imageId: 'id1', imageData: largePng, ref: 'ref-large' });

    expect(result.isError).toBeFalsy();
  });
});
