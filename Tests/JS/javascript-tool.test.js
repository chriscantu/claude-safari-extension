/**
 * @jest-environment jsdom
 *
 * Tests for tools/javascript-tool.js
 * See Spec 012 (javascript_tool).
 *
 * Handler-layer tests mock browser.runtime.onMessage to deliver results, because
 * Safari MV2's executeScript does not await Promise return values — results[0] is
 * always null when the injected script returns a Promise. The result is delivered
 * via browser.runtime.sendMessage (content script to background) instead.
 *
 * KNOWN GAP — main-world execution (T4, T5, T17):
 *   Page-variable access and async code require a real browser. The bridge IIFE
 *   (CSP probe, postMessage channel, AsyncFunction semantics) cannot run in jsdom
 *   because jsdom does not execute script textContent. Handler-layer tests mock
 *   the onMessage delivery; the bridge itself is validated via code-string
 *   inspection in the "bridge code validation" describe block below.
 *
 * KNOWN GAP — CSP probe (T16):
 *   The synchronous DOM attribute check runs in the bridge script; tests mock the
 *   returned error value rather than driving CSP policy.
 *
 * KNOWN GAP — timeout (T15):
 *   30-second wall-clock timeout is mocked via onMessage error delivery.
 */

"use strict";

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

/**
 * Returns a browser mock that delivers results via runtime.onMessage.
 *
 * When executeScript is called, the mock extracts the correlationId from the
 * generated bridge code and fires the registered onMessage listener with the
 * result. This mirrors the real flow: bridge calls browser.runtime.sendMessage
 * which triggers the background's onMessage listener.
 *
 * @param {{ scriptResult?: object, scriptError?: Error }} opts
 *   scriptResult: the { value } or { error } payload to deliver (default: { value: "ok" })
 *   scriptError:  if set, executeScript rejects with this error instead
 */
function makeBrowserMock(opts = {}) {
    const { scriptResult = { value: "ok" }, scriptError = null } = opts;

    const messageListeners = [];

    return {
        tabs: {
            executeScript: jest.fn(async (_tabId, { code }) => {
                if (scriptError) throw scriptError;
                // Extract correlationId from bridge code: it is the last argument to the
                // IIFE call — )(JSON.stringify(text), JSON.stringify(correlationId))
                const match = code.match(/,\s*("__claudeJsToolResult_[^"]*")\s*\)\s*$/);
                if (match && scriptResult !== null) {
                    const corrId = JSON.parse(match[1]);
                    // Deliver result asynchronously (simulates bridge's sendMessage arriving
                    // after executeScript resolves — which happens in the next microtask)
                    Promise.resolve().then(() => {
                        messageListeners.forEach(cb => cb({ [corrId]: true, ...scriptResult }));
                    });
                }
                return null; // Safari MV2 always returns null for Promise-returning scripts
            }),
            onRemoved: {
                addListener: jest.fn(),
                removeListener: jest.fn(),
            },
        },
        runtime: {
            onMessage: {
                addListener: jest.fn((cb) => messageListeners.push(cb)),
                removeListener: jest.fn((cb) => {
                    const idx = messageListeners.indexOf(cb);
                    if (idx !== -1) messageListeners.splice(idx, 1);
                }),
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

        test("executeScript returning null is normal (Safari MV2 behavior) and does not reject", async () => {
            // In real Safari, executeScript always returns null when the bridge returns a Promise.
            // Result arrives via runtime.onMessage instead.
            const browser = makeBrowserMock({ scriptResult: { value: "42" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            const result = await handler({ action: "javascript_exec", text: "42" });
            expect(result).toBe("42");
            expect(browser.tabs.executeScript).toHaveBeenCalledTimes(1);
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
                runtime: {
                    onMessage: {
                        addListener: jest.fn(),
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

        test("onRemoved listener is removed when executeScript throws", async () => {
            const browser = makeBrowserMock({ scriptError: new Error("No tab with id 1") });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "1" }))
                .rejects.toThrow();
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });

        test("onMessage listener is removed on successful execution", async () => {
            const browser = makeBrowserMock({ scriptResult: { value: "ok" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "1" });
            expect(browser.runtime.onMessage.removeListener).toHaveBeenCalled();
        });

        test("onMessage listener is removed when executeScript throws", async () => {
            const browser = makeBrowserMock({ scriptError: new Error("No tab with id 1") });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "1" }))
                .rejects.toThrow();
            expect(browser.runtime.onMessage.removeListener).toHaveBeenCalled();
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
            let capturedCode = null;
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        capturedCode = code;
                        // Don't deliver a result — we just want the code string
                        return null;
                    }),
                    onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
                },
                runtime: {
                    onMessage: {
                        addListener: jest.fn(),
                        removeListener: jest.fn(),
                    },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            // Don't await — handler will hang waiting for onMessage; we only need the code
            handler({ action: "javascript_exec", text: userCode }).catch(() => {});
            // executeScript is synchronous in the mock, so capturedCode is set by the next tick
            await Promise.resolve();
            return capturedCode;
        }

        test("generated bridge code embeds the correlationId as the last IIFE argument", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toMatch(/,\s*"__claudeJsToolResult_[^"]+"\s*\)\s*$/);
        });

        test("correlationId is unique per invocation (nonce-suffixed)", async () => {
            const code1 = await captureGeneratedCode("1+1");
            const code2 = await captureGeneratedCode("2+2");
            const id1 = code1.match(/,\s*("__claudeJsToolResult_[^"]+")\s*\)\s*$/)?.[1];
            const id2 = code2.match(/,\s*("__claudeJsToolResult_[^"]+")\s*\)\s*$/)?.[1];
            expect(id1).toBeTruthy();
            expect(id2).toBeTruthy();
            expect(id1).not.toBe(id2);
        });

        test("generated code embeds MAX_OUTPUT numeric value", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("100000");
        });

        test("generated bridge code calls browser.runtime.sendMessage with corrId key", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("browser.runtime.sendMessage");
            expect(code).toContain("corrId");
        });

        test("generated code uses AsyncFunction for last-expression return semantics", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("AsyncFunc");
            expect(code).toContain("return eval(arguments[0])");
        });

        test("user code with double-quotes is safely JSON-encoded in generated code", async () => {
            const userCode = 'document.querySelector("h1").textContent';
            const code = await captureGeneratedCode(userCode);
            expect(code).toContain(JSON.stringify(userCode));
        });

        test("user code appears JSON-encoded (not raw-concatenated) in generated code", async () => {
            const userCode = "const x = '</script>'; x";
            const code = await captureGeneratedCode(userCode);
            expect(code).toContain(JSON.stringify(userCode));
        });
    });
});
