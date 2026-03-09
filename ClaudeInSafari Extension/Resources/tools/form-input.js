/**
 * Tool: form_input
 *
 * Sets the value of a form element (input, textarea, select, checkbox, radio,
 * contenteditable) identified by ref_id. Dispatches DOM events so that React,
 * Vue, and other frameworks detect the change correctly.
 *
 * Args:
 *   ref    (string)          – ref_id of the target element (required)
 *   value  (string|boolean)  – value to set (required)
 *   tabId  (number|null)     – virtual tab ID; null → active tab
 *
 * See Spec 007 (form_input).
 */

"use strict";

// ---------------------------------------------------------------------------
// Content-script payload (runs in the page context via executeScript)
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained IIFE to inject into the page.
 * Both ref and value are JSON-serialized so special characters cannot escape
 * the JS literal (injection safety).
 *
 * @param {string} ref - the data-claude-ref attribute value to look up
 * @param {string|boolean} value - the value to set
 * @returns {string} JS source to pass to browser.tabs.executeScript
 */
function buildFormInputScript(ref, value) {
    return `(function(ref, value) {
        "use strict";
        try {
            var el = document.querySelector('[data-claude-ref="' + ref.replace(/"/g, '\\\\"') + '"]');
            if (!el) return { error: "Element '" + ref + "' not found" };
            if (el.disabled) return { error: "Element is disabled" };
            if (el.readOnly) return { error: "Element is readonly" };

            var tag = el.tagName.toLowerCase();
            var type = (el.getAttribute("type") || "").toLowerCase();

            function dispatch(evtName) {
                el.dispatchEvent(new Event(evtName, { bubbles: true, cancelable: true }));
            }

            // Checkbox / radio
            if (tag === "input" && (type === "checkbox" || type === "radio")) {
                el.checked = Boolean(value);
                dispatch("change");
                return { success: true };
            }

            // Select
            if (tag === "select") {
                var matched = null;
                var opts = el.options;
                for (var i = 0; i < opts.length; i++) {
                    if (opts[i].value === value) { matched = opts[i]; break; }
                }
                if (!matched) {
                    var lower = String(value).toLowerCase();
                    for (var j = 0; j < opts.length; j++) {
                        if (opts[j].textContent.trim().toLowerCase() === lower) {
                            matched = opts[j]; break;
                        }
                    }
                }
                if (!matched) return { error: "Option '" + value + "' not found in select" };
                el.value = matched.value;
                dispatch("change");
                return { success: true };
            }

            // Contenteditable
            if (el.getAttribute("contenteditable") === "true") {
                el.textContent = value;
                dispatch("input");
                dispatch("change");
                return { success: true };
            }

            // Standard inputs and textareas
            if (tag === "input" || tag === "textarea") {
                el.focus();
                // Use native setter so React's onChange watcher detects the change.
                var proto = tag === "textarea"
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                var nativeSetter = Object.getOwnPropertyDescriptor(proto, "value");
                if (nativeSetter && nativeSetter.set) {
                    nativeSetter.set.call(el, value);
                } else {
                    el.value = value;
                }
                dispatch("input");
                dispatch("change");
                return { success: true };
            }

            return { error: "Element is not a form field" };
        } catch (e) {
            return { error: e.message || String(e) };
        }
    })(${JSON.stringify(ref)}, ${JSON.stringify(value)})`;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ ref: string, value: string|boolean, tabId?: number|null }} args
 * @returns {Promise<string>} "Value set successfully"
 * @throws {Error} "ref must be a non-empty string"
 * @throws {Error} "value is required"
 * @throws {Error} from resolveTab when tab resolution fails
 * @throws {Error} page-reported errors (disabled, readonly, not found, etc.)
 * @throws {Error} "form_input: ..." on executeScript failure
 */
async function handleFormInput(args) {
    const { ref, value, tabId: virtualTabId = null } = args || {};

    if (!ref || typeof ref !== "string") {
        throw new Error("ref must be a non-empty string");
    }
    if (value === undefined || value === null) {
        throw new Error("value is required");
    }

    const realTabId = await globalThis.resolveTab(virtualTabId);

    let results;
    try {
        results = await browser.tabs.executeScript(realTabId, {
            code: buildFormInputScript(ref, value),
            runAt: "document_idle",
        });
    } catch (err) {
        throw globalThis.classifyExecuteScriptError("form_input", realTabId, err);
    }

    if (!results || results.length === 0) {
        throw new Error("form_input: executeScript returned no result (unexpected)");
    }
    const result = results[0];
    if (result === undefined || result === null) {
        throw new Error("form_input: no result from page script");
    }
    if (result.error) {
        throw new Error(result.error);
    }

    return "Value set successfully";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("form_input", handleFormInput);
