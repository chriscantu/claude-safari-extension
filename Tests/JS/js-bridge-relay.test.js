/**
 * @jest-environment jsdom
 */

/**
 * Tests for content-scripts/js-bridge-relay.js
 *
 * js-bridge-relay.js is a persistent content script that polls for DOM attributes
 * written by javascript_tool's main-world <script> element, then forwards them
 * to the background via browser.runtime.sendMessage.
 *
 * WHY jest.useFakeTimers(): The relay uses setInterval. Fake timers let us
 * advance the interval without real async waits.
 *
 * WHY jsdom (default test env): DOM attribute read/write is the core mechanism.
 * jsdom's document.documentElement supports getAttribute/setAttribute.
 *
 * Covers:
 *   T1  — No matching attributes: sendMessage not called
 *   T2  — Matching attribute: sendMessage called with corrId + value
 *   T3  — Multiple attributes in same poll tick: both relayed
 *   T4  — Attribute is removed before sendMessage is called (atomicity)
 *   T5  — corrId extracted correctly from attribute name
 *   T6  — JSON parse error: sendMessage called with error payload
 *   T7  — sendMessage failure: error logged, does not throw or stop polling
 *   T8  — Non-matching attributes ignored
 *   T9  — Message payload shape: { [corrId]: true, value, error }
 */

"use strict";

const SCRIPT_PATH = require.resolve(
    "../../ClaudeInSafari Extension/Resources/content-scripts/js-bridge-relay.js"
);

const JS_RESULT_ATTR_PREFIX = "data-claude-js-result-";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBrowserMock(opts = {}) {
    const { sendMessageRejects = false } = opts;
    return {
        runtime: {
            sendMessage: jest.fn(() =>
                sendMessageRejects
                    ? Promise.reject(new Error("Extension context invalidated"))
                    : Promise.resolve()
            ),
        },
    };
}

function loadRelay(browser) {
    globalThis.browser = browser;
    jest.isolateModules(() => {
        require(SCRIPT_PATH);
    });
}

function setAttr(corrId, value) {
    document.documentElement.setAttribute(
        JS_RESULT_ATTR_PREFIX + corrId,
        JSON.stringify(value)
    );
}

function setRawAttr(corrId, raw) {
    document.documentElement.setAttribute(JS_RESULT_ATTR_PREFIX + corrId, raw);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("js-bridge-relay.js", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        // Clean up any leftover attributes from previous tests
        const attrs = Array.from(document.documentElement.attributes);
        attrs.forEach(a => {
            if (a.name.startsWith(JS_RESULT_ATTR_PREFIX)) {
                document.documentElement.removeAttribute(a.name);
            }
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.resetModules();
        delete globalThis.browser;
    });

    test("T1 — no matching attributes: sendMessage not called", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        jest.advanceTimersByTime(50);

        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test("T2 — matching attribute: sendMessage called with corrId and value", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        const corrId = "abc123";
        setAttr(corrId, { value: "hello" });

        jest.advanceTimersByTime(50);

        expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ [corrId]: true, value: "hello" })
        );
    });

    test("T3 — multiple attributes in same poll: both relayed", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        setAttr("corr1", { value: "result1" });
        setAttr("corr2", { value: "result2" });

        jest.advanceTimersByTime(50);

        expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2);
        const calls = browser.runtime.sendMessage.mock.calls.map(([msg]) => msg);
        expect(calls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ corr1: true, value: "result1" }),
                expect.objectContaining({ corr2: true, value: "result2" }),
            ])
        );
    });

    test("T4 — attribute removed before sendMessage is called (atomicity)", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        const corrId = "atomtest";
        setAttr(corrId, { value: "data" });

        jest.advanceTimersByTime(50);

        // Attribute must be removed atomically before sendMessage fires,
        // so a second poll tick cannot re-read it.
        expect(document.documentElement.getAttribute(JS_RESULT_ATTR_PREFIX + corrId)).toBeNull();
    });

    test("T5 — corrId extracted correctly from attribute name", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        const corrId = "__claudejstoolresult_xyz789";
        setAttr(corrId, { value: "42" });

        jest.advanceTimersByTime(50);

        const [msg] = browser.runtime.sendMessage.mock.calls[0];
        expect(msg[corrId]).toBe(true);
    });

    test("T6 — JSON parse error: sendMessage called with error payload", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        const corrId = "parsetest";
        setRawAttr(corrId, "{ not valid json }");

        jest.advanceTimersByTime(50);

        expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                [corrId]: true,
                error: expect.stringContaining("parse"),
            })
        );
    });

    test("T7 — sendMessage rejection: error logged, polling continues", async () => {
        const browser = makeBrowserMock({ sendMessageRejects: true });
        loadRelay(browser);

        setAttr("failcorr", { value: "data" });
        jest.advanceTimersByTime(50);

        // Let the rejected Promise's .catch() run
        await Promise.resolve();

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("js-bridge-relay"),
            expect.stringContaining("failcorr"),
            expect.anything()
        );

        // Polling should continue: a second attribute should still be relayed
        browser.runtime.sendMessage.mockResolvedValue(undefined);
        setAttr("nextcorr", { value: "ok" });
        jest.advanceTimersByTime(50);

        expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ nextcorr: true })
        );
    });

    test("T8 — non-matching attributes ignored", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        document.documentElement.setAttribute("data-other-attr", "irrelevant");
        document.documentElement.setAttribute("unrelated", "value");

        jest.advanceTimersByTime(50);

        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test("T9 — message payload shape: { [corrId]: true, value?, error? }", () => {
        const browser = makeBrowserMock();
        loadRelay(browser);

        setAttr("shapecorr", { value: "the-result", error: undefined });

        jest.advanceTimersByTime(50);

        const [msg] = browser.runtime.sendMessage.mock.calls[0];
        expect(msg).toHaveProperty("shapecorr", true);
        expect(msg).toHaveProperty("value", "the-result");
        // error key may be present as undefined — that is fine
    });
});
