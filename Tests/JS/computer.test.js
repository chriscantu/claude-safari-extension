/**
 * @jest-environment jsdom
 *
 * Tests for tools/computer.js
 * See Spec 010 (computer-mouse-keyboard).
 *
 * T1–T5, T17, T24, T27: Run injected IIFE in real jsdom DOM via vm.runInNewContext.
 *   Exercises event dispatch, ref resolution, coordinate bounds checking.
 * All other tests: Mock executeScript to test handler-layer validation and error paths.
 *
 * KNOWN GAP — scrollBy / scrollIntoView:
 *   jsdom does not implement layout-based scrolling. Scroll IIFE tests verify the
 *   handler returns a success string; actual scroll position is not asserted.
 */

"use strict";

// ---------------------------------------------------------------------------
// Browser mock helpers
// ---------------------------------------------------------------------------

/**
 * Runs the injected IIFE code string in a vm sandbox seeded with jsdom's live
 * document and necessary globals. Used for T1–T5, T17, T24, T27 so that DOM
 * event dispatch, ref resolution, and coordinate bounds checking run for real.
 */
function makeBrowserMockWithDomEval() {
    const vm = require("vm");
    return {
        tabs: {
            executeScript: jest.fn(async (_tabId, { code }) => {
                const sandbox = {
                    document: globalThis.document,
                    window: {
                        innerWidth: 1280,
                        innerHeight: 800,
                        getComputedStyle: (...a) => globalThis.getComputedStyle(...a),
                        HTMLInputElement:  globalThis.HTMLInputElement,
                        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
                        scrollingElement: globalThis.document.scrollingElement,
                        scrollBy: jest.fn(),
                        scrollTo: jest.fn(),
                    },
                    PointerEvent: globalThis.PointerEvent || globalThis.MouseEvent,
                    MouseEvent:   globalThis.MouseEvent,
                    KeyboardEvent: globalThis.KeyboardEvent,
                    InputEvent:   globalThis.InputEvent,
                    Event:        globalThis.Event,
                    CSS:          globalThis.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, "\\$&") },
                    Object:       Object,
                    Math:         Math,
                    Array:        Array,
                    console:      globalThis.console,
                };
                return [vm.runInNewContext(code, sandbox)];
            }),
        },
        alarms: {
            create: jest.fn(),
            onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
        },
    };
}

/**
 * Returns a pre-set result without running the IIFE. Used for handler-layer
 * tests (validation, error paths, tab resolution).
 */
function makeBrowserMock(opts = {}) {
    const { scriptResult = [{ success: true }], scriptError = null } = opts;
    return {
        tabs: {
            executeScript: jest.fn(async () => {
                if (scriptError) throw scriptError;
                return scriptResult;
            }),
        },
        alarms: {
            create: jest.fn(),
            onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
        },
    };
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

/**
 * Loads computer.js in isolation and returns the registered handler.
 * Follows the get-page-text.test.js pattern: tool-registry.js is loaded first
 * (sets globalThis.classifyExecuteScriptError), then registerTool is overridden
 * to capture the handler reference before loading computer.js.
 */
function loadComputer({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/computer.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Creates a button element with a data-claude-ref attribute, a mocked
 * getBoundingClientRect returning a 20×20 box at (90, 190), and appends it
 * to document.body. Used for ref-based click and hover tests.
 */
function appendRefElement(ref, tag = "button") {
    const el = document.createElement(tag);
    el.setAttribute("data-claude-ref", ref);
    el.getBoundingClientRect = jest.fn(() => ({
        left: 90, top: 190, width: 20, height: 20,
        right: 110, bottom: 210, x: 90, y: 190,
    }));
    document.body.appendChild(el);
    return el;
}

/**
 * Creates a ref element with a zero-size bounding rect. Used for T27.
 */
function appendZeroSizeRefElement(ref, tag = "span") {
    const el = document.createElement(tag);
    el.setAttribute("data-claude-ref", ref);
    el.getBoundingClientRect = jest.fn(() => ({
        left: 0, top: 0, width: 0, height: 0,
        right: 0, bottom: 0, x: 0, y: 0,
    }));
    document.body.appendChild(el);
    return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computer tool", () => {
    afterEach(() => {
        document.body.replaceChildren();
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    describe("left_click / right_click / double_click / triple_click", () => {
        test("T1 — left_click at coordinate dispatches click + mousedown", async () => {
            const el = document.createElement("button");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            const events = [];
            el.addEventListener("click",     () => events.push("click"));
            el.addEventListener("mousedown", () => events.push("mousedown"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "left_click", coordinate: [100, 200] });

            expect(events).toContain("click");
            expect(events).toContain("mousedown");
            expect(result).toMatch(/100/);
            expect(result).toMatch(/200/);
        });

        test("T2 — left_click with ref: dispatches at element center", async () => {
            const el = appendRefElement("ref_5");
            document.elementFromPoint = jest.fn(() => el);

            const events = [];
            el.addEventListener("click", () => events.push("click"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "left_click", ref: "ref_5" });

            expect(events).toContain("click");
            expect(result).toContain("ref_5");
        });

        test("T3 — right_click dispatches contextmenu event", async () => {
            const el = document.createElement("div");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            const events = [];
            el.addEventListener("contextmenu", () => events.push("contextmenu"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "right_click", coordinate: [100, 200] });

            expect(events).toContain("contextmenu");
        });

        test("T4 — double_click dispatches dblclick event", async () => {
            const el = document.createElement("div");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            const events = [];
            el.addEventListener("dblclick", () => events.push("dblclick"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "double_click", coordinate: [100, 200] });

            expect(events).toContain("dblclick");
        });

        test("T5 — triple_click dispatches exactly 3 click events", async () => {
            const el = document.createElement("div");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            const events = [];
            el.addEventListener("click", () => events.push("click"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "triple_click", coordinate: [100, 200] });

            expect(events.filter(e => e === "click").length).toBe(3);
        });

        test("T17 — shift modifier: shiftKey is true on dispatched click event", async () => {
            const el = document.createElement("button");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            let capturedEvent = null;
            el.addEventListener("click", (e) => { capturedEvent = e; });

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "left_click", coordinate: [100, 200], modifiers: "shift" });

            expect(capturedEvent).not.toBeNull();
            expect(capturedEvent.shiftKey).toBe(true);
        });

        test("T18 — both coordinate and ref provided: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });

            await expect(
                handler({ action: "left_click", coordinate: [100, 200], ref: "ref_1" })
            ).rejects.toThrow("Provide either coordinate or ref, not both");
        });

        test("T19 — no coordinate or ref for left_click: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });

            await expect(
                handler({ action: "left_click" })
            ).rejects.toThrow(/Provide coordinate or ref/);
        });

        test("T24 — coordinate outside viewport: IIFE returns error", async () => {
            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await expect(
                handler({ action: "left_click", coordinate: [-1, -1] })
            ).rejects.toThrow(/outside the viewport/);
        });

        test("T27 — ref with zero-size bounding rect: IIFE returns error", async () => {
            appendZeroSizeRefElement("ref_0");

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await expect(
                handler({ action: "left_click", ref: "ref_0" })
            ).rejects.toThrow(/no visible bounding rect/);
        });
    });

    describe("type", () => {
        // Task 5 — T6, T20, T26
    });

    describe("key", () => {
        // Task 5 — T7, T8, T9
    });

    describe("wait", () => {
        // Task 6 — T10, T21, T28
        // wait uses setTimeout (≤20s) or browser.alarms (>20s) in the handler layer.
        // No executeScript — use makeBrowserMock(), not makeBrowserMockWithDomEval().
    });

    describe("scroll", () => {
        // Task 6 — T11, T12, T23
    });

    describe("scroll_to", () => {
        // Task 6 — T13
    });

    describe("left_click_drag", () => {
        // Task 7 — T14, T25
    });

    describe("hover", () => {
        // Task 7 — T15, T16
    });

    describe("error handling", () => {
        // Task 7 — T22 (invalid tab)
    });

    describe("registration", () => {
        // Task 8 — registers "computer"
    });
});
