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
        // Task 3 — T1–T5, T17, T18, T19, T24, T27
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
