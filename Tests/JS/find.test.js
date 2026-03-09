/**
 * Tests for tools/find.js
 * See Spec 006 (find).
 *
 * Covers:
 *   T1  — happy path: single match returned and formatted correctly
 *   T2  — no matches: "No elements found matching..." message
 *   T3  — over 20 matches: truncation note appended
 *   T4  — exactly 20 matches: no truncation note
 *   T5  — empty query string: throws "query must be a non-empty string"
 *   T6  — null/undefined query: throws
 *   T7  — tabId=null resolves to active tab via resolveTab
 *   T8  — virtualTabId provided: forwarded to resolveTab
 *   T9  — resolveTab rejects: error mentions tab id
 *   T10 — executeScript rejects (restricted URL): wrapped error
 *   T11 — executeScript rejects (stale tab): wrapped error mentioning tabs_context_mcp
 *   T12 — executeScript returns null/empty: throws
 *   T13 — match with null rect (hidden input): formatted without "at (...)"
 *   T14 — called with no arguments: throws on missing query
 *   T15 — registers itself under the name "find"
 *   T16 — single match uses "match" not "matches" (grammar)
 *   T17 — CSS.escape used for el.id in label selector (injection safety)
 *   T18 — "select" role keyword alias: injected code maps detectedRole "select" to combobox
 *   T19 — aria-labelledby multi-ID: injected code splits space-separated IDs
 *   T20 — whitespace-only query throws "query must be a non-empty string"
 *   T21 — injected code guards all five buckets with seen.has(el) check
 *   T22 — injected code excludes zero-size non-hidden elements
 *   T23 — executeScript returns [undefined]: throws no-result error
 *   T24 — IIFE __error response surfaces as "page script error"
 *   T25 — executeScript is called with runAt: "document_idle"
 *   T26 — injection safety: query JSON-serialized to prevent interpolation attacks
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMatch(overrides = {}) {
    return {
        role: "button",
        name: "Submit",
        refId: "ref_1",
        rect: { x: 10, y: 20, width: 100, height: 30 },
        ...overrides,
    };
}

function makeScriptResult(matches, total) {
    return [{ matches, total }];
}

function makeBrowserMock(opts = {}) {
    const { scriptResult, scriptError = null } = opts;
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

function loadFind({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    // Load the real classifyExecuteScriptError from tool-registry.js so tests
    // exercise the production implementation rather than an inlined copy.
    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/find.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("find tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    test("T1 — formats a single match with role, name, ref, and rect", async () => {
        const resolveTab = jest.fn(async () => 42);
        const match = makeMatch();
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([match], 1) });
        const handler = loadFind({ browser, resolveTab });

        const result = await handler({ query: "Submit" });

        expect(result).toContain('Found 1 match for "Submit"');
        expect(result).toContain('button "Submit" [ref=ref_1]');
        expect(result).toContain("at (10, 20, 100x30)");
    });

    test("T2 — returns 'No elements found' when total is 0", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        const result = await handler({ query: "nonexistent xyz123" });

        expect(result).toBe('No elements found matching "nonexistent xyz123".');
    });

    test("T3 — appends truncation note when total exceeds 20", async () => {
        const resolveTab = jest.fn(async () => 42);
        const matches = Array.from({ length: 20 }, (_, i) =>
            makeMatch({ refId: `ref_${i + 1}`, name: `Item ${i + 1}` })
        );
        const browser = makeBrowserMock({ scriptResult: makeScriptResult(matches, 25) });
        const handler = loadFind({ browser, resolveTab });

        const result = await handler({ query: "Item" });

        expect(result).toContain("showing first 20 of 25 matches");
        expect(result).toContain("Use a more specific query to narrow results");
    });

    test("T4 — no truncation note when total is exactly 20", async () => {
        const resolveTab = jest.fn(async () => 42);
        const matches = Array.from({ length: 20 }, (_, i) =>
            makeMatch({ refId: `ref_${i + 1}`, name: `Item ${i + 1}` })
        );
        const browser = makeBrowserMock({ scriptResult: makeScriptResult(matches, 20) });
        const handler = loadFind({ browser, resolveTab });

        const result = await handler({ query: "Item" });

        expect(result).not.toContain("showing first 20");
    });

    test("T5 — throws when query is an empty string", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "" })).rejects.toThrow("query must be a non-empty string");
    });

    test("T6 — throws when query is null", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: null })).rejects.toThrow("query must be a non-empty string");
    });

    test("T7 — tabId=null resolves to active tab via resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBeNull(); return 55; });
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "foo", tabId: null });

        expect(resolveTab).toHaveBeenCalledWith(null);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(55, expect.any(Object));
    });

    test("T8 — virtualTabId provided is forwarded to resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBe(3); return 77; });
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "foo", tabId: 3 });

        expect(resolveTab).toHaveBeenCalledWith(3);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(77, expect.any(Object));
    });

    test("T9 — resolveTab rejection propagates the original error message", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("Tab not found: 5"); });
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo", tabId: 5 })).rejects.toThrow(/Tab not found: 5/);
    });

    test("T10 — executeScript rejects with restricted-URL error: wrapped with guidance", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptError: new Error("Cannot access contents of the page") });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo" })).rejects.toThrow(/cannot inject into this page/);
    });

    test("T11 — executeScript rejects with stale-tab error: references tabs_context_mcp", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptError: new Error("No tab with id: 42") });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo" })).rejects.toThrow(/tabs_context_mcp/);
    });

    test("T12 — executeScript returns null: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: null });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo" })).rejects.toThrow(/no result/);
    });

    test("T13 — match with null rect (hidden input) omits 'at (...)' position", async () => {
        const resolveTab = jest.fn(async () => 42);
        const match = makeMatch({ role: "textbox", name: "email", refId: "ref_99", rect: null });
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([match], 1) });
        const handler = loadFind({ browser, resolveTab });

        const result = await handler({ query: "email" });

        expect(result).toContain('[ref=ref_99]');
        expect(result).not.toContain("at (");
    });

    test("T14 — called with no arguments: throws on missing query", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler()).rejects.toThrow("query must be a non-empty string");
    });

    test("T15 — registers itself under the name 'find'", () => {
        const resolveTab = jest.fn(async () => 1);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        loadFind({ browser, resolveTab });

        expect(globalThis.registerTool).toHaveBeenCalledWith("find", expect.any(Function));
    });

    test("T16 — single match uses singular 'match' not 'matches'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const match = makeMatch();
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([match], 1) });
        const handler = loadFind({ browser, resolveTab });

        const result = await handler({ query: "Submit" });

        expect(result).toContain("Found 1 match for");
        expect(result).not.toContain("1 matches");
    });

    test("T17 — injected code uses CSS.escape for label[for] selector", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "email" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("CSS.escape(el.id)");
        expect(code).not.toContain('label[for="' + '" + el.id + "' + '"]');
    });

    test("T18 — injected code maps detectedRole 'select' to combobox in roleMatch", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "select language" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain('detectedRole === "select" && elRole === "combobox"');
    });

    test("T19 — injected code splits aria-labelledby space-separated IDs", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "label test" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        // Multi-ID support requires splitting on whitespace before getElementById
        expect(code).toContain('split(/\\s+/)');
        expect(code).toContain('document.getElementById');
    });

    test("T20 — whitespace-only query throws 'query must be a non-empty string'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "   " })).rejects.toThrow("query must be a non-empty string");
        await expect(handler({ query: "\t" })).rejects.toThrow("query must be a non-empty string");
    });

    test("T21 — injected code guards all five bucket insertions with seen.has(el)", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "test" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        const guardCount = (code.match(/!seen\.has\(el\)/g) || []).length;
        expect(guardCount).toBeGreaterThanOrEqual(5);
    });

    test("T22 — injected code excludes elements with zero width and height", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "test" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toMatch(/r\.width === 0 && r\.height === 0/);
    });

    test("T23 — executeScript returns [undefined]: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [undefined] });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo" })).rejects.toThrow(/no result from page script/);
    });

    test("T24 — IIFE __error response surfaces as page script error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ __error: "CSS.escape is not a function" }] });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo" })).rejects.toThrow(/page script error: CSS\.escape is not a function/);
    });

    test("T25 — executeScript is called with runAt: document_idle", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await handler({ query: "foo" });

        const options = browser.tabs.executeScript.mock.calls[0][1];
        expect(options.runAt).toBe("document_idle");
    });

    test("T26 — query is JSON-serialized safely into injected code", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        const trickyQuery = 'he said "hello" and it\'s fine';
        await handler({ query: trickyQuery });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain(JSON.stringify(trickyQuery));
    });
});
