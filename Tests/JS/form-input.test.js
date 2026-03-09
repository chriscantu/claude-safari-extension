/**
 * Tests for tools/form-input.js
 * See Spec 007 (form_input).
 *
 * Covers:
 *   T1  — text input: value set, returns success message
 *   T2  — checkbox: checked set to true, returns success
 *   T3  — select by option value attribute: returns success
 *   T4  — select by option visible text (case-insensitive): returns success
 *   T5  — select unknown option: page error surfaces as rejection
 *   T6  — disabled input: page error surfaces as rejection
 *   T7  — ref not found on page: page error surfaces as rejection
 *   T8  — non-form element (plain div): page error surfaces as rejection
 *   T9  — injected code invokes native setter for React compatibility
 *   T10 — textarea multi-line value: returns success
 *   T11 — missing ref: throws "ref must be a non-empty string"
 *   T12 — missing value: throws "value is required"
 *   T13 — tab not accessible (restricted URL): classifyExecuteScriptError wraps with guidance
 *   T14 — registers itself under the name "form_input"
 *   T15 — virtualTabId forwarded to resolveTab
 *   T16 — injected code handles contenteditable (sets textContent)
 *   T17 — readonly input: page error surfaces as rejection
 *   T18 — radio button: injected code handles type=radio (checked + change event)
 *   T19 — executeScript returns [undefined]: throws no-result error
 *   T20 — ref and value JSON-serialized safely into injected code (injection safety)
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBrowserMock(opts = {}) {
    const { scriptResult, scriptError = null } = opts;
    return {
        tabs: {
            executeScript: jest.fn(async () => {
                if (scriptError) throw scriptError;
                return scriptResult;
            }),
        },
    };
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadFormInput({ browser, resolveTab }) {
    globalThis.browser = browser;
    globalThis.resolveTab = resolveTab;

    // Load the real classifyExecuteScriptError so tests exercise the production implementation.
    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    });

    let handler = null;
    globalThis.registerTool = jest.fn((_name, fn) => { handler = fn; });

    jest.isolateModules(() => {
        require("../../ClaudeInSafari Extension/Resources/tools/form-input.js");
    });

    return handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("form_input tool", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.resolveTab;
        delete globalThis.registerTool;
        delete globalThis.classifyExecuteScriptError;
        delete globalThis.executeTool;
    });

    test("T1 — text input: value set, returns success message", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        const result = await handler({ ref: "ref_1", value: "hello" });

        expect(result).toBe("Value set successfully");
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(42, expect.any(Object));
    });

    test("T2 — checkbox: checked=true, returns success", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        const result = await handler({ ref: "ref_cb", value: true });

        expect(result).toBe("Value set successfully");
    });

    test("T3 — select by option value attribute: returns success", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        const result = await handler({ ref: "ref_sel", value: "option-value" });

        expect(result).toBe("Value set successfully");
    });

    test("T4 — select by visible text (case-insensitive): returns success", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        const result = await handler({ ref: "ref_sel", value: "Option Label" });

        expect(result).toBe("Value set successfully");
    });

    test("T5 — select unknown option: rejects with page error message", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Option 'nonexistent' not found in select" }],
        });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_sel", value: "nonexistent" }))
            .rejects.toThrow("Option 'nonexistent' not found in select");
    });

    test("T6 — disabled input: rejects with 'Element is disabled'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Element is disabled" }],
        });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_dis", value: "x" }))
            .rejects.toThrow("Element is disabled");
    });

    test("T7 — ref not found: rejects with \"Element 'ref_99' not found\"", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Element 'ref_99' not found" }],
        });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_99", value: "x" }))
            .rejects.toThrow("Element 'ref_99' not found");
    });

    test("T8 — non-form div: rejects with 'Element is not a form field'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Element is not a form field" }],
        });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_div", value: "x" }))
            .rejects.toThrow("Element is not a form field");
    });

    test("T9 — injected code uses native setter for React compatibility", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        await handler({ ref: "ref_1", value: "react-value" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("getOwnPropertyDescriptor");
        expect(code).toContain("HTMLInputElement.prototype");
    });

    test("T10 — textarea multi-line value: returns success", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        const result = await handler({ ref: "ref_ta", value: "line1\nline2" });

        expect(result).toBe("Value set successfully");
    });

    test("T11 — missing ref throws 'ref must be a non-empty string'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ value: "hello" })).rejects.toThrow("ref must be a non-empty string");
        await expect(handler({ ref: "", value: "hello" })).rejects.toThrow("ref must be a non-empty string");
    });

    test("T12 — missing value throws 'value is required'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_1" })).rejects.toThrow("value is required");
    });

    test("T13 — restricted URL: classifyExecuteScriptError wraps with guidance", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptError: new Error("Cannot access contents of the page"),
        });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_1", value: "x" }))
            .rejects.toThrow(/cannot inject into this page/);
    });

    test("T14 — registers itself under the name 'form_input'", () => {
        const resolveTab = jest.fn(async () => 1);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        loadFormInput({ browser, resolveTab });

        expect(globalThis.registerTool).toHaveBeenCalledWith("form_input", expect.any(Function));
    });

    test("T15 — virtualTabId forwarded to resolveTab", async () => {
        const resolveTab = jest.fn(async (vtid) => { expect(vtid).toBe(7); return 99; });
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        await handler({ ref: "ref_1", value: "x", tabId: 7 });

        expect(resolveTab).toHaveBeenCalledWith(7);
        expect(browser.tabs.executeScript).toHaveBeenCalledWith(99, expect.any(Object));
    });

    test("T16 — injected code handles contenteditable via textContent", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        await handler({ ref: "ref_ce", value: "editable content" });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("contenteditable");
        expect(code).toContain("textContent");
    });

    test("T17 — readonly input: rejects with 'Element is readonly'", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({
            scriptResult: [{ error: "Element is readonly" }],
        });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_ro", value: "x" }))
            .rejects.toThrow("Element is readonly");
    });

    test("T18 — injected code handles type=radio with checked + change event", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        await handler({ ref: "ref_r", value: true });

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain("radio");
        expect(code).toContain("checked");
    });

    test("T19 — executeScript returns [undefined]: throws no-result error", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [undefined] });
        const handler = loadFormInput({ browser, resolveTab });

        await expect(handler({ ref: "ref_1", value: "x" }))
            .rejects.toThrow(/no result/);
    });

    test("T20 — ref and value JSON-serialized safely into injected code", async () => {
        const resolveTab = jest.fn(async () => 42);
        const browser = makeBrowserMock({ scriptResult: [{ success: true }] });
        const handler = loadFormInput({ browser, resolveTab });

        const trickyRef = 'ref_1"; alert("xss';
        await handler({ ref: trickyRef, value: "x" }).catch(() => {});

        const code = browser.tabs.executeScript.mock.calls[0][1].code;
        expect(code).toContain(JSON.stringify(trickyRef));
    });
});
