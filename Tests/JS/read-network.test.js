/**
 * Tests for tools/read-network.js
 * See Spec 015 (read_network_requests).
 *
 * Covers:
 *   T1  — fetch request: shows [fetch] with URL, status, duration
 *   T2  — XHR request: shows [xhr] type
 *   T3  — urlPattern filter: only matching requests returned (case-insensitive substring)
 *   T4  — urlPattern case-insensitive: "example.com" matches "EXAMPLE.COM"
 *   T5  — clear: true appends "(Requests cleared)" to output
 *   T6  — clear: true then read again returns empty
 *   T7  — limit: returns only the most recent N requests
 *   T8  — no requests: returns "No network requests found" string
 *   T9  — tab not found: rejects with isError message
 *   T10 — failed fetch (network error): shows ERR: <message>
 *   T11 — in-flight request (no endTime): shows "pending" duration
 *   T12 — content script not loaded (result null): returns empty, not error
 *   T13 — buffer at max (500): oldest evicted — tested via content script behavior
 *   T14 — mix of completed + in-flight: both formatted correctly
 *   T15 — XHR network failure (status 0 + error): shows ERR with message
 *   T16 — registers itself under the name "read_network_requests"
 *   T17 — resolveTab failure: rejects with tabs_context_mcp guidance
 *   T18 — executeScript returns empty array: throws no-result error
 *   T19 — result.__error surfaces as rejection
 *   T20 — tabId missing: rejects with "tabId parameter is required"
 *   T21 — unexpected result shape: throws unexpected shape error
 *   T22 — clear: true passes clear flag into injected script
 *   T23 — limit defaults to 100 when not specified
 *   T24 — limit returns results in chronological (oldest-first) order
 *   T25 — tab closed during executeScript: rejects with tab-closed error; listener removed
 *   T26 — status 0 without error event: shows "0 (no response)"
 *   T27 — executeScript timeout after 30s: rejects with timeout error
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a network request entry matching network-monitor.js's storage format.
 *
 * @param {string} type - "fetch"|"xhr"
 * @param {string} method - HTTP method
 * @param {string} url - request URL
 * @param {object} [overrides] - optional overrides (status, statusText, error, startTime, endTime)
 */
function makeReq(type, method, url, overrides = {}) {
    return {
        type,
        method,
        url,
        startTime: 1000,
        endTime: 1150,
        status: 200,
        statusText: "OK",
        ...overrides,
    };
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

function loadReadNetwork({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    // Load tool-registry.js first — it sets globalThis.classifyExecuteScriptError
    // and globalThis.executeScriptWithTabGuard (used by the tool handler).
    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/read-network.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("read_network_requests tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeScriptWithTabGuard;
        delete globalThis.executeTool;
    });

    test("T1 — fetch request: shows [fetch] with URL, status, duration", async () => {
        const reqs = [makeReq("fetch", "GET", "https://example.com/api/data", {
            startTime: 1000, endTime: 1250, status: 200, statusText: "OK",
        })];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[fetch] GET https://example.com/api/data → 200 OK (250ms)");
        expect(result).toContain("Network requests for tab 1 (1 requests):");
    });

    test("T2 — XHR request: shows [xhr] type", async () => {
        const reqs = [makeReq("xhr", "POST", "https://example.com/api/submit", {
            startTime: 1000, endTime: 1100, status: 201, statusText: "Created",
        })];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[xhr] POST https://example.com/api/submit → 201 Created (100ms)");
    });

    test("T3 — urlPattern filter: only matching requests returned (case-insensitive substring)", async () => {
        const reqs = [
            makeReq("fetch", "GET", "https://example.com/api/users"),
            makeReq("fetch", "GET", "https://example.com/static/logo.png"),
            makeReq("xhr", "POST", "https://example.com/api/data"),
        ];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1, urlPattern: "/api/" });

        expect(result).toContain("/api/users");
        expect(result).toContain("/api/data");
        expect(result).not.toContain("logo.png");
    });

    test("T4 — urlPattern case-insensitive: matches regardless of case", async () => {
        const reqs = [
            makeReq("fetch", "GET", "https://EXAMPLE.COM/api/data"),
            makeReq("fetch", "GET", "https://other.com/path"),
        ];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1, urlPattern: "example.com" });

        expect(result).toContain("EXAMPLE.COM");
        expect(result).not.toContain("other.com");
    });

    test("T5 — clear: true appends \"(Requests cleared)\" to output", async () => {
        const reqs = [makeReq("fetch", "GET", "https://example.com/")];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1, clear: true });

        expect(result).toContain("(Requests cleared)");
    });

    test("T6 — clear: true with empty buffer still appends \"(Requests cleared)\"", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1, clear: true });

        expect(result).toContain("No network requests found");
        expect(result).toContain("(Requests cleared)");
    });

    test("T7 — limit: returns only the most recent N requests", async () => {
        const reqs = Array.from({ length: 20 }, (_, i) =>
            makeReq("fetch", "GET", `https://example.com/req${i}`, { startTime: i, endTime: i + 10 })
        );
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1, limit: 3 });

        // Most recent 3: req17, req18, req19
        expect(result).toContain("req17");
        expect(result).toContain("req18");
        expect(result).toContain("req19");
        expect(result).not.toContain("req16");
        expect(result).toContain("(3 requests)");
    });

    test("T8 — no requests: returns \"No network requests found\" string", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toMatch(/No network requests found for tab 1\./);
    });

    test("T9 — tab not found: rejects with isError message", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("Tab not found: 99"); });
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await expect(handler({ tabId: 99 })).rejects.toThrow(/could not resolve tab/);
    });

    test("T10 — failed fetch (network error): shows ERR: <message>", async () => {
        const reqs = [makeReq("fetch", "POST", "https://api.example.com/data", {
            status: null,
            statusText: undefined,
            error: "Failed to fetch",
            startTime: 1000,
            endTime: 1150,
        })];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("[fetch] POST https://api.example.com/data → ERR: Failed to fetch (150ms)");
    });

    test("T11 — in-flight request (no endTime): shows \"pending\" duration", async () => {
        const reqs = [makeReq("fetch", "GET", "https://example.com/stream", {
            startTime: 1000,
            endTime: undefined,
            status: null,
            statusText: undefined,
        })];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("(pending)");
    });

    test("T12 — content script not loaded (executeScript returns [null]): returns empty, not error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [null] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toMatch(/No network requests found/);
    });

    test("T14 — mix of completed + in-flight: both formatted correctly", async () => {
        const reqs = [
            makeReq("fetch", "GET", "https://example.com/done", {
                startTime: 1000, endTime: 1100, status: 200, statusText: "OK",
            }),
            makeReq("xhr", "POST", "https://example.com/inflight", {
                startTime: 2000, endTime: undefined, status: null, statusText: undefined,
            }),
        ];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("200 OK (100ms)");
        expect(result).toContain("(pending)");
    });

    test("T15 — XHR network failure (status 0 + error): shows ERR with message", async () => {
        const reqs = [makeReq("xhr", "GET", "https://does-not-exist.example/", {
            status: 0,
            statusText: "",
            error: "Network request failed",
            startTime: 1000,
            endTime: 1050,
        })];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("ERR: Network request failed");
    });

    test("T16 — registers itself under the name \"read_network_requests\"", () => {
        const resolveTab = jest.fn(async () => 1);
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        loadReadNetwork({ browser, resolveTab });

        expect(globalThis.registerTool).toHaveBeenCalledWith("read_network_requests", expect.any(Function));
    });

    test("T17 — resolveTab failure: rejects with tabs_context_mcp guidance", async () => {
        const resolveTab = jest.fn(async () => { throw new Error("No active tab found"); });
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/tabs_context_mcp/);
        await expect(handler({ tabId: 1 })).rejects.toThrow(/could not resolve tab/);
    });

    test("T18 — executeScript returns empty array: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/no result/);
    });

    test("T19 — result.__error surfaces as rejection", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ __error: "page blew up" }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/page script error.*page blew up/);
    });

    test("T20 — tabId missing: rejects with \"tabId parameter is required\"", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await expect(handler({})).rejects.toThrow(/tabId parameter is required/);
    });

    test("T21 — unexpected result shape: throws unexpected shape error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ data: "wrong shape" }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await expect(handler({ tabId: 1 })).rejects.toThrow(/unexpected result shape/);
    });

    test("T22 — clear: true passes clear flag into injected script code", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: [] }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        await handler({ tabId: 1, clear: true });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("true");
        expect(code).toContain("__claudeNetworkRequests = []");
    });

    test("T23 — limit defaults to 100 when not specified", async () => {
        const reqs = Array.from({ length: 150 }, (_, i) =>
            makeReq("fetch", "GET", `https://example.com/req${i}`, { startTime: i, endTime: i + 10 })
        );
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("(100 requests)");
        expect(result).toContain("req149"); // most recent
        expect(result).not.toContain("req49"); // too old
    });

    test("T24 — limit returns results in chronological (oldest-first) order", async () => {
        const reqs = Array.from({ length: 10 }, (_, i) =>
            makeReq("fetch", "GET", `https://example.com/req${i}`, { startTime: i, endTime: i + 10 })
        );
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1, limit: 3 });

        const idx7 = result.indexOf("req7");
        const idx8 = result.indexOf("req8");
        const idx9 = result.indexOf("req9");
        expect(idx7).toBeLessThan(idx8);
        expect(idx8).toBeLessThan(idx9);
    });

    test("T25 — tab closed during executeScript: rejects with tab-closed error; listener removed", async () => {
        const resolveTab = jest.fn(async () => 42);
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
        const handler = loadReadNetwork({ browser, resolveTab });

        const promise = handler({ tabId: 1 });
        await Promise.resolve();
        capturedOnRemoved(42);

        await expect(promise).rejects.toThrow(/was closed during/);
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
    });

    test("T26 — status 0 without error field: shows \"0 (no response)\"", async () => {
        const reqs = [makeReq("xhr", "GET", "https://example.com/timeout", {
            status: 0,
            statusText: "",
            startTime: 1000,
            endTime: 5000,
        })];
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ requests: reqs }] });
        const handler = loadReadNetwork({ browser, resolveTab });

        const result = await handler({ tabId: 1 });

        expect(result).toContain("0 (no response)");
    });

    test("T27 — executeScript timeout after 30s: rejects with timeout error", async () => {
        jest.useFakeTimers();
        const resolveTab = jest.fn(async () => 42);
        const browser = {
            tabs: {
                executeScript: jest.fn(() => new Promise(() => { /* never resolves */ })),
                onRemoved: {
                    addListener: jest.fn(),
                    removeListener: jest.fn(),
                },
            },
        };
        const handler = loadReadNetwork({ browser, resolveTab });

        const promise = handler({ tabId: 1 });
        // Flush microtasks so resolveTab settles and the handler reaches
        // executeScriptWithTabGuard (where setTimeout is registered).
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(30000);

        await expect(promise).rejects.toThrow(/timed out after 30s/);
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();

        jest.useRealTimers();
    });
});
