/**
 * @jest-environment jsdom
 *
 * Tests for tools/javascript-tool.js
 * See Spec 012 (javascript_tool).
 *
 * Architecture: DOM attribute polling (not browser.runtime.sendMessage).
 *
 * The handler makes two types of executeScript calls per invocation:
 *   Call 1 (bridge injection): runs the bridge IIFE that injects user code
 *     into the main world; always returns null (synchronous return, no result).
 *   Call 2+ (polling): synchronously reads and clears the result DOM attribute;
 *     returns JSON string when ready, null when not yet.
 *
 * Handler-layer tests mock executeScript to return null on bridge call, then
 * return the JSON-serialized result on the first poll call. This mirrors the
 * real flow: main-world script sets the attribute, poll reads it.
 *
 * KNOWN GAP — main-world execution (T4, T5, T17):
 *   Page-variable access and async code require a real browser. The bridge IIFE
 *   (CSP probe, AsyncFunction semantics) cannot run in jsdom because jsdom does
 *   not execute script textContent. Handler-layer tests mock poll delivery;
 *   the bridge itself is validated via code-string inspection below.
 *
 * KNOWN GAP — CSP probe (T16):
 *   The synchronous DOM attribute check runs in the bridge script; tests mock
 *   the returned error value rather than driving CSP policy.
 *
 * KNOWN GAP — timeout (T15):
 *   30-second wall-clock timeout is mocked via poll error delivery.
 */

"use strict";

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

/**
 * Returns a browser mock that delivers results via executeScript polling.
 *
 * Call 1 (bridge injection): returns [null] — bridge always returns null.
 * Call 2+ (polling): returns [JSON.stringify(scriptResult)] immediately,
 *   simulating the main-world script having already written the attribute.
 *
 * @param {{ scriptResult?: object|null, scriptError?: Error }} opts
 *   scriptResult: the { value } or { error } payload to deliver on first poll
 *                 (default: { value: "ok" }); null keeps returning [null] (not ready)
 *   scriptError:  if set, bridge executeScript (call 1) rejects with this error
 */
function makeBrowserMock(opts = {}) {
    const { scriptResult = { value: "ok" }, scriptError = null } = opts;

    let callCount = 0;

    return {
        tabs: {
            executeScript: jest.fn(async (_tabId, _execOpts) => {
                callCount++;
                if (callCount === 1) {
                    // Bridge injection — always returns null in Safari MV2.
                    if (scriptError) throw scriptError;
                    return [null];
                }
                // Poll call — return result immediately (or null if scriptResult is null).
                if (scriptResult !== null) {
                    return [JSON.stringify(scriptResult)];
                }
                return [null];
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

/**
 * Loads javascript-tool.js in isolation and returns the registered handler.
 */
function loadJavaScriptTool({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/javascript-tool.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("javascript_tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    describe("argument validation", () => {
        test("T9 — wrong action rejects with supported-action message", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "wrong", text: "1+1" }))
                .rejects.toThrow(/javascript_exec.*only supported action/i);
        });

        test("missing action rejects", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ text: "1+1" }))
                .rejects.toThrow(/javascript_exec.*only supported action/i);
        });

        test("T8 — empty text rejects with 'Code parameter is required'", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "" }))
                .rejects.toThrow("Code parameter is required");
        });

        test("missing text rejects with 'Code parameter is required'", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec" }))
                .rejects.toThrow("Code parameter is required");
        });

        test("whitespace-only text rejects", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "   " }))
                .rejects.toThrow("Code parameter is required");
        });
    });

    describe("successful execution", () => {
        test("T2 — '1 + 1' returns '2'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: "2" } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "1 + 1" });
            expect(result).toBe("2");
        });

        test("T1 — document.title returns string result", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: "My Page Title" } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "document.title" });
            expect(result).toBe("My Page Title");
        });

        test("T3 — multi-statement last-expression returned", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: "15" } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "const x = 5; x * 3" });
            expect(result).toBe("15");
        });

        test("T6 — object result returned as JSON string", async () => {
            const json = JSON.stringify({ name: "test", value: 42 }, null, 2);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: json } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "({name:'test',value:42})" });
            expect(result).toBe(json);
        });

        test("T13 — undefined result returns string 'undefined'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: "undefined" } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "undefined" });
            expect(result).toBe("undefined");
        });

        test("T18 — DOM element result returns [object HTMLElement] with note", async () => {
            const domMsg = "[object HTMLElement] (DOM element \u2014 use .outerHTML or .textContent to serialize)";
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: domMsg } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "document.body" });
            expect(result).toContain("[object HTMLElement]");
            expect(result).toContain("outerHTML");
        });

        test("bridge executeScript returns null (Safari MV2 behavior) and result arrives via poll", async () => {
            // Bridge call always returns null in real Safari; result comes from the poll call.
            const browser = makeBrowserMock({ scriptResult: { value: "42" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            const result = await handler({ action: "javascript_exec", text: "42" });
            expect(result).toBe("42");
            // Two calls: bridge + at least one poll
            expect(browser.tabs.executeScript).toHaveBeenCalledTimes(2);
        });
    });

    describe("output truncation", () => {
        test("T11 — result > 100,000 chars is truncated with [output truncated]", async () => {
            const truncated = "x".repeat(100000) + "\n[output truncated]";
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: truncated } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "'x'.repeat(200000)" });
            expect(result).toContain("[output truncated]");
            expect(result.length).toBeLessThanOrEqual(truncated.length + 1);
        });
    });

    describe("error cases", () => {
        test("T7 — user code throws Error: rejects with 'JavaScript error:' prefix", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: "JavaScript error: test\n    at <anonymous>:1:7" } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "throw new Error('test')" }))
                .rejects.toThrow(/JavaScript error: test/);
        });

        test("T14 — non-Error throw: error message is the thrown value", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: "a string" } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "throw 'a string'" }))
                .rejects.toThrow("a string");
        });

        test("T12 — bare return causes SyntaxError", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: "JavaScript error: Illegal return statement\n(no stack)" } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "return 5" }))
                .rejects.toThrow(/SyntaxError|Illegal return/i);
        });

        test("circular reference result: rejects with 'circular references'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: "Result contains circular references" } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "const o={}; o.self=o; o" }))
                .rejects.toThrow(/circular references/i);
        });

        test("T15 — timeout: rejects with timeout message", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: "Script execution timed out after 30 seconds" } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "while(true){}" }))
                .rejects.toThrow("Script execution timed out after 30 seconds");
        });

        test("T16 — CSP blocks inline scripts: rejects with CSP message", async () => {
            const cspMsg = "Page Content Security Policy blocks script execution. The page's CSP does not allow inline scripts.";
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: cspMsg } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow(/Content Security Policy/);
        });

        test("T10 — invalid tab: classifyExecuteScriptError wraps with guidance", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptError: new Error("No tab with id 99") }),
                resolveTab: jest.fn(async () => 99),
            });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow(/tabs_context_mcp/);
        });

        test("poll executeScript error: classifyExecuteScriptError wraps with guidance", async () => {
            // Bridge succeeds; poll fails (e.g. tab navigated away between calls).
            let callCount = 0;
            const browser = {
                tabs: {
                    executeScript: jest.fn(async () => {
                        callCount++;
                        if (callCount === 1) return [null]; // bridge succeeds
                        throw new Error("No tab with id 1");  // poll fails
                    }),
                    onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow(/tabs_context_mcp/);
        });

        test("tab closed during execution rejects with tab-closed error immediately", async () => {
            // executeScript hangs forever; onRemoved fires immediately to win the race.
            const browser = {
                tabs: {
                    executeScript: jest.fn(() => new Promise(() => {})),
                    onRemoved: {
                        addListener: jest.fn((cb) => { cb(7); }),
                        removeListener: jest.fn(),
                    },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 7) });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow(/was closed during/i);
        });

        test("onRemoved listener is removed on successful execution", async () => {
            const browser = makeBrowserMock({ scriptResult: { value: "ok" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "1" });
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });

        test("onRemoved listener is removed when bridge executeScript throws", async () => {
            const browser = makeBrowserMock({ scriptError: new Error("No tab with id 1") });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "1" }))
                .rejects.toThrow();
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });
    });

    describe("tab resolution", () => {
        test("resolveTab is called with the virtualTabId from args", async () => {
            const resolveTab = jest.fn(async () => 7);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: "ok" } }),
                resolveTab,
            });
            await handler({ action: "javascript_exec", text: "1", tabId: 42 });
            expect(resolveTab).toHaveBeenCalledWith(42);
        });

        test("resolveTab defaults to null when tabId omitted", async () => {
            const resolveTab = jest.fn(async () => 1);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { value: "ok" } }),
                resolveTab,
            });
            await handler({ action: "javascript_exec", text: "1" });
            expect(resolveTab).toHaveBeenCalledWith(null);
        });
    });

    describe("registration", () => {
        test("registers itself under the name 'javascript_tool'", () => {
            loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            expect(globalThis.registerTool).toHaveBeenCalledWith("javascript_tool", expect.any(Function));
        });
    });

    describe("non-Error throw serialization", () => {
        test("thrown plain object is JSON-stringified, not [object Object]", async () => {
            const thrownObj = JSON.stringify({ code: 404, message: "Not found" }, null, 2);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptResult: { error: thrownObj } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(
                handler({ action: "javascript_exec", text: "throw { code: 404, message: 'Not found' }" })
            ).rejects.toThrow(/404/);
        });
    });

    describe("bridge code validation", () => {
        async function captureGeneratedCode(userCode) {
            let capturedBridgeCode = null;
            let capturedPollCode = null;
            let callCount = 0;
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        callCount++;
                        if (callCount === 1) {
                            capturedBridgeCode = code;
                        } else {
                            capturedPollCode = code;
                            // Return a result to settle the handler promise
                            return [JSON.stringify({ value: "ok" })];
                        }
                        return [null];
                    }),
                    onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: userCode });
            return { bridgeCode: capturedBridgeCode, pollCode: capturedPollCode };
        }

        test("generated bridge code embeds the correlationId as the last IIFE argument", async () => {
            const { bridgeCode } = await captureGeneratedCode("1+1");
            expect(bridgeCode).toMatch(/,\s*"__claudeJsToolResult_[^"]+"\s*\)\s*$/);
        });

        test("correlationId is unique per invocation (nonce-suffixed)", async () => {
            const { bridgeCode: code1 } = await captureGeneratedCode("1+1");
            const { bridgeCode: code2 } = await captureGeneratedCode("2+2");
            const id1 = code1.match(/,\s*("__claudeJsToolResult_[^"]+")\s*\)\s*$/)?.[1];
            const id2 = code2.match(/,\s*("__claudeJsToolResult_[^"]+")\s*\)\s*$/)?.[1];
            expect(id1).toBeTruthy();
            expect(id2).toBeTruthy();
            expect(id1).not.toBe(id2);
        });

        test("generated code embeds MAX_OUTPUT numeric value", async () => {
            const { bridgeCode } = await captureGeneratedCode("1+1");
            expect(bridgeCode).toContain("100000");
        });

        test("generated bridge code writes result to data-claude-js-result- DOM attribute", async () => {
            const { bridgeCode } = await captureGeneratedCode("1+1");
            expect(bridgeCode).toContain("data-claude-js-result-");
            expect(bridgeCode).toContain("setAttribute");
        });

        test("generated poll code reads and removes data-claude-js-result- DOM attribute", async () => {
            const { pollCode } = await captureGeneratedCode("1+1");
            expect(pollCode).toContain("data-claude-js-result-");
            expect(pollCode).toContain("getAttribute");
            expect(pollCode).toContain("removeAttribute");
        });

        test("bridge and poll code share the same correlationId", async () => {
            const { bridgeCode, pollCode } = await captureGeneratedCode("1+1");
            const corrId = bridgeCode.match(/,\s*("__claudeJsToolResult_[^"]+")\s*\)\s*$/)?.[1];
            expect(corrId).toBeTruthy();
            // Poll code must reference the same corrId (unquoted, as part of attr name)
            const expectedAttr = "data-claude-js-result-" + JSON.parse(corrId);
            expect(pollCode).toContain(expectedAttr);
        });

        test("generated code uses AsyncFunction for last-expression return semantics", async () => {
            const { bridgeCode } = await captureGeneratedCode("1+1");
            expect(bridgeCode).toContain("AsyncFunc");
            expect(bridgeCode).toContain("return eval(arguments[0])");
        });

        test("user code with double-quotes is safely JSON-encoded in generated code", async () => {
            const userCode = 'document.querySelector("h1").textContent';
            const { bridgeCode } = await captureGeneratedCode(userCode);
            expect(bridgeCode).toContain(JSON.stringify(userCode));
        });

        test("user code appears JSON-encoded (not raw-concatenated) in generated code", async () => {
            const userCode = "const x = '</script>'; x";
            const { bridgeCode } = await captureGeneratedCode(userCode);
            expect(bridgeCode).toContain(JSON.stringify(userCode));
        });
    });
});
