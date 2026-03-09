/**
 * Tests for tools/read_page.js
 *
 * Covers:
 *   T1  — happy path: accessibility tree returned successfully
 *   T2  — content script not loaded (function missing)
 *   T3  — content script returns an error
 *   T4  — executeScript rejects (permission / tab gone)
 *   T5  — null result from executeScript (no frames)
 *   T6  — args forwarded correctly (filter, depth, max_chars, ref_id)
 *   T7  — virtualTabId=null resolves to active tab via resolveTab
 *   T8  — virtualTabId provided resolves via resolveTab
 *   T9  — resolveTab rejects: error is wrapped with actionable guidance
 *   T10 — executeScript returns [null] (truthy array, falsy first element)
 *   T11 — handler called with no arguments (args || {} guard)
 *   T12 — viewport dimensions of 0 render as "0x0", not "?x?"
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTreeResult(overrides = {}) {
    return {
        pageContent: "main \"Welcome\" [ref_1]\n  heading \"Hello\" [ref_2]",
        viewport: { width: 1280, height: 800 },
        ...overrides,
    };
}

function makeBrowserMock(opts = {}) {
    const {
        scriptResult = [makeTreeResult()],
        scriptError = null,
    } = opts;

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

function loadReadPage({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    // registerTool captures the handler so we can call it directly
    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    // Load (isolate module state between tests)
    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/read-page.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("read_page tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
    });

    test("T1 — returns formatted accessibility tree on success", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock();
        const handler = loadReadPage({ browser, resolveTab });

        const result = await handler({ tabId: null });

        expect(result).toContain("Viewport: 1280x800");
        expect(result).toContain('main "Welcome"');
        expect(result).toContain('heading "Hello"');
    });

    test("T2 — throws when content script function is missing", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Accessibility tree content script not loaded. Try reloading the page.", pageContent: "", viewport: { width: 0, height: 0 } }],
        });
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow("Accessibility tree content script not loaded");
    });

    test("T3 — throws when content script returns an error field", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Output exceeds 50000 character limit (99999 characters). Try specifying a depth parameter.", pageContent: "", viewport: { width: 1280, height: 800 } }],
        });
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow("Output exceeds 50000 character limit");
    });

    test("T4 — throws when executeScript rejects with stale tab error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptError: new Error("No tab with id: 42") });
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow("no longer exists");
        await expect(handler({})).rejects.toThrow("tabs_context_mcp");
    });

    test("T4b — throws 'executeScript failed' for generic (non-tab) errors", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptError: new Error("Extension context invalidated") });
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow("executeScript failed");
    });

    test("T5 — throws when executeScript returns null/empty result", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: null });
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow("No result from accessibility tree script");
    });

    test("T6 — args are serialized safely and forwarded into executeScript code", async () => {
        // This test inspects the injected code string because the bridge between
        // the background tool handler and the content script is a serialized code
        // string — there is no other observable contract to test here without a
        // full browser environment. The assertions verify JSON-safe serialization.
        const resolveTab = jest.fn(async () => 99);
        const browser = makeBrowserMock();
        const handler = loadReadPage({ browser, resolveTab });

        await handler({
            filter: "interactive",
            depth: 5,
            max_chars: 10000,
            ref_id: "ref_7",
        });

        const call = browser.tabs.executeScript.mock.calls[0];
        expect(call[0]).toBe(99);
        const code = call[1].code;
        expect(code).toContain('"interactive"');
        expect(code).toContain("5");
        expect(code).toContain("10000");
        expect(code).toContain('"ref_7"');
    });

    test("T7 — tabId=null resolves to active tab via resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBeNull(); return 55; });
        const browser = makeBrowserMock();
        const handler = loadReadPage({ browser, resolveTab });

        await handler({ tabId: null });

        expect(resolveTab).toHaveBeenCalledWith(null);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(55, expect.any(Object));
    });

    test("T8 — virtualTabId provided is passed to resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBe(3); return 77; });
        const browser = makeBrowserMock();
        const handler = loadReadPage({ browser, resolveTab });

        await handler({ tabId: 3 });

        expect(resolveTab).toHaveBeenCalledWith(3);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(77, expect.any(Object));
    });

    test("T9 — resolveTab rejection is wrapped with an actionable error message", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("Tab not found: 5"); });
        const browser = makeBrowserMock();
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({ tabId: 5 })).rejects.toThrow("could not resolve tab");
        await expect(handler({ tabId: 5 })).rejects.toThrow("tabs_context_mcp");
    });

    test("T10 — throws when executeScript returns a truthy array with a null first element", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [null] });
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow("No result from accessibility tree script");
    });

    test("T11 — succeeds when called with no arguments (args || {} guard)", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock();
        const handler = loadReadPage({ browser, resolveTab });

        await expect(handler()).resolves.toContain("Viewport:");
    });

    test("T12 — viewport dimensions of 0 render as '0x0', not '?x?'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [makeTreeResult({ viewport: { width: 0, height: 0 } })],
        });
        const handler = loadReadPage({ browser, resolveTab });

        const result = await handler({});
        expect(result).toContain("Viewport: 0x0");
    });

    test("registers itself under the name 'read_page'", () => {
        const resolveTab = jest.fn(async () => 1);
        const browser = makeBrowserMock();
        loadReadPage({ browser, resolveTab });

        expect(globalThis.registerTool).toHaveBeenCalledWith("read_page", expect.any(Function));
    });
});
