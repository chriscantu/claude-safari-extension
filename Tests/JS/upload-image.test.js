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
 * DOM injection tests (T1, T2, T9, T10, T12) evaluate injected code via
 * vm.runInNewContext so that the real injected IIFE runs and return values /
 * event dispatch can be verified.
 * Validation/error tests (T3-T8, T11) mock executeScript entirely.
 *
 * KNOWN GAP — DataTransfer.files assignment:
 *   jsdom does not propagate el.files = dt.files back to the input's FileList.
 *   T9 verifies no isError rather than asserting File.name directly.
 *   All other tests (T1, T2, T10, T12) use vm.runInNewContext and exercise
 *   the real injected IIFE, including event dispatch.
 *
 * KNOWN GAP — document.elementFromPoint:
 *   jsdom does not implement layout-based hit-testing. T2 uses makeDomBrowserMock
 *   with an elementFromPoint polyfill via document Proxy.
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
 * Wraps an element in a Proxy so that `el.files = value` is silently swallowed
 * (jsdom throws TypeError when assigning a non-FileList to el.files).
 * All other property accesses and dispatchEvent calls pass through to the real element.
 */
function makeElementProxy(el) {
  return new Proxy(el, {
    set(target, prop, value) {
      if (prop === 'files') return true; // silent no-op
      target[prop] = value;
      return true;
    },
  });
}

/**
 * Returns a browser mock that evaluates injected code using vm.runInNewContext
 * with a DataTransfer polyfill and an elementFromPoint polyfill.
 * Used for T1, T2, T9, T10, T12 (DOM injection path) and T4, T5 (error path).
 *
 * DataTransfer polyfill note:
 *   jsdom does not implement DataTransfer. The polyfill supports items.add() so
 *   the injected IIFE does not throw. el.files = dt.files is intercepted by
 *   makeElementProxy and silently swallowed — the IIFE continues to dispatchEvent,
 *   which reaches outer jsdom listeners correctly.
 */
function makeDomBrowserMock() {
  // Minimal DataTransfer polyfill for jsdom — allows the injected IIFE to proceed
  // without throwing. `el.files = dt.files` won't update the real FileList (jsdom
  // limitation), but event dispatch and return values work correctly.
  const DataTransferPolyfill = globalThis.DataTransfer || class DataTransfer {
    constructor() {
      this._files = [];
      this.items = { add: (file) => { this._files.push(file); } };
      this.files = this._files;
    }
  };

  // Document proxy that:
  //   - polyfills elementFromPoint (no layout engine in jsdom)
  //   - wraps querySelector results with makeElementProxy so el.files assignment
  //     is silently swallowed instead of throwing
  const docProxy = new Proxy(globalThis.document, {
    get(target, prop) {
      if (prop === 'elementFromPoint') {
        return (_x, _y) => {
          const found = target.body || target.querySelector('div') || null;
          return found ? makeElementProxy(found) : null;
        };
      }
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

  // T1 — ref: file input — image injected, return value verified via vm.runInNewContext
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
  // Uses vm.runInNewContext. jsdom does not propagate el.files = dt.files back to the
  // input's FileList (KNOWN GAP), so File.name cannot be asserted directly.
  // Verifies that a custom filename does not cause the handler to return isError.
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
  // Uses vm.runInNewContext. Verifies the injected IIFE handles a ~5MB base64 payload
  // without throwing at the atob/Uint8Array/Blob/File construction level.
  test('T12: large image base64 uploads without error', async () => {
    // Generate a valid ~5MB base64 string (zero-filled buffer — atob-safe, no mid-string padding)
    const largePng = Buffer.alloc(5 * 1024 * 1024).toString('base64');

    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-claude-ref', 'ref-large');
    document.body.appendChild(input);

    const handler = loadUploadImage({ browser: makeDomBrowserMock() });
    const result = await handler({ imageId: 'id1', imageData: largePng, ref: 'ref-large' });

    expect(result.isError).toBeFalsy();
  });
});
