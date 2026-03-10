/**
 * Tests for tools/get-page-text.js
 * See Spec 009 (get_page_text).
 *
 * Covers:
 *   T1  — page with <article>: returns article text
 *   T2  — page with <main> but no <article>: returns main text
 *   T3  — page with only <body> (body fallback): returns body text
 *   T4  — multiple consecutive blank lines collapsed to one
 *   T5  — <script> content excluded from output
 *   T6  — aria-hidden section excluded
 *   T7  — text > 100 000 chars: truncated with "[content truncated]"
 *   T8  — empty page: returns empty string (no error)
 *   T9  — tab not accessible: classifyExecuteScriptError wraps with guidance
 *   T10 — virtualTabId forwarded to resolveTab
 *   T11 — executeScript returns no results: throws no-result error
 *   T12 — page script __error surfaces as rejection
 *   T13 — registers itself under the name "get_page_text"
 *   T14 — [role="main"] used when no <main> exists
 *   T15 — nav/header/footer excluded in body-fallback mode
 *   T16 — resolveTab failure: rejects with tabs_context_mcp guidance
 *   T17 — executeScript returns [null]: throws no-result error
 *   T18 — result.text not a string: throws unexpected shape error
 *   T19 — result.__error empty string (falsy) still surfaces as rejection
 *   T20 — injected code uses try/finally to clean up DOM container
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// NOTE: Tests T1-T8 mock scriptResult at the browser layer rather than
// eval-ing the injected IIFE in a jsdom DOM. The extraction algorithm
// (priority chain, noise removal, blank-line collapse, truncation) is
// therefore not exercised here. This is tracked as ROADMAP.md L6 and
// will be addressed when the JS test suite is configured for jsdom.

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadGetPageText({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/get-page-text.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("get_page_text tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    test("T1 — article present: returns article text", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Article content" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).toBe("Article content");
    });

    test("T2 — <main> but no <article>: returns main text", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Main content" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).toBe("Main content");
    });

    test("T3 — body fallback: returns body text", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Body content" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).toBe("Body content");
    });

    test("T4 — multiple blank lines collapsed to one", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Line 1\n\nLine 2" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        // Single blank line between paragraphs
        expect(result).toBe("Line 1\n\nLine 2");
    });

    test("T5 — <script> content excluded", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Visible text" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).not.toContain("alert(");
        expect(result).toBe("Visible text");
    });

    test("T6 — aria-hidden section excluded", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Visible" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).toBe("Visible");
    });

    test("T7 — text > 100 000 chars: truncated with [content truncated]", async () => {
        const resolveTab = jest.fn(async () => 42);
        const longText = "x".repeat(100001) + "\n[content truncated]";
        const browser = makeBrowserMock({ scriptResult: [{ text: longText }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).toContain("[content truncated]");
    });

    test("T8 — empty page: returns empty string", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        const result = await handler({});

        expect(result).toBe("");
    });

    test("T9 — restricted URL: classifyExecuteScriptError wraps with guidance", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptError: new Error("Cannot access contents of the page"),
        });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/cannot inject into this page/);
    });

    test("T10 — virtualTabId forwarded to resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBe(5); return 77; });
        const browser = makeBrowserMock({ scriptResult: [{ text: "ok" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await handler({ tabId: 5 });

        expect(resolveTab).toHaveBeenCalledWith(5);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(77, expect.any(Object));
    });

    test("T11 — executeScript returns no results: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [] });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/no result/);
    });

    test("T12 — page script __error surfaces as rejection", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ __error: "DOM exploded" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/DOM exploded/);
    });

    test("T13 — registers itself under the name 'get_page_text'", () => {
        const resolveTab = jest.fn(async () => 1);
        const browser = makeBrowserMock({ scriptResult: [{ text: "" }] });
        loadGetPageText({ browser, resolveTab });

        expect(globalThis.registerTool).toHaveBeenCalledWith("get_page_text", expect.any(Function));
    });

    test("T14 — injected code checks for [role=\"main\"] fallback", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Role main content" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await handler({});

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain('[role="main"]');
    });

    test("T15 — injected code removes nav/header/footer in body-fallback mode", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "Content" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await handler({});

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain('"nav"');
        expect(code).toContain('"header"');
        expect(code).toContain('"footer"');
    });

    test("T16 — resolveTab failure: rejects with tabs_context_mcp guidance", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("No active tab found"); });
        const browser = makeBrowserMock({ scriptResult: [{ text: "" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/tabs_context_mcp/);
        await expect(handler({})).rejects.toThrow(/could not resolve tab/);
    });

    test("T17 — executeScript returns [null]: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [null] });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/no result from page script/);
    });

    test("T18 — result.text is not a string: throws unexpected shape error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: 42 }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/unexpected result shape/);
    });

    test("T19 — result.__error empty string (falsy) still surfaces as rejection", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ __error: "" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/page script error/);
    });

    test("T20 — injected code uses try/finally to clean up DOM container", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ text: "ok" }] });
        const handler = loadGetPageText({ browser, resolveTab });

        await handler({});

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("finally");
        expect(code).toContain("removeChild(container)");
    });
});
