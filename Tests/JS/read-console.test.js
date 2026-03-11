/**
 * Tests for tools/read-console.js
 * See Spec 014 (read_console_messages).
 *
 * Covers:
 *   T1  — LOG message returned with correct [LOG] level formatting
 *   T2  — ERROR message returned with correct [ERROR] level formatting
 *   T3  — onlyErrors: true returns only error-level messages
 *   T4  — pattern filter: only matching messages returned (case-insensitive)
 *   T5  — invalid pattern regex: rejects with regex syntax error
 *   T6  — clear: true appends "(Messages cleared)" to output
 *   T7  — clear: true passes clear flag into injected script
 *   T8  — limit: returns only the most recent N messages
 *   T9  — no console messages: returns "No console messages found" string
 *   T10 — tab not found: rejects with classifyExecuteScriptError message
 *   T11 — unhandled error entry (level=error, message with filename): included
 *   T12 — unhandled rejection entry: included with "Unhandled rejection:" prefix
 *   T13 — content script not loaded (result null): returns empty, not error
 *   T14 — onlyErrors + pattern: only matching error messages returned
 *   T15 — limit returns results in chronological order (oldest of N most recent first)
 *   T16 — registers itself under the name "read_console_messages"
 *   T17 — resolveTab failure: rejects with tabs_context_mcp guidance
 *   T18 — executeScript returns no results array: throws no-result error
 *   T19 — result.__error surfaces as rejection
 *   T20 — virtualTabId forwarded to resolveTab
 *   T21 — tabId null: resolveTab called with null (active tab resolution)
 *   T22 — timestamp formatted as HH:MM:SS.mmm (UTC)
 *   T23 — limit defaults to 100 when not specified
 *   T24 — unexpected result shape: throws unexpected shape error
 *   T25 — clear: true with empty buffer still appends "(Messages cleared)"
 *   T26 — tab closed during executeScript: rejects with tab-closed error; listener removed
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a console message entry matching console-monitor.js's storage format.
 *
 * @param {string} level - "log"|"info"|"warn"|"error"|"debug"
 * @param {string} message
 * @param {number} [timestamp] - ms since epoch; defaults to 0
 */
function makeMsg(level, message, timestamp = 0) {
    return { level, message, timestamp };
}

/**
 * Browser mock that returns pre-canned executeScript results.
 * Includes a no-op browser.tabs.onRemoved stub required by the onRemoved guard.
 */
function makeBrowserMock(opts = {}) {
    const { scriptResult, scriptError = null } = opts;
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

function loadReadConsole({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/read-console.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("read_console_messages tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    test("T1 — LOG message returned with correct [LOG] level formatting", async () => {
        const msgs = [makeMsg("log", "hello world", Date.UTC(2024, 0, 1, 12, 0, 0, 0))];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[LOG] hello world");
        expect(result).toContain("Console messages for tab 1 (1 messages):");
    });

    test("T2 — ERROR message returned with correct [ERROR] level formatting", async () => {
        const msgs = [makeMsg("error", "something broke", 0)];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[ERROR] something broke");
    });

    test("T3 — onlyErrors: true returns only error-level messages", async () => {
        const msgs = [
            makeMsg("log", "info message", 0),
            makeMsg("error", "error message", 1),
            makeMsg("warn", "warn message", 2),
        ];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, onlyErrors: true });

        expect(result).toContain("[ERROR] error message");
        expect(result).not.toContain("info message");
        expect(result).not.toContain("warn message");
    });

    test("T4 — pattern filter: only matching messages returned (case-insensitive)", async () => {
        const msgs = [
            makeMsg("log", "API call succeeded", 0),
            makeMsg("log", "user clicked button", 1),
            makeMsg("error", "API timeout", 2),
        ];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, pattern: "api" });

        expect(result).toContain("API call succeeded");
        expect(result).toContain("API timeout");
        expect(result).not.toContain("user clicked button");
    });

    test("T5 — invalid pattern regex: rejects with regex syntax error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({ tabId: 1, pattern: "[invalid" })).rejects.toThrow(/Invalid regex pattern/);
    });

    test("T6 — clear: true appends \"(Messages cleared)\" to output", async () => {
        const msgs = [makeMsg("log", "a message", 0)];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, clear: true });

        expect(result).toContain("(Messages cleared)");
    });

    test("T7 — clear: true passes clear flag into injected script code", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await handler({ tabId: 1, clear: true });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("true");
        expect(code).toContain("__claudeConsoleMessages = []");
    });

    test("T8 — limit: returns only the most recent N messages", async () => {
        const msgs = Array.from({ length: 10 }, (_, i) => makeMsg("log", `msg${i}`, i));
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, limit: 3 });

        // Most recent 3: msg7, msg8, msg9
        expect(result).toContain("msg7");
        expect(result).toContain("msg8");
        expect(result).toContain("msg9");
        expect(result).not.toContain("msg6");
        expect(result).toContain("(3 messages)");
    });

    test("T9 — no console messages: returns \"No console messages found\" string", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toMatch(/No console messages found for tab 1\./);
    });

    test("T10 — tab not found: rejects with could not resolve tab message", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("Tab not found: 99"); });
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({ tabId: 99 })).rejects.toThrow(/could not resolve tab/);
    });

    test("T10b — executeScript failure: classifyExecuteScriptError wraps error with guidance", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptError: new Error("Cannot access contents of the page"),
        });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/cannot inject into this page/);
    });

    test("T11 — unhandled error entry included with filename info", async () => {
        const msgs = [makeMsg("error", "ReferenceError at http://example.com/app.js:10:5", 0)];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[ERROR] ReferenceError at http://example.com/app.js:10:5");
    });

    test("T12 — unhandled rejection entry included", async () => {
        const msgs = [makeMsg("error", "Unhandled rejection: fetch failed", 0)];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("Unhandled rejection: fetch failed");
    });

    test("T13 — content script not loaded (executeScript returns [null]): returns empty, not error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [null] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toMatch(/No console messages found/);
    });

    test("T14 — onlyErrors + pattern: only matching error messages returned", async () => {
        const msgs = [
            makeMsg("log", "api log", 0),
            makeMsg("error", "api error", 1),
            makeMsg("error", "unrelated error", 2),
        ];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, onlyErrors: true, pattern: "api" });

        expect(result).toContain("api error");
        expect(result).not.toContain("api log");
        expect(result).not.toContain("unrelated error");
    });

    test("T15 — limit returns results in chronological order (oldest of N most recent first)", async () => {
        const msgs = Array.from({ length: 10 }, (_, i) => makeMsg("log", `msg${i}`, i));
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, limit: 3 });

        const idx7 = result.indexOf("msg7");
        const idx8 = result.indexOf("msg8");
        const idx9 = result.indexOf("msg9");
        expect(idx7).toBeLessThan(idx8);
        expect(idx8).toBeLessThan(idx9);
    });

    test("T16 — registers itself under the name \"read_console_messages\"", () => {
        const resolveTab = jest.fn(async () => 1);
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        loadReadConsole({ browser, resolveTab });

        expect(globalThis.registerTool).toHaveBeenCalledWith("read_console_messages", expect.any(Function));
    });

    test("T17 — resolveTab failure: rejects with tabs_context_mcp guidance", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("No active tab found"); });
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/tabs_context_mcp/);
        await expect(handler({})).rejects.toThrow(/could not resolve tab/);
    });

    test("T18 — executeScript returns empty array: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [] });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/no result/);
    });

    test("T19 — result.__error surfaces as rejection", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ __error: "page blew up" }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/page script error.*page blew up/);
    });

    test("T20 — virtualTabId forwarded to resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBe(7); return 99; });
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await handler({ tabId: 7 });

        expect(resolveTab).toHaveBeenCalledWith(7);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(99, expect.any(Object));
    });

    test("T21 — tabId null: resolveTab called with null (active tab resolution)", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await handler({});

        expect(resolveTab).toHaveBeenCalledWith(null);
    });

    test("T22 — timestamp formatted as HH:MM:SS.mmm (UTC)", async () => {
        // 2024-01-01T00:00:00.000Z → "00:00:00.000"
        const ts = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
        const msgs = [makeMsg("log", "timed message", ts)];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[00:00:00.000]");
    });

    test("T23 — limit defaults to 100 when not specified", async () => {
        const msgs = Array.from({ length: 150 }, (_, i) => makeMsg("log", `msg${i}`, i));
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: msgs }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("(100 messages)");
        expect(result).toContain("msg149"); // most recent
        expect(result).not.toContain("msg49"); // too old
    });

    test("T24 — unexpected result shape: throws unexpected shape error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ data: "wrong shape" }] });
        const handler = loadReadConsole({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/unexpected result shape/);
    });

    test("T25 — clear: true with empty buffer appends \"(Messages cleared)\" to no-messages output", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ messages: [] }] });
        const handler = loadReadConsole({ browser, resolveTab });

        const result = await handler({ tabId: 1, clear: true });

        expect(result).toContain("No console messages found");
        expect(result).toContain("(Messages cleared)");
    });

    test("T26 — tab closed during execution: rejects with tab-closed error", async () => {
        const resolveTab = jest.fn(async () => 42);
        // Mock that captures the onRemoved listener and fires it before executeScript resolves
        let capturedOnRemoved = null;
        const browser = {
            tabs: {
                executeScript: jest.fn(() => new Promise(() => { /* never resolves */ })),
                onRemoved: {
                    addListener: jest.fn((fn) => { capturedOnRemoved = fn; }),
                    removeListener: jest.fn(),
                },
            },
        };
        const handler = loadReadConsole({ browser, resolveTab });

        const promise = handler({ tabId: 1 });
        // Yield to the microtask queue so the async handler progresses past the
        // resolveTab await and registers the onRemoved listener before we fire it.
        await Promise.resolve();
        capturedOnRemoved(42);

        await expect(promise).rejects.toThrow(/was closed during/);
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
    });
});
