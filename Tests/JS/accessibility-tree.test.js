/**
 * @jest-environment jsdom
 *
 * Tests for content-scripts/accessibility-tree.js
 * See Spec 005 (read-page).
 *
 * WHY jsdom + require(): The IIFE registers window.__generateAccessibilityTree
 * at load time and uses DOM APIs (getBoundingClientRect, getComputedStyle).
 * Loading via require() in jsdom gives a real DOM environment.
 *
 * The function returns { pageContent: string, viewport: {...} } on success, or
 * { error: string, pageContent: "", viewport: {...} } on a recoverable error,
 * or throws on an unexpected DOM exception.
 *
 * Covers:
 *   T1  — idempotency guard: second load does not re-register the function
 *   T2  — role detection: <button> → "button"
 *   T3  — role detection: <a> → "link"
 *   T4  — role detection: <input type="text"> → "textbox"
 *   T5  — role detection: <input type="checkbox"> → "checkbox"
 *   T6  — role detection: <h1> → "heading"
 *   T7  — explicit role attribute overrides tag-based role
 *   T8  — label: aria-label takes priority over text content
 *   T9  — label: placeholder used when aria-label absent
 *   T10 — label: button text content extracted
 *   T11 — label: <label for> associated with input
 *   T12 — interactive filter: only interactive elements included
 *   T13 — ref_id: each element gets a unique "ref_X" identifier
 *   T14 — ref_id: same element returns same ref_id on second call
 *   T15 — depth cap: elements beyond max depth excluded
 *   T16 — error path: unknown refId returns { error: "..." } (not throw)
 *   T17 — <select> element: options rendered as child lines
 *   T18 — role=combobox for <select> elements
 *   T19 — returns viewport dimensions alongside pageContent
 *   T20 — output exceeds max_chars: returns { error } not throw
 */

"use strict";

const SCRIPT_PATH = require.resolve(
    "../../ClaudeInSafari Extension/Resources/content-scripts/accessibility-tree.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearBody() {
    while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
    }
}

function installTree() {
    delete window.__generateAccessibilityTree;
    delete window.__claudeElementMap;
    delete window.__claudeRefCounter;
    jest.resetModules();
    require(SCRIPT_PATH);
}

/** Shorthand: generate tree and return the pageContent string. */
function getContent(filter = "all", depth = 15) {
    const r = window.__generateAccessibilityTree(filter, depth, null, null);
    return r.pageContent || "";
}

// jsdom getBoundingClientRect returns zeros; make visible elements pass the
// viewport check by giving them non-zero width/height.
function makeVisible(el) {
    Object.defineProperty(el, "offsetWidth",  { value: 10, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 10, configurable: true });
    el.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10 });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("accessibility-tree content script", () => {
    beforeEach(() => {
        installTree();
        clearBody();
    });

    afterEach(() => {
        clearBody();
        delete window.__generateAccessibilityTree;
        delete window.__claudeElementMap;
        delete window.__claudeRefCounter;
    });

    test("T1 — idempotency guard: second load does not re-register", () => {
        const first = window.__generateAccessibilityTree;
        jest.resetModules();
        require(SCRIPT_PATH); // guard: __generateAccessibilityTree already set
        expect(window.__generateAccessibilityTree).toBe(first);
    });

    test("T2 — role detection: <button> → \"button\"", () => {
        const btn = document.createElement("button");
        btn.textContent = "Click me";
        makeVisible(btn);
        document.body.appendChild(btn);
        expect(getContent()).toContain("button");
    });

    test("T3 — role detection: <a> → \"link\"", () => {
        const a = document.createElement("a");
        a.href = "https://example.com";
        a.textContent = "Go";
        makeVisible(a);
        document.body.appendChild(a);
        expect(getContent()).toContain("link");
    });

    test("T4 — role detection: <input type=\"text\"> → \"textbox\"", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Enter text";
        makeVisible(input);
        document.body.appendChild(input);
        expect(getContent()).toContain("textbox");
    });

    test("T5 — role detection: <input type=\"checkbox\"> → \"checkbox\"", () => {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        makeVisible(cb);
        document.body.appendChild(cb);
        expect(getContent()).toContain("checkbox");
    });

    test("T6 — role detection: <h1> → \"heading\"", () => {
        const h1 = document.createElement("h1");
        h1.textContent = "Page Title";
        makeVisible(h1);
        document.body.appendChild(h1);
        const content = getContent();
        expect(content).toContain("heading");
        expect(content).toContain("Page Title");
    });

    test("T7 — explicit role attribute overrides tag-based role", () => {
        const div = document.createElement("div");
        div.setAttribute("role", "button");
        div.textContent = "Custom Button";
        makeVisible(div);
        document.body.appendChild(div);
        const content = getContent();
        expect(content).toContain("button");
        expect(content).toContain("Custom Button");
    });

    test("T8 — label: aria-label takes priority over text content", () => {
        const btn = document.createElement("button");
        btn.setAttribute("aria-label", "ARIA Label");
        btn.textContent = "Button Text";
        makeVisible(btn);
        document.body.appendChild(btn);
        const content = getContent();
        expect(content).toContain("ARIA Label");
        expect(content).not.toContain("Button Text");
    });

    test("T9 — label: placeholder used when aria-label absent", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Search here";
        makeVisible(input);
        document.body.appendChild(input);
        expect(getContent()).toContain("Search here");
    });

    test("T10 — label: button text content extracted", () => {
        const btn = document.createElement("button");
        btn.textContent = "Submit Form";
        makeVisible(btn);
        document.body.appendChild(btn);
        expect(getContent()).toContain("Submit Form");
    });

    test("T11 — label: <label for> associated with input", () => {
        const label = document.createElement("label");
        label.htmlFor = "my-input";
        label.textContent = "Username";
        const input = document.createElement("input");
        input.id = "my-input";
        input.type = "text";
        makeVisible(input);
        document.body.appendChild(label);
        document.body.appendChild(input);
        expect(getContent()).toContain("Username");
    });

    test("T12 — interactive filter: only interactive elements included", () => {
        const btn = document.createElement("button");
        btn.textContent = "Click";
        makeVisible(btn);
        const p = document.createElement("p");
        p.textContent = "Non-interactive paragraph with enough text length here.";
        makeVisible(p);
        document.body.appendChild(btn);
        document.body.appendChild(p);
        const content = getContent("interactive");
        expect(content).toContain("button");
        expect(content).not.toContain("paragraph");
    });

    test("T13 — ref_id: each element gets a unique \"ref_X\" identifier", () => {
        const btn1 = document.createElement("button");
        btn1.textContent = "First";
        makeVisible(btn1);
        const btn2 = document.createElement("button");
        btn2.textContent = "Second";
        makeVisible(btn2);
        document.body.appendChild(btn1);
        document.body.appendChild(btn2);
        const content = getContent();
        const refIds = content.match(/ref_\d+/g) || [];
        const unique = new Set(refIds);
        expect(unique.size).toBe(refIds.length);
        expect(refIds.length).toBeGreaterThanOrEqual(2);
    });

    test("T14 — ref_id: same element returns same ref_id on second call", () => {
        const btn = document.createElement("button");
        btn.textContent = "Stable";
        makeVisible(btn);
        document.body.appendChild(btn);

        const content1 = getContent();
        const content2 = getContent();

        const ref1 = (content1.match(/ref_\d+/) || [])[0];
        const ref2 = (content2.match(/ref_\d+/) || [])[0];
        expect(ref1).toBeTruthy();
        expect(ref1).toBe(ref2);
    });

    test("T15 — depth cap: elements beyond max depth excluded", () => {
        let el = document.body;
        for (let i = 0; i < 3; i++) {
            const div = document.createElement("div");
            div.setAttribute("role", "region");
            makeVisible(div);
            el.appendChild(div);
            el = div;
        }
        const btn = document.createElement("button");
        btn.textContent = "Deep Button";
        makeVisible(btn);
        el.appendChild(btn);

        expect(getContent("all", 1)).not.toContain("Deep Button");
        expect(getContent("all", 15)).toContain("Deep Button");
    });

    test("T16 — error path: unknown refId returns { error } (not throw)", () => {
        // refId not in __claudeElementMap → recoverable error returned as object
        const result = window.__generateAccessibilityTree("all", 15, null, "ref_nonexistent");
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not found");
        expect(result.pageContent).toBe("");
    });

    test("T17 — <select> element: options rendered as child lines", () => {
        const select = document.createElement("select");
        ["Apple", "Banana", "Cherry"].forEach((text) => {
            const opt = document.createElement("option");
            opt.textContent = text;
            select.appendChild(opt);
        });
        makeVisible(select);
        document.body.appendChild(select);
        const content = getContent();
        expect(content).toContain("Apple");
        expect(content).toContain("Banana");
        expect(content).toContain("Cherry");
    });

    test("T18 — role=combobox for <select> elements", () => {
        const select = document.createElement("select");
        const opt = document.createElement("option");
        opt.textContent = "Option A";
        select.appendChild(opt);
        makeVisible(select);
        document.body.appendChild(select);
        expect(getContent()).toContain("combobox");
    });

    test("T19 — returns viewport dimensions alongside pageContent", () => {
        const result = window.__generateAccessibilityTree("all", 15, null, null);
        expect(result).toHaveProperty("viewport");
        expect(typeof result.viewport.width).toBe("number");
        expect(typeof result.viewport.height).toBe("number");
    });

    test("T20 — output exceeds max_chars: returns { error } not throw", () => {
        // Fill with many elements to exceed a tiny max_chars limit
        for (let i = 0; i < 20; i++) {
            const btn = document.createElement("button");
            btn.textContent = `Button number ${i} with a longer label for size`;
            makeVisible(btn);
            document.body.appendChild(btn);
        }
        // max_chars = 10 will be exceeded immediately
        const result = window.__generateAccessibilityTree("all", 15, 10, null);
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("exceeds");
    });
});
