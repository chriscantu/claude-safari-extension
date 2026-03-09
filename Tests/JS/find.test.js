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

    // Provide the real classifyExecuteScriptError logic (normally from tool-registry.js)
    globalThis.classifyExecuteScriptError = function(toolName, realTabId, err) {
        const msg = (err && err.message) || String(err);
        if (/cannot access|scheme|about:|chrome:|file:/i.test(msg)) {
            return new Error(
                `${toolName}: cannot inject into this page (restricted URL or scheme). ` +
                `Navigate to an http/https page first. (${msg})`
            );
        }
        if (/no tab with id|invalid tab/i.test(msg)) {
            return new Error(
                `${toolName}: tab ${realTabId} no longer exists. ` +
                `Use tabs_context_mcp to list available tabs. (${msg})`
            );
        }
        return new Error(`${toolName}: executeScript failed: ${msg}`);
    };

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

    test("T9 — resolveTab rejection produces an error mentioning the tab id", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("Tab not found: 5"); });
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        await expect(handler({ query: "foo", tabId: 5 })).rejects.toThrow(/Cannot access tab/);
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

    test("T12 — executeScript returns null: throws", async () => {
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

    test("query is JSON-serialized safely into injected code", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: makeScriptResult([], 0) });
        const handler = loadFind({ browser, resolveTab });

        // Query with special characters that could break naive string interpolation
        const trickyQuery = 'he said "hello" and it\'s fine';
        await handler({ query: trickyQuery });

        const call = browser.tabs.executeScript.mock.calls[0];
        expect(call[0]).toBe(42);
        const code = call[1].code;
        // JSON.stringify ensures the string is safely embedded
        expect(code).toContain(JSON.stringify(trickyQuery));
    });
});
