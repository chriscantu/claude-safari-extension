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
 *
 * KNOWN GAP — execCommand:
 *   jsdom does not implement execCommand meaningfully. T26 asserts it was called,
 *   not that text was inserted.
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
            clear: jest.fn(),
            get: jest.fn(() => Promise.resolve(undefined)),
            onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
        },
        storage: {
            session: {
                get: jest.fn(() => Promise.resolve({})),
                set: jest.fn(() => Promise.resolve()),
                remove: jest.fn(() => Promise.resolve()),
            },
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
            clear: jest.fn(),
            get: jest.fn(() => Promise.resolve(undefined)),
            onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
        },
        storage: {
            session: {
                get: jest.fn(() => Promise.resolve({})),
                set: jest.fn(() => Promise.resolve()),
                remove: jest.fn(() => Promise.resolve()),
            },
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

    describe("action routing", () => {
        test("null action rejects with 'action is required'", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(handler({ action: null })).rejects.toThrow("action is required");
        });

        test("undefined action rejects with 'action is required'", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(handler({})).rejects.toThrow("action is required");
        });

        test("unknown action rejects with 'Invalid action'", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(handler({ action: "bogus" })).rejects.toThrow(/Invalid action/);
        });
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

        test("ref not found for left_click: rejects with 'not found'", async () => {
            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "left_click", ref: "ref_nonexistent" })
            ).rejects.toThrow(/not found/);
        });
    });

    describe("type", () => {
        test("T6 — type text dispatches keyboard + input events on active element", async () => {
            const input = document.createElement("input");
            document.body.appendChild(input);
            input.focus();

            const events = [];
            input.addEventListener("keydown", () => events.push("keydown"));
            input.addEventListener("keyup",   () => events.push("keyup"));
            input.addEventListener("input",   () => events.push("input"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "type", text: "hi" });

            expect(events).toContain("keydown");
            expect(events).toContain("keyup");
            expect(events).toContain("input");
            expect(result).toBe('Typed "hi"');
        });

        test("T20 — type with no text: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(handler({ action: "type" })).rejects.toThrow(/text parameter is required/);
        });

        test("T26 — type on contenteditable: uses execCommand fallback", async () => {
            const div = document.createElement("div");
            div.setAttribute("contenteditable", "true");
            document.body.appendChild(div);
            div.focus();

            document.execCommand = jest.fn(() => true);

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "type", text: "hello" });

            expect(document.execCommand).toHaveBeenCalledWith("insertText", false, "hello");
        });
    });

    describe("key", () => {
        test("key with no text: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(handler({ action: "key" })).rejects.toThrow(/text parameter is required/);
        });

        test("key repeat 0: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "key", text: "Enter", repeat: 0 })
            ).rejects.toThrow(/repeat must be between 1 and 100/);
        });

        test("key repeat 101: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "key", text: "Enter", repeat: 101 })
            ).rejects.toThrow(/repeat must be between 1 and 100/);
        });

        test("key repeat false (boolean coercion to 0): rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "key", text: "Enter", repeat: false })
            ).rejects.toThrow(/repeat must be between 1 and 100/);
        });

        test("T7 — key Enter dispatches keydown + keyup events", async () => {
            const events = [];
            document.addEventListener("keydown", (e) => events.push({ type: e.type, key: e.key }));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "key", text: "Enter" });

            expect(events.some(e => e.type === "keydown" && e.key === "Enter")).toBe(true);
            expect(result).toContain("Enter");
        });

        test("T8 — key cmd+a: dispatches with metaKey=true", async () => {
            let capturedEvent = null;
            document.addEventListener("keydown", (e) => { capturedEvent = e; });

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "key", text: "cmd+a" });

            expect(capturedEvent).not.toBeNull();
            expect(capturedEvent.metaKey).toBe(true);
            expect(capturedEvent.key).toBe("a");
        });

        test("T9 — key Backspace with repeat:5 dispatches 5 keydown events", async () => {
            const events = [];
            document.addEventListener("keydown", (e) => events.push(e.key));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({ action: "key", text: "Backspace", repeat: 5 });

            expect(events.filter(k => k === "Backspace").length).toBe(5);
        });
    });

    describe("wait", () => {
        // wait uses setTimeout (≤20s) or browser.alarms (>20s) in the handler layer.
        // No executeScript — use makeBrowserMock(), not makeBrowserMockWithDomEval().

        test("wait duration 0: resolves immediately", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            const result = await handler({ action: "wait", duration: 0 });
            expect(result).toBe("Waited 0 seconds");
        });

        test("wait duration -1: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(handler({ action: "wait", duration: -1 })).rejects.toThrow(/0 and 30 seconds/);
        });

        test("wait > 20s uses browser.alarms and resolves when alarm fires", async () => {
            let capturedAlarmName = null;
            let capturedListener = null;
            const browser = {
                tabs: { executeScript: jest.fn() },
                alarms: {
                    create: jest.fn((name) => { capturedAlarmName = name; }),
                    clear: jest.fn(),
                    get: jest.fn(() => Promise.resolve(undefined)),
                    onAlarm: {
                        addListener: jest.fn((fn) => { capturedListener = fn; }),
                        removeListener: jest.fn(),
                    },
                },
                storage: {
                    session: {
                        get: jest.fn(() => Promise.resolve({})),
                        set: jest.fn(() => Promise.resolve()),
                        remove: jest.fn(() => Promise.resolve()),
                    },
                },
            };

            const handler = loadComputer({ browser, resolveTab: jest.fn(async () => 42) });
            const promise = handler({ action: "wait", duration: 25 });

            // Allow storage.session.get microtask to resolve before accessing capturedListener
            await Promise.resolve();

            capturedListener({ name: capturedAlarmName });

            const result = await promise;
            expect(result).toBe("Waited 25 seconds");
            expect(browser.alarms.create).toHaveBeenCalledWith(
                expect.stringContaining("computer-wait-"),
                { delayInMinutes: expect.any(Number) }
            );
            expect(browser.storage.session.set).toHaveBeenCalledWith(
                expect.objectContaining({ "computer-wait-alarmName": expect.any(String) })
            );
            expect(browser.alarms.onAlarm.removeListener).toHaveBeenCalled();
            expect(browser.alarms.clear).toHaveBeenCalled();
            expect(browser.storage.session.remove).toHaveBeenCalledWith("computer-wait-alarmName");
        });

        test("wait > 20s: alarm fired while page suspended — returns immediately on resume", async () => {
            const storedAlarmName = "computer-wait-1234567890";
            const browser = {
                tabs: { executeScript: jest.fn() },
                alarms: {
                    create: jest.fn(),
                    clear: jest.fn(),
                    get: jest.fn(() => Promise.resolve(undefined)),
                    onAlarm: { addListener: jest.fn(), removeListener: jest.fn() },
                },
                storage: {
                    session: {
                        get: jest.fn(() => Promise.resolve({ "computer-wait-alarmName": storedAlarmName })),
                        set: jest.fn(() => Promise.resolve()),
                        remove: jest.fn(() => Promise.resolve()),
                    },
                },
            };

            const handler = loadComputer({ browser, resolveTab: jest.fn(async () => 42) });
            const result = await handler({ action: "wait", duration: 25 });

            expect(result).toBe("Waited 25 seconds");
            expect(browser.alarms.create).not.toHaveBeenCalled();
            expect(browser.storage.session.remove).toHaveBeenCalledWith("computer-wait-alarmName");
        });

        test("wait > 20s: alarm still pending on resume — re-registers listener without new alarm", async () => {
            const storedAlarmName = "computer-wait-1234567890";
            let capturedListener = null;
            const browser = {
                tabs: { executeScript: jest.fn() },
                alarms: {
                    create: jest.fn(),
                    clear: jest.fn(),
                    get: jest.fn(() => Promise.resolve({ name: storedAlarmName })),
                    onAlarm: {
                        addListener: jest.fn((fn) => { capturedListener = fn; }),
                        removeListener: jest.fn(),
                    },
                },
                storage: {
                    session: {
                        get: jest.fn(() => Promise.resolve({ "computer-wait-alarmName": storedAlarmName })),
                        set: jest.fn(() => Promise.resolve()),
                        remove: jest.fn(() => Promise.resolve()),
                    },
                },
            };

            const handler = loadComputer({ browser, resolveTab: jest.fn(async () => 42) });
            const promise = handler({ action: "wait", duration: 25 });

            // Two async awaits before listener registration: storage.session.get + alarms.get
            await Promise.resolve();
            await Promise.resolve();

            capturedListener({ name: storedAlarmName });

            const result = await promise;
            expect(result).toBe("Waited 25 seconds");
            expect(browser.alarms.create).not.toHaveBeenCalled();
            expect(browser.alarms.onAlarm.removeListener).toHaveBeenCalled();
            expect(browser.storage.session.remove).toHaveBeenCalledWith("computer-wait-alarmName");
        });

        test("T10 — wait 0.001 seconds returns confirmation", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "wait", duration: 0.001 });

            expect(result).toBe("Waited 0.001 seconds");
        });

        test("T21 — wait duration > 30: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });

            await expect(handler({ action: "wait", duration: 60 })).rejects.toThrow(/0 and 30 seconds/);
        });

        test("T28 — two concurrent wait calls each resolve independently", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });

            const [r1, r2] = await Promise.all([
                handler({ action: "wait", duration: 0.001 }),
                handler({ action: "wait", duration: 0.001 }),
            ]);

            expect(r1).toBe("Waited 0.001 seconds");
            expect(r2).toBe("Waited 0.001 seconds");
        });
    });

    describe("scroll", () => {
        test("scroll with missing scroll_direction: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "scroll" })
            ).rejects.toThrow("scroll_direction is required for scroll action");
        });

        test("scroll with invalid scroll_direction: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "scroll", scroll_direction: "sideways" })
            ).rejects.toThrow(/scroll_direction must be one of/);
        });

        test("scroll with scroll_amount 0: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "scroll", scroll_direction: "down", scroll_amount: 0 })
            ).rejects.toThrow(/scroll_amount must be between 1 and 10/);
        });

        test("scroll with scroll_amount 11: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "scroll", scroll_direction: "down", scroll_amount: 11 })
            ).rejects.toThrow(/scroll_amount must be between 1 and 10/);
        });

        test("T11 — scroll down 3 ticks at coordinate: returns confirmation", async () => {
            const el = document.body;
            el.scrollBy = jest.fn();
            document.elementFromPoint = jest.fn(() => el);

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "scroll", coordinate: [400, 300], scroll_direction: "down" });

            expect(result).toContain("down");
            expect(result).toContain("3");
            expect(result).toContain("400");
        });

        test("T12 — scroll up 5 ticks with no coordinate: defaults to viewport center", async () => {
            const el = document.body;
            el.scrollBy = jest.fn();
            document.elementFromPoint = jest.fn(() => el);

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "scroll", scroll_direction: "up", scroll_amount: 5 });

            expect(result).toContain("up");
            expect(result).toContain("5");
            expect(result).toContain("viewport center");
        });

        test("T23 — scroll with no coordinate: does not reject", async () => {
            const el = document.body;
            el.scrollBy = jest.fn();
            document.elementFromPoint = jest.fn(() => el);

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await expect(
                handler({ action: "scroll", scroll_direction: "down" })
            ).resolves.toBeDefined();
        });
    });

    describe("scroll_to", () => {
        test("scroll_to with no ref: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "scroll_to" })
            ).rejects.toThrow(/ref is required for scroll_to/);
        });

        test("scroll_to with nonexistent ref: rejects with 'not found'", async () => {
            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "scroll_to", ref: "ref_nonexistent" })
            ).rejects.toThrow(/not found/);
        });

        test("T13 — scroll_to ref: calls scrollIntoView on the element", async () => {
            const el = appendRefElement("ref_20");
            el.scrollIntoView = jest.fn();

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "scroll_to", ref: "ref_20" });

            expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
            expect(result).toContain("ref_20");
        });
    });

    describe("left_click_drag", () => {
        test("left_click_drag missing start_coordinate: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "left_click_drag", coordinate: [300, 300] })
            ).rejects.toThrow(/start_coordinate is required/);
        });

        test("left_click_drag missing coordinate: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "left_click_drag", start_coordinate: [100, 100] })
            ).rejects.toThrow(/coordinate is required for left_click_drag/);
        });

        test("T14 — drag from start to end: returns confirmation", async () => {
            document.elementFromPoint = jest.fn(() => document.body);

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({
                action: "left_click_drag",
                start_coordinate: [100, 100],
                coordinate: [300, 300],
            });

            expect(result).toContain("100");
            expect(result).toContain("300");
        });

        test("T25 — drag dispatches intermediate mousemove at midpoint", async () => {
            const el = document.createElement("div");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            const moves = [];
            el.addEventListener("mousemove", (e) => moves.push([e.clientX, e.clientY]));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            await handler({
                action: "left_click_drag",
                start_coordinate: [100, 100],
                coordinate: [300, 300],
            });

            // Midpoint (200, 200) must appear among the dispatched mousemoves
            expect(moves.some(([x, y]) => x === 200 && y === 200)).toBe(true);
        });
    });

    describe("hover", () => {
        test("hover with neither coordinate nor ref: rejects", async () => {
            const handler = loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            await expect(
                handler({ action: "hover" })
            ).rejects.toThrow(/Provide coordinate or ref/);
        });

        test("T15 — hover at coordinate dispatches mouseover + mousemove", async () => {
            const el = document.createElement("div");
            document.body.appendChild(el);
            document.elementFromPoint = jest.fn(() => el);

            const events = [];
            el.addEventListener("mouseover", () => events.push("mouseover"));
            el.addEventListener("mousemove", () => events.push("mousemove"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "hover", coordinate: [200, 150] });

            expect(events).toContain("mouseover");
            expect(events).toContain("mousemove");
            expect(result).toContain("200");
        });

        test("T16 — hover with ref: dispatches at element center", async () => {
            const el = appendRefElement("ref_3");

            const events = [];
            el.addEventListener("mouseover", () => events.push("mouseover"));

            const handler = loadComputer({ browser: makeBrowserMockWithDomEval(), resolveTab: jest.fn(async () => 42) });

            const result = await handler({ action: "hover", ref: "ref_3" });

            expect(events).toContain("mouseover");
            expect(result).toContain("ref_3");
        });
    });

    describe("error handling", () => {
        test("T22 — invalid tab ID: classifyExecuteScriptError wraps with guidance", async () => {
            const resolveTab = jest.fn(async () => 99);
            const browser = makeBrowserMock({
                scriptError: new Error("No tab with id 99"),
            });
            const handler = loadComputer({ browser, resolveTab });

            await expect(
                handler({ action: "left_click", coordinate: [100, 200] })
            ).rejects.toThrow(/tabs_context_mcp/);
        });
    });

    describe("registration", () => {
        test("registers itself under the name 'computer'", () => {
            loadComputer({ browser: makeBrowserMock(), resolveTab: jest.fn(async () => 42) });
            expect(globalThis.registerTool).toHaveBeenCalledWith("computer", expect.any(Function));
        });
    });
});
