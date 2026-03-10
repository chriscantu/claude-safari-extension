/**
 * @jest-environment jsdom
 *
 * WHY jsdom here but not in other test files:
 * Tests T1–T8 run the injected IIFE (built by buildGetPageTextScript) against
 * a real DOM so the extraction algorithm — priority chain, noise removal,
 * blank-line collapse, truncation — is actually exercised. The other tool test
 * files (find, navigate, form-input, tool-registry) operate purely at the
 * background-script layer and have no DOM dependencies, so they remain on the
 * default "node" environment to keep their behaviour unchanged.
 */

/**
 * Tests for tools/get-page-text.js
 * See Spec 009 (get_page_text).
 *
 * Covers:
 *   T1  — page with <article>: returns article text, not surrounding body text
 *   T2  — page with <main> but no single <article>: returns main text
 *   T3  — page with only <body> (body fallback): returns body text
 *   T4  — multiple consecutive blank lines collapsed to one
 *   T5  — <script> content excluded from output
 *   T6  — aria-hidden section excluded
 *   T7  — text > 100 000 chars: truncated with "[content truncated]"
 *   T8  — empty body: returns empty string (no error)
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

/**
 * Browser mock that actually runs the injected IIFE code string against the
 * live jsdom document. Used by T1–T8 so the extraction algorithm runs for
 * real instead of returning a pre-canned scriptResult.
 *
 * vm.runInNewContext creates a fresh V8 sandbox seeded with jsdom's live
 * `document` object. The IIFE runs inside that sandbox with full access to
 * document.querySelectorAll, document.createElement, document.body etc.
 * because all those methods are JavaScript functions that close over jsdom's
 * internal state — they work correctly regardless of which V8 context calls them.
 * `code` is always the output of buildGetPageTextScript() — our own controlled
 * source — so executing it here is safe.
 */
function makeBrowserMockWithDomEval() {
    const vm = require("vm");
    return {
        tabs: {
            executeScript: jest.fn(async (_tabId, { code }) => {
                return [vm.runInNewContext(code, { document: globalThis.document })];
            }),
        },
    };
}

/**
 * Browser mock that returns a pre-set scriptResult without running the IIFE.
 * Used by T9–T20 which test the handler's plumbing, error handling, and
 * source-string properties — not the DOM extraction algorithm.
 */
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
// DOM fixture helpers — build test DOMs without innerHTML
// ---------------------------------------------------------------------------

function appendArticle(text) {
    const el = document.createElement("article");
    el.textContent = text;
    document.body.appendChild(el);
    return el;
}

function appendElement(tag, text, parent) {
    const el = document.createElement(tag);
    el.textContent = text;
    (parent || document.body).appendChild(el);
    return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("get_page_text tool", () => {
    afterEach(() => {
        // Clear DOM state so T1–T8 fixtures don't bleed between tests.
        document.body.replaceChildren();

        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    // -------------------------------------------------------------------------
    // T1–T8: DOM extraction algorithm (IIFE runs in real jsdom document)
    // -------------------------------------------------------------------------

    test("T1 — article present: returns article text, not surrounding body text", async () => {
        appendArticle("Article content");
        appendElement("p", "Body-only text");
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toContain("Article content");
        expect(result).not.toContain("Body-only text");
    });

    test("T2 — <main> but no single <article>: returns main text", async () => {
        // Two <article> elements → falls through to <main>
        appendArticle("A");
        appendArticle("B");
        appendElement("main", "Main content");
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toContain("Main content");
    });

    test("T3 — body fallback: returns body text when no article or main", async () => {
        appendElement("p", "Body content");
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toContain("Body content");
    });

    test("T4 — multiple consecutive blank lines collapsed to one", async () => {
        // Literal newlines injected via textContent to bypass HTML whitespace collapsing.
        const article = document.createElement("article");
        article.textContent = "Line 1\n\n\n\nLine 2";
        document.body.appendChild(article);
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toBe("Line 1\n\nLine 2");
    });

    test("T5 — <script> content excluded from output", async () => {
        const article = document.createElement("article");
        const textNode = document.createTextNode("Visible text");
        article.appendChild(textNode);
        const script = document.createElement("script");
        script.textContent = 'alert("hidden")';
        article.appendChild(script);
        document.body.appendChild(article);
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toContain("Visible text");
        expect(result).not.toContain("alert(");
    });

    test("T6 — aria-hidden section excluded", async () => {
        const article = document.createElement("article");
        const visible = document.createElement("p");
        visible.textContent = "Visible";
        article.appendChild(visible);
        const hidden = document.createElement("div");
        hidden.setAttribute("aria-hidden", "true");
        hidden.textContent = "Hidden text";
        article.appendChild(hidden);
        document.body.appendChild(article);
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toContain("Visible");
        expect(result).not.toContain("Hidden text");
    });

    test("T7 — text > 100 000 chars: truncated with [content truncated]", async () => {
        const article = document.createElement("article");
        article.textContent = "x".repeat(100001);
        document.body.appendChild(article);
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toContain("[content truncated]");
        // Slice is at 100 000 chars; sentinel "\n[content truncated]" adds 20 more.
        expect(result.length).toBe(100020);
    });

    test("T8 — empty body: returns empty string", async () => {
        // document.body has no children (cleared by afterEach from prior test).
        const resolveTab = jest.fn(async () => 42);
        const handler = loadGetPageText({ browser: makeBrowserMockWithDomEval(), resolveTab });

        const result = await handler({});

        expect(result).toBe("");
    });

    // -------------------------------------------------------------------------
    // T9–T20: handler plumbing, error handling, source-string checks
    // -------------------------------------------------------------------------

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
