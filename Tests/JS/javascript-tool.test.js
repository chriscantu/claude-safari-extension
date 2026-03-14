/**
 * @jest-environment jsdom
 *
 * Tests for tools/javascript-tool.js
 * See Spec 012 (javascript_tool).
 *
 * Architecture: executeScript injects a bridge IIFE into the isolated world.
 * The bridge creates a <script> element whose textContent evals user code in
 * the main world and writes the result to a DOM attribute on <html>. Because
 * <script> content runs synchronously during appendChild, the attribute is set
 * before appendChild returns. The bridge reads it back and returns it as the
 * executeScript result (sync path).
 *
 * For async code (eval returns a Promise), the bridge returns null. The result
 * is written later by the .then() callback. js-bridge-relay.js (persistent
 * content script) polls for it and relays via sendMessage (async path).
 *
 * Handler-layer tests:
 * - Sync path: executeScript resolves with [jsonString]. Handler parses it.
 * - Async path: executeScript resolves with [null]. Handler falls back to
 *   waiting for browser.runtime.onMessage with the correlationId payload.
 *
 * KNOWN GAP -- main-world execution:
 *   Page-variable access and async code require a real browser. The bridge IIFE
 *   cannot run in jsdom because jsdom does not execute script textContent.
 *   Handler-layer tests mock executeScript return values and onMessage delivery;
 *   the bridge itself is validated via code-string inspection below.
 */

"use strict";

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

/**
 * Returns a browser mock for the javascript_tool handler.
 *
 * @param {{ syncResult?: string|null, asyncResult?: object|null, scriptError?: Error }} opts
 *   syncResult:  JSON string returned by executeScript (sync path), or null for async path.
 *                Default: JSON.stringify({ value: "ok" }) (sync success).
 *   asyncResult: { value } or { error } payload delivered via onMessage (async path).
 *                Only used when syncResult is null. null means no onMessage fires (timeout).
 *   scriptError: if set, executeScript rejects with this error.
 */
function makeBrowserMock(opts = {}) {
    const {
        syncResult = JSON.stringify({ value: "ok" }),
        asyncResult = null,
        scriptError = null,
    } = opts;

    const messageListeners = [];
    const removedListeners = [];

    return {
        tabs: {
            executeScript: jest.fn(async (_tabId, { code }) => {
                if (scriptError) throw scriptError;
                // If async path: extract corrId and fire onMessage after the
                // handler has entered the async fallback and registered its
                // onMessage listener. Use setTimeout(0) to guarantee the
                // callback runs after all pending microtasks (including the
                // handler's await + sync-path check + new Promise setup).
                if (syncResult === null && asyncResult !== null) {
                    const match = code.match(/data-claude-js-result-(__claudejstoolresult_[a-z0-9]+)/);
                    if (match) {
                        const corrId = match[1];
                        setTimeout(() => {
                            messageListeners.forEach(cb =>
                                cb({ [corrId]: true, ...asyncResult })
                            );
                        }, 0);
                    }
                }
                return [syncResult];
            }),
            onRemoved: {
                addListener: jest.fn((cb) => removedListeners.push(cb)),
                removeListener: jest.fn((cb) => {
                    const idx = removedListeners.indexOf(cb);
                    if (idx !== -1) removedListeners.splice(idx, 1);
                }),
                _fire: (tabId) => removedListeners.forEach(cb => cb(tabId)),
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
        jest.useRealTimers();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    describe("argument validation", () => {
        test("T9 -- wrong action rejects with supported-action message", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "wrong", text: "1+1" }))
                .rejects.toThrow(/javascript_exec.*only supported action/i);
        });

        test("missing action rejects", async () => {
            const handler = loadJavaScriptTool({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 1) });
            await expect(handler({ text: "1+1" }))
                .rejects.toThrow(/javascript_exec.*only supported action/i);
        });

        test("T8 -- empty text rejects with 'Code parameter is required'", async () => {
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

    describe("sync path -- executeScript returns result directly", () => {
        test("T2 -- '1 + 1' returns '2'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: "2" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "1 + 1" });
            expect(result).toBe("2");
        });

        test("T1 -- document.title returns string result", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: "My Page Title" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "document.title" });
            expect(result).toBe("My Page Title");
        });

        test("T3 -- multi-statement last-expression returned", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: "15" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "const x = 5; x * 3" });
            expect(result).toBe("15");
        });

        test("T6 -- object result returned as JSON string", async () => {
            const json = JSON.stringify({ name: "test", value: 42 }, null, 2);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: json }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "({name:'test',value:42})" });
            expect(result).toBe(json);
        });

        test("T13 -- undefined result returns string 'undefined'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: "undefined" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "undefined" });
            expect(result).toBe("undefined");
        });

        test("T18 -- DOM element result returns [object HTMLElement] with note", async () => {
            const domMsg = "[object HTMLElement] (DOM element -- use .outerHTML or .textContent to serialize)";
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: domMsg }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "document.body" });
            expect(result).toContain("[object HTMLElement]");
            expect(result).toContain("outerHTML");
        });

        test("sync path does not set up onMessage or onRemoved listeners", async () => {
            const browser = makeBrowserMock({ syncResult: JSON.stringify({ value: "42" }) });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "42" });
            // Sync path returns before reaching the async fallback block,
            // so no listeners should be registered.
            expect(browser.runtime.onMessage.addListener).not.toHaveBeenCalled();
            expect(browser.tabs.onRemoved.addListener).not.toHaveBeenCalled();
        });

        test("single executeScript call for sync result", async () => {
            const browser = makeBrowserMock({ syncResult: JSON.stringify({ value: "42" }) });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "42" });
            expect(browser.tabs.executeScript).toHaveBeenCalledTimes(1);
        });

        test("non-JSON string returned by executeScript is returned as-is", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: "some raw string" }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "'hello'" });
            expect(result).toBe("some raw string");
        });

        test("sync error result rejects with the error message", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: "JavaScript error: oops" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "throw new Error('oops')" }))
                .rejects.toThrow("JavaScript error: oops");
        });
    });

    describe("async path -- executeScript returns null, result via relay", () => {
        test("T5 -- async code (Promise) result arrives via onMessage", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: null, asyncResult: { value: "async-done" } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "Promise.resolve('async-done')" });
            expect(result).toBe("async-done");
        });

        test("async error result rejects via onMessage", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: null, asyncResult: { error: "async failure" } }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "Promise.reject('async failure')" }))
                .rejects.toThrow("async failure");
        });

        test("async path undefined value returns string 'undefined'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: null, asyncResult: { value: undefined } }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "Promise.resolve(undefined)" });
            expect(result).toBe("undefined");
        });

        test("onMessage listener is registered for async path", async () => {
            const browser = makeBrowserMock({ syncResult: null, asyncResult: { value: "ok" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "Promise.resolve()" });
            expect(browser.runtime.onMessage.addListener).toHaveBeenCalled();
        });

        test("onRemoved listener is registered for async path", async () => {
            const browser = makeBrowserMock({ syncResult: null, asyncResult: { value: "ok" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "Promise.resolve()" });
            expect(browser.tabs.onRemoved.addListener).toHaveBeenCalled();
        });

        test("listeners are cleaned up after async success", async () => {
            const browser = makeBrowserMock({ syncResult: null, asyncResult: { value: "ok" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await handler({ action: "javascript_exec", text: "Promise.resolve()" });
            expect(browser.runtime.onMessage.removeListener).toHaveBeenCalled();
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });

        test("listeners are cleaned up after async error", async () => {
            const browser = makeBrowserMock({ syncResult: null, asyncResult: { error: "fail" } });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            await expect(handler({ action: "javascript_exec", text: "Promise.reject()" }))
                .rejects.toThrow();
            expect(browser.runtime.onMessage.removeListener).toHaveBeenCalled();
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });

        test("onMessage with corrId but no value or error returns 'undefined'", async () => {
            const messageListeners = [];
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        const match = code.match(/data-claude-js-result-(__claudejstoolresult_[a-z0-9]+)/);
                        if (match) {
                            const corrId = match[1];
                            setTimeout(() => {
                                // Relay sends corrId:true but omits both value and error
                                messageListeners.forEach(cb => cb({ [corrId]: true }));
                            }, 0);
                        }
                        return [null];
                    }),
                    onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
                },
                runtime: {
                    onMessage: {
                        addListener: jest.fn((cb) => messageListeners.push(cb)),
                        removeListener: jest.fn(),
                    },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            const result = await handler({ action: "javascript_exec", text: "undefined" });
            expect(result).toBe("undefined");
        });

        test("ignores onMessage from unrelated correlationIds", async () => {
            const messageListeners = [];
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        const match = code.match(/data-claude-js-result-(__claudejstoolresult_[a-z0-9]+)/);
                        if (match) {
                            const corrId = match[1];
                            // Fire unrelated message first, then the correct one
                            setTimeout(() => {
                                messageListeners.forEach(cb => cb({ unrelated_key: true, value: "wrong" }));
                                messageListeners.forEach(cb => cb({ [corrId]: true, value: "correct" }));
                            }, 0);
                        }
                        return [null];
                    }),
                    onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
                },
                runtime: {
                    onMessage: {
                        addListener: jest.fn((cb) => messageListeners.push(cb)),
                        removeListener: jest.fn(),
                    },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });
            const result = await handler({ action: "javascript_exec", text: "async code" });
            expect(result).toBe("correct");
        });
    });

    describe("output truncation", () => {
        test("T11 -- result > 100,000 chars is truncated with [truncated]", async () => {
            const truncated = "x".repeat(100000) + "\n[truncated]";
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: truncated }) }),
                resolveTab: jest.fn(async () => 1),
            });
            const result = await handler({ action: "javascript_exec", text: "'x'.repeat(200000)" });
            expect(result).toContain("[truncated]");
            expect(result.length).toBeLessThanOrEqual(truncated.length + 1);
        });
    });

    describe("error cases", () => {
        test("T7 -- user code throws Error: rejects with 'JavaScript error:' prefix", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: "JavaScript error: test\n    at <anonymous>:1:7" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "throw new Error('test')" }))
                .rejects.toThrow(/JavaScript error: test/);
        });

        test("T14 -- non-Error throw: error message is the thrown value", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: "a string" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "throw 'a string'" }))
                .rejects.toThrow("a string");
        });

        test("T12 -- bare return causes SyntaxError", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: "JavaScript error: Illegal return statement\n(no stack)" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "return 5" }))
                .rejects.toThrow(/SyntaxError|Illegal return/i);
        });

        test("circular reference result: rejects with 'circular references'", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: "Result contains circular references" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "const o={}; o.self=o; o" }))
                .rejects.toThrow(/circular references/i);
        });

        test("T16 -- CSP blocks script injection: rejects with injection-failed message", async () => {
            // When CSP blocks appendChild, the bridge catches the error and returns it as a JSON string.
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: "Script injection failed: Refused to execute inline script" }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow(/Script injection failed/);
        });

        test("T10 -- invalid tab: classifyExecuteScriptError wraps with guidance", async () => {
            globalThis.classifyExecuteScriptError = jest.fn(
                (_tool, _tabId, _err) => new Error("tabs_context_mcp: use navigate first")
            );
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptError: new Error("No tab with id 99") }),
                resolveTab: jest.fn(async () => 99),
            });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow(/tabs_context_mcp/);
        });

        test("executeScript error without classifyExecuteScriptError throws original error", async () => {
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ scriptError: new Error("No tab with id 99") }),
                resolveTab: jest.fn(async () => 99),
            });
            await expect(handler({ action: "javascript_exec", text: "1+1" }))
                .rejects.toThrow("No tab with id 99");
        });
    });

    describe("timeout", () => {
        test("T15 -- async code that never resolves times out after 30s", async () => {
            jest.useFakeTimers();
            // syncResult=null, asyncResult=null => no onMessage fires, simulating timeout
            const browser = makeBrowserMock({ syncResult: null, asyncResult: null });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });

            const promise = handler({ action: "javascript_exec", text: "new Promise(()=>{})" });
            // Let executeScript and handler reach the async fallback (multiple microtasks)
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            // Advance past the 30s timeout
            jest.advanceTimersByTime(30000);

            await expect(promise).rejects.toThrow("Script execution timed out after 30 seconds");
        });

        test("timeout cleans up listeners", async () => {
            jest.useFakeTimers();
            const browser = makeBrowserMock({ syncResult: null, asyncResult: null });
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 1) });

            const promise = handler({ action: "javascript_exec", text: "new Promise(()=>{})" });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            jest.advanceTimersByTime(30000);

            await expect(promise).rejects.toThrow();
            expect(browser.runtime.onMessage.removeListener).toHaveBeenCalled();
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });
    });

    describe("tab closure during async execution", () => {
        test("tab closed during async execution rejects immediately", async () => {
            const removedListeners = [];
            const browser = {
                tabs: {
                    executeScript: jest.fn(async () => {
                        // After executeScript returns [null], the handler enters async path.
                        // Use setTimeout(0) to fire after the handler registers listeners.
                        setTimeout(() => {
                            removedListeners.forEach(cb => cb(7));
                        }, 0);
                        return [null];
                    }),
                    onRemoved: {
                        addListener: jest.fn((cb) => removedListeners.push(cb)),
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
            await expect(handler({ action: "javascript_exec", text: "new Promise(()=>{})" }))
                .rejects.toThrow(/Tab closed during/);
        });

        test("tab closure cleans up listeners", async () => {
            const removedListeners = [];
            const browser = {
                tabs: {
                    executeScript: jest.fn(async () => {
                        setTimeout(() => {
                            removedListeners.forEach(cb => cb(7));
                        }, 0);
                        return [null];
                    }),
                    onRemoved: {
                        addListener: jest.fn((cb) => removedListeners.push(cb)),
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
            await expect(handler({ action: "javascript_exec", text: "new Promise(()=>{})" }))
                .rejects.toThrow();
            expect(browser.runtime.onMessage.removeListener).toHaveBeenCalled();
            expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
        });

        test("double-settlement: simultaneous onMessage + onTabRemoved — only first wins", async () => {
            // Race: relay delivers result at the same tick that the tab closes.
            // The settled flag must prevent both resolve and reject from firing.
            const removedListeners = [];
            const messageListeners = [];
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        const match = code.match(/data-claude-js-result-(__claudejstoolresult_[a-z0-9]+)/);
                        if (match) {
                            const corrId = match[1];
                            setTimeout(() => {
                                // Fire both in the same tick — resolve wins (fires first)
                                messageListeners.forEach(cb => cb({ [corrId]: true, value: "race-result" }));
                                removedListeners.forEach(cb => cb(7));
                            }, 0);
                        }
                        return [null];
                    }),
                    onRemoved: {
                        addListener: jest.fn((cb) => removedListeners.push(cb)),
                        removeListener: jest.fn(),
                    },
                },
                runtime: {
                    onMessage: {
                        addListener: jest.fn((cb) => messageListeners.push(cb)),
                        removeListener: jest.fn(),
                    },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 7) });
            // Should resolve (not reject) — onMessage fired first
            const result = await handler({ action: "javascript_exec", text: "async" });
            expect(result).toBe("race-result");
        });

        test("onRemoved for unrelated tab is ignored", async () => {
            const removedListeners = [];
            const messageListeners = [];
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        const match = code.match(/data-claude-js-result-(__claudejstoolresult_[a-z0-9]+)/);
                        if (match) {
                            const corrId = match[1];
                            setTimeout(() => {
                                // Fire onRemoved for a DIFFERENT tab first
                                removedListeners.forEach(cb => cb(999));
                                // Then deliver the actual result
                                messageListeners.forEach(cb => cb({ [corrId]: true, value: "ok" }));
                            }, 0);
                        }
                        return [null];
                    }),
                    onRemoved: {
                        addListener: jest.fn((cb) => removedListeners.push(cb)),
                        removeListener: jest.fn(),
                    },
                },
                runtime: {
                    onMessage: {
                        addListener: jest.fn((cb) => messageListeners.push(cb)),
                        removeListener: jest.fn(),
                    },
                },
            };
            const handler = loadJavaScriptTool({ browser, resolveTab: jest.fn(async () => 7) });
            const result = await handler({ action: "javascript_exec", text: "async code" });
            expect(result).toBe("ok");
        });
    });

    describe("tab resolution", () => {
        test("resolveTab is called with the virtualTabId from args", async () => {
            const resolveTab = jest.fn(async () => 7);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: "ok" }) }),
                resolveTab,
            });
            await handler({ action: "javascript_exec", text: "1", tabId: 42 });
            expect(resolveTab).toHaveBeenCalledWith(42);
        });

        test("resolveTab defaults to null when tabId omitted", async () => {
            const resolveTab = jest.fn(async () => 1);
            const handler = loadJavaScriptTool({
                browser: makeBrowserMock({ syncResult: JSON.stringify({ value: "ok" }) }),
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
                browser: makeBrowserMock({ syncResult: JSON.stringify({ error: thrownObj }) }),
                resolveTab: jest.fn(async () => 1),
            });
            await expect(
                handler({ action: "javascript_exec", text: "throw { code: 404, message: 'Not found' }" })
            ).rejects.toThrow(/404/);
        });
    });

    describe("bridge code validation", () => {
        /**
         * Loads the handler, runs it with sync result, and captures the bridge code.
         */
        async function captureGeneratedCode(userCode) {
            let capturedCode = null;
            const browser = {
                tabs: {
                    executeScript: jest.fn(async (_tabId, { code }) => {
                        capturedCode = code;
                        return [JSON.stringify({ value: "ok" })];
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
            await handler({ action: "javascript_exec", text: userCode });
            return capturedCode;
        }

        test("generated bridge code contains the correlationId with lowercase prefix", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toMatch(/__claudejstoolresult_[a-z0-9]+/);
        });

        test("correlationId is unique per invocation", async () => {
            const code1 = await captureGeneratedCode("1+1");
            const code2 = await captureGeneratedCode("2+2");
            const id1 = code1.match(/__claudejstoolresult_[a-z0-9]+/)?.[0];
            const id2 = code2.match(/__claudejstoolresult_[a-z0-9]+/)?.[0];
            expect(id1).toBeTruthy();
            expect(id2).toBeTruthy();
            expect(id1).not.toBe(id2);
        });

        test("generated code embeds MAX_OUTPUT numeric value", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("100000");
        });

        test("generated bridge code writes result to data-claude-js-result- DOM attribute", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("data-claude-js-result-");
            expect(code).toContain("setAttribute");
        });

        test("generated bridge code creates a script element for main-world execution", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("createElement('script')");
            expect(code).toContain("textContent");
            expect(code).toContain("appendChild");
        });

        test("generated bridge code reads result attribute back synchronously", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("getAttribute");
            expect(code).toContain("removeAttribute");
        });

        test("bridge returns null when result attribute is not set (async code)", async () => {
            const code = await captureGeneratedCode("1+1");
            // The bridge ends with: if(r){...;return r} return null
            expect(code).toContain("return null");
        });

        test("user code with double-quotes is safely escaped in generated code", async () => {
            const userCode = 'document.querySelector("h1").textContent';
            const code = await captureGeneratedCode(userCode);
            // User code must NOT appear raw (unescaped) in the bridge string.
            // It is double-JSON-encoded (once for eval arg, once for textContent).
            // Verify the raw user code is not a direct substring (quotes are escaped).
            expect(code).not.toContain(userCode);
            // But the escaped form should be present (backslash-escaped quotes)
            expect(code).toContain("document.querySelector(");
            expect(code).toContain("h1");
        });

        test("user code with special characters is embedded via JSON.stringify in eval()", async () => {
            const userCode = "const x = '<div>'; x";
            const code = await captureGeneratedCode(userCode);
            // User code is passed to eval() via JSON.stringify, so it should
            // appear as a JSON-encoded string (with escaped quotes) not raw.
            expect(code).toContain("eval(");
            // The user code should be present in the generated bridge
            expect(code).toContain("const x");
            expect(code).toContain("<div>");
        });

        test("bridge uses eval() for user code execution", async () => {
            const code = await captureGeneratedCode("1+1");
            expect(code).toContain("eval(");
        });
    });
});
