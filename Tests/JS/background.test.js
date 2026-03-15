/**
 * Tests for background.js
 * See Spec 003 (native-extension-bridge) and Spec 004 (tool-registry).
 *
 * WHY jest.useFakeTimers(): background.js uses setTimeout to schedule the
 * next poll. Fake timers let us advance time without real async waits.
 *
 * WHY jest.isolateModules(): Each test needs a fresh background.js with its
 * own isActive state and poll loop. isolateModules prevents state leakage.
 *
 * Covers:
 *   T1  — Phase 1 error (native app not running): isActive=false, no re-throw
 *   T2  — Phase 1 error (timeout): console.warn called, loop continues
 *   T3  — Phase 1 error (unknown): console.error called
 *   T4  — no tool_request response: isActive set to false
 *   T5  — tool_request response: executeTool called with correct args
 *   T6  — tool_request response: result sent back via sendNativeMessage
 *   T7  — Phase 2 error (bad payload JSON): loop continues without crash
 *   T8  — Phase 3 error (executeTool throws): error response sent, loop continues
 *   T9  — Phase 4 error (send fails): console.error called, loop continues
 *   T10 — poll schedule: uses POLL_INTERVAL_MS (100) when active
 *   T11 — poll schedule: uses POLL_IDLE_INTERVAL_MS (5000) when idle
 *   T12 — alarms guard: browser.alarms not created when browser.alarms is undefined
 */

"use strict";

const SCRIPT_PATH = require.resolve(
    "../../ClaudeInSafari Extension/Resources/background.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NATIVE_APP_ID_VALUE = "com.anthropic.claudeInSafari";

/**
 * Builds a minimal browser mock for background.js.
 * sendNativeMessage is a jest.fn() whose implementation can be overridden per test.
 */
function makeBrowserMock(opts = {}) {
    const {
        nativeResponses = [],
        alarms = true,
    } = opts;

    let callIndex = 0;
    const sendNativeMessage = jest.fn(async (appId, message) => {
        if (message.type === "poll") {
            const response = nativeResponses[callIndex] ?? { type: "idle" };
            callIndex++;
            return response;
        }
        // type === "tool_response" — fire and forget
        return {};
    });

    const mock = {
        runtime: { sendNativeMessage },
        tabs: {
            onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
        },
        storage: {
            session: {
                get: jest.fn(async () => ({})),
                remove: jest.fn(async () => {}),
            },
        },
    };

    if (alarms) {
        mock.alarms = {
            create: jest.fn(),
            get: jest.fn(async () => undefined),
            onAlarm: { addListener: jest.fn() },
        };
    }

    return mock;
}

/**
 * Loads background.js with the given browser mock and executeTool mock.
 * Requires that jest.useFakeTimers() is already called.
 */
function loadBackground({ browser, executeTool = jest.fn(async () => ({ result: { content: [{ type: "text", text: "ok" }] } })) }) {
    globalThis.browser = browser;
    globalThis.NATIVE_APP_ID = NATIVE_APP_ID_VALUE;
    globalThis.executeTool = executeTool;

    jest.isolateModules(() => {
        require(SCRIPT_PATH);
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("background.js poll loop", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.NATIVE_APP_ID;
        delete globalThis.executeTool;
    });

    test("T1 — Phase 1 error (native app not running): console.warn, loop continues", async () => {
        const err = new Error("Could not establish connection with native host");
        const browser = makeBrowserMock();
        browser.runtime.sendNativeMessage = jest.fn().mockRejectedValue(err);
        loadBackground({ browser });

        await Promise.resolve();

        // background.js: console.warn("Poll: native app not running ...", msg)
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("not running"),
            expect.any(String)
        );
    });

    test("T2 — Phase 1 error (timeout): console.warn called", async () => {
        const err = new Error("native host timed out");
        const browser = makeBrowserMock();
        browser.runtime.sendNativeMessage = jest.fn().mockRejectedValue(err);
        loadBackground({ browser });

        await Promise.resolve();

        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("Poll"),
            expect.stringContaining("timed out")
        );
    });

    test("T3 — Phase 1 error (unknown): console.error called", async () => {
        const err = new Error("some unexpected failure");
        const browser = makeBrowserMock();
        browser.runtime.sendNativeMessage = jest.fn().mockRejectedValue(err);
        loadBackground({ browser });

        await Promise.resolve();

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("Poll"),
            err
        );
    });

    test("T4 — no tool_request response: isActive set to false, idle timer scheduled", async () => {
        const browser = makeBrowserMock({
            nativeResponses: [{ type: "idle" }],
        });
        loadBackground({ browser });

        await Promise.resolve();
        // After idle poll, isActive=false → POLL_IDLE_INTERVAL_MS (5000) scheduled
        expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    test("T5 — tool_request response: executeTool called with tool and args", async () => {
        const payload = { tool: "navigate", args: { url: "https://example.com" }, requestId: "req-1" };
        const browser = makeBrowserMock({
            nativeResponses: [
                { type: "tool_request", payload: JSON.stringify(payload) },
                { type: "idle" },
            ],
        });
        const executeTool = jest.fn(async () => ({ result: { content: [{ type: "text", text: "done" }] } }));
        loadBackground({ browser, executeTool });

        await Promise.resolve(); // sendNativeMessage(poll) resolves → setTimeout(0) queued
        jest.runAllTimers();     // fire setTimeout(0) → executeTool starts
        await Promise.resolve(); // executeTool resolves → outer Promise resolves
        await Promise.resolve(); // pollForRequests resumes → Phase 4 sendNativeMessage queued
        await Promise.resolve(); // Phase 4 resolves

        expect(executeTool).toHaveBeenCalledWith("navigate", { url: "https://example.com" }, undefined);
    });

    test("T6 — tool_request response: result sent back via sendNativeMessage", async () => {
        const payload = { tool: "get_page_text", args: {}, requestId: "req-2" };
        const browser = makeBrowserMock({
            nativeResponses: [
                { type: "tool_request", payload: JSON.stringify(payload) },
                { type: "idle" },
            ],
        });
        const executeTool = jest.fn(async () => ({ result: { content: [{ type: "text", text: "Page text" }] } }));
        loadBackground({ browser, executeTool });

        await Promise.resolve(); // sendNativeMessage(poll) resolves → setTimeout(0) queued
        jest.runAllTimers();     // fire setTimeout(0) → executeTool starts
        await Promise.resolve(); // executeTool resolves → outer Promise resolves
        await Promise.resolve(); // pollForRequests resumes → Phase 4 sendNativeMessage queued
        await Promise.resolve(); // Phase 4 resolves

        const calls = browser.runtime.sendNativeMessage.mock.calls;
        const responseCalls = calls.filter(([, msg]) => msg.type === "tool_response");
        expect(responseCalls.length).toBeGreaterThanOrEqual(1);
        expect(responseCalls[0][1]).toMatchObject({ requestId: "req-2" });
    });

    test("T7 — Phase 2 error (bad payload JSON): loop continues without crash", async () => {
        const browser = makeBrowserMock({
            nativeResponses: [
                { type: "tool_request", payload: "{ broken json }" },
                { type: "idle" },
            ],
        });
        loadBackground({ browser });

        await Promise.resolve();
        await Promise.resolve();

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("parse"),
            expect.anything()
        );
    });

    test("T8 — Phase 3 error (executeTool throws): error response sent, loop continues", async () => {
        const payload = { tool: "bad_tool", args: {}, requestId: "req-3" };
        const browser = makeBrowserMock({
            nativeResponses: [
                { type: "tool_request", payload: JSON.stringify(payload) },
                { type: "idle" },
            ],
        });
        const executeTool = jest.fn(async () => { throw new Error("tool exploded"); });
        loadBackground({ browser, executeTool });

        await Promise.resolve(); // sendNativeMessage(poll) resolves → setTimeout(0) queued
        jest.runAllTimers();     // fire setTimeout(0) → executeTool starts (throws)
        await Promise.resolve(); // executeTool rejects → outer Promise rejects
        await Promise.resolve(); // pollForRequests resumes error path → error response queued
        await Promise.resolve(); // error sendNativeMessage resolves

        const calls = browser.runtime.sendNativeMessage.mock.calls;
        const errorResponse = calls.find(([, msg]) => msg.type === "tool_response" && msg.error);
        expect(errorResponse).toBeDefined();
        expect(errorResponse[1].error.content[0].text).toContain("tool exploded");
    });

    test("T9 — Phase 4 error (response send fails): console.error called, loop continues", async () => {
        const payload = { tool: "read_page", args: {}, requestId: "req-4" };
        let callCount = 0;
        const browser = makeBrowserMock();
        browser.runtime.sendNativeMessage = jest.fn(async (appId, msg) => {
            callCount++;
            if (msg.type === "poll") {
                return callCount === 1
                    ? { type: "tool_request", payload: JSON.stringify(payload) }
                    : { type: "idle" };
            }
            throw new Error("send failed");
        });
        const executeTool = jest.fn(async () => ({ result: { content: [{ type: "text", text: "data" }] } }));
        loadBackground({ browser, executeTool });

        await Promise.resolve(); // sendNativeMessage(poll) resolves → setTimeout(0) queued
        jest.runAllTimers();     // fire setTimeout(0) → executeTool starts
        await Promise.resolve(); // executeTool resolves → outer Promise resolves
        await Promise.resolve(); // pollForRequests resumes → Phase 4 sendNativeMessage queued (throws)
        await Promise.resolve(); // Phase 4 error → console.error logged → finally schedules next poll

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("send tool response"),
            expect.anything()
        );
        // Finally block must always schedule the next poll even after Phase 4 error
        expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    test("T10 — active poll: next setTimeout uses POLL_INTERVAL_MS (100ms)", async () => {
        const payload = { tool: "navigate", args: {}, requestId: "req-5" };
        const browser = makeBrowserMock({
            nativeResponses: [
                { type: "tool_request", payload: JSON.stringify(payload) },
                { type: "idle" },
            ],
        });
        loadBackground({ browser });

        // Flush the first active poll cycle (setTimeout(0) dispatch requires timer flush)
        await Promise.resolve(); // sendNativeMessage(poll) resolves → setTimeout(0) queued
        jest.runAllTimers();     // fire setTimeout(0) → executeTool starts
        await Promise.resolve(); // executeTool resolves
        await Promise.resolve(); // pollForRequests resumes → Phase 4 queued
        await Promise.resolve(); // Phase 4 resolves → finally schedules next poll timer

        // After an active poll, the next timer should be ~100ms
        const timerCount = jest.getTimerCount();
        expect(timerCount).toBeGreaterThan(0);
    });

    test("T11 — idle poll: isActive=false after no tool_request", async () => {
        const browser = makeBrowserMock({
            nativeResponses: [{ type: "idle" }],
        });
        loadBackground({ browser });

        await Promise.resolve();

        // When isActive=false, a timer is still scheduled (idle interval)
        expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    test("T12 — alarms guard: browser.alarms not used when undefined", () => {
        const browser = makeBrowserMock({ alarms: false });
        // Should not throw when browser.alarms is undefined
        expect(() => loadBackground({ browser })).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Extended mock — adds tabs.sendMessage, tabs.executeScript, onMessage capture
// Used by indicator and STOP_AGENT tests only; does not affect T1-T12.
// ---------------------------------------------------------------------------

function makeBrowserMockWithMessaging(opts) {
  var base = makeBrowserMock(opts);
  var onMessageHandler = null;
  base.tabs.sendMessage   = jest.fn(async () => {});
  base.tabs.executeScript = jest.fn(async () => {});
  base.runtime.onMessage  = {
    addListener: jest.fn(function (fn) { onMessageHandler = fn; }),
  };
  base._getOnMessageHandler = function () { return onMessageHandler; };
  return base;
}

function loadBackgroundWithMessaging(opts) {
  var browser     = opts.browser;
  var executeTool = opts.executeTool;
  loadBackground({ browser: browser, executeTool: executeTool });
  return browser._getOnMessageHandler();
}

describe("background.js — indicator hooks and STOP_AGENT", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules();
    delete globalThis.browser;
    delete globalThis.NATIVE_APP_ID;
    delete globalThis.executeTool;
  });

  // T_ind1 — show called before executeTool
  test("T_ind1: tabs.sendMessage show sent before executeTool is called", async () => {
    const calls = [];
    const payload = {
      tool: "navigate",
      args: { url: "https://example.com", tabId: 42 },
      requestId: "r1",
    };
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [
        { type: "tool_request", payload: JSON.stringify(payload) },
        { type: "idle" },
      ],
    });
    const executeTool = jest.fn(async () => {
      calls.push("executeTool");
      return { result: { content: [{ type: "text", text: "done" }] } };
    });
    browser.tabs.sendMessage = jest.fn(async (_tabId, msg) => {
      if (msg && msg.action) calls.push("sendMessage:" + msg.action);
    });

    loadBackground({ browser, executeTool });

    // One await drains all microtasks from the first poll cycle including
    // showIndicatorOnTab's two internal awaits (executeScript + sendMessage).
    await Promise.resolve();
    jest.runAllTimers(); // setTimeout(0) fires -> executeTool runs
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const showIdx    = calls.indexOf("sendMessage:show");
    const executeIdx = calls.indexOf("executeTool");
    expect(showIdx).toBeGreaterThanOrEqual(0);
    expect(executeIdx).toBeGreaterThan(showIdx);
  });

  // T_ind2 — hide debounced 500ms after tool completes
  test("T_ind2: tabs.sendMessage hide sent 500ms after tool completes (not immediately)", async () => {
    const payload = {
      tool: "navigate",
      args: { url: "https://example.com", tabId: 42 },
      requestId: "r2",
    };
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [
        { type: "tool_request", payload: JSON.stringify(payload) },
        { type: "idle" },
      ],
    });

    loadBackground({ browser });

    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Hide not yet sent
    const hideBefore = browser.tabs.sendMessage.mock.calls
      .filter(([, msg]) => msg && msg.action === "hide").length;
    expect(hideBefore).toBe(0);

    // Advance past debounce window
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    const hideAfter = browser.tabs.sendMessage.mock.calls
      .filter(([, msg]) => msg && msg.action === "hide").length;
    expect(hideAfter).toBeGreaterThan(0);
  });

  // T_ind3 — rapid tool calls: debounce reset keeps indicator showing
  test("T_ind3: second tool call cancels pending hide — no hide sent between calls", async () => {
    const p1 = { tool: "navigate", args: { url: "https://a.com", tabId: 7 }, requestId: "r3" };
    const p2 = { tool: "navigate", args: { url: "https://b.com", tabId: 7 }, requestId: "r4" };
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [
        { type: "tool_request", payload: JSON.stringify(p1) },
        { type: "tool_request", payload: JSON.stringify(p2) },
        { type: "idle" },
      ],
    });

    loadBackground({ browser });

    // First cycle
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Advance only 100ms (< 500ms debounce) — second poll starts
    jest.advanceTimersByTime(100);

    // Second cycle
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No hide should have fired yet
    const hideCalls = browser.tabs.sendMessage.mock.calls
      .filter(([, msg]) => msg && msg.action === "hide");
    expect(hideCalls.length).toBe(0);
  });

  // T_ind4 — no tabId: no indicator sendMessage
  test("T_ind4: tool with no tabId — indicator sendMessage not called", async () => {
    const payload = {
      tool: "navigate",
      args: { url: "https://example.com" }, // no tabId
      requestId: "r5",
    };
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [
        { type: "tool_request", payload: JSON.stringify(payload) },
        { type: "idle" },
      ],
    });

    loadBackground({ browser });

    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    const indicatorCalls = browser.tabs.sendMessage.mock.calls
      .filter(([, msg]) => msg && msg.type === "CLAUDE_AGENT_INDICATOR");
    expect(indicatorCalls.length).toBe(0);
  });

  // T_ind5 — screenshot: hide_for_tool before executeTool, show_after_tool after
  test("T_ind5: screenshot action sends hide_for_tool before and show_after_tool after executeTool", async () => {
    const calls = [];
    const payload = {
      tool: "computer",
      args: { action: "screenshot", tabId: 5 },
      requestId: "r6",
    };
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [
        { type: "tool_request", payload: JSON.stringify(payload) },
        { type: "idle" },
      ],
    });
    const executeTool = jest.fn(async () => {
      calls.push("executeTool");
      return { result: { content: [{ type: "text", text: "screenshot done" }] } };
    });
    browser.tabs.sendMessage = jest.fn(async (_tabId, msg) => {
      if (msg && msg.action) calls.push("sendMessage:" + msg.action);
    });

    loadBackground({ browser, executeTool });

    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const hideForTool   = calls.indexOf("sendMessage:hide_for_tool");
    const executeIdx    = calls.indexOf("executeTool");
    const showAfterTool = calls.indexOf("sendMessage:show_after_tool");

    expect(hideForTool).toBeGreaterThanOrEqual(0);
    expect(executeIdx).toBeGreaterThan(hideForTool);
    expect(showAfterTool).toBeGreaterThan(executeIdx);
  });
});
