/**
 * Tool: javascript_tool
 *
 * Executes arbitrary JavaScript in the active tab's page main world.
 *
 * Safari MV2 has no browser.scripting.executeScript with world:"MAIN", so
 * execution uses a two-phase bridge:
 *   Phase 1 — content script (isolated world) injected via executeScript
 *   Phase 2 — content script injects a <script> element → runs in main world
 *   Result   — main world script sends result via window.postMessage; content
 *              script resolves its returned Promise with the result object.
 *
 * The bridge script returns a Promise as its last expression. executeScript
 * in MV2 awaits Promises, so the background script receives the resolved value.
 *
 * CSP detection: before the main-world script is injected, a synchronous probe
 * <script> element mutates a DOM attribute. If the attribute is unchanged after
 * appendChild, CSP blocks inline scripts and we return an error immediately
 * without waiting for the 30-second timeout.
 *
 * ⚠ Safari must be frontmost for executeScript to succeed (same restriction
 *   as the computer tool). ToolRouter.swift activates Safari before forwarding.
 *
 * Args: { action: "javascript_exec", text: string, tabId?: number }
 *
 * Dependencies:
 *   globalThis.resolveTab                — tabs-manager.js
 *   globalThis.classifyExecuteScriptError — tool-registry.js
 *   globalThis.registerTool              — tool-registry.js
 *
 * See Spec 012 (javascript-tool).
 */

"use strict";

const RESULT_FLAG  = "__claudeJsToolResult";
const MAX_OUTPUT   = 100000;
const TIMEOUT_MS   = 30000;

// ---------------------------------------------------------------------------
// IIFE builder
// ---------------------------------------------------------------------------

/**
 * Builds the bridge content script that runs in the isolated world.
 * The script injects a <script> element into the page (main world) that
 * wraps userCode in an AsyncFunction for last-expression return semantics.
 *
 * Security: userCode is passed as a JSON-serialized argument to the outer
 * IIFE (injection-safe), then re-serialized via JSON.stringify(userCode)
 * inside the browser before embedding in the AsyncFunction constructor call.
 *
 * @param {string} text - The user-provided JavaScript code to execute.
 * @returns {string} JS source for browser.tabs.executeScript code option.
 */
function buildJavaScriptExecScript(text) {
    return `(function(userCode) {
        "use strict";
        var RFLAG   = ${JSON.stringify(RESULT_FLAG)};
        var MAX_OUT = ${MAX_OUTPUT};
        var TIMEOUT = ${TIMEOUT_MS};

        return new Promise(function(resolve) {
            var settled = false;
            var timer;

            function settle(data) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                window.removeEventListener("message", onMessage);
                resolve(data);
            }

            function onMessage(event) {
                if (event.data && event.data[RFLAG]) {
                    settle(event.data);
                }
            }

            // --- Synchronous CSP probe ---
            // A <script> without async/defer executes synchronously on appendChild.
            // If the probe attribute stays "pending" after append, CSP blocks inline scripts.
            var probe = document.createElement("script");
            probe.setAttribute("data-claude-csp-probe", "pending");
            probe.textContent = "document.querySelector('[data-claude-csp-probe]').setAttribute('data-claude-csp-probe','ok');";
            (document.head || document.documentElement).appendChild(probe);
            probe.remove();

            if (probe.getAttribute("data-claude-csp-probe") !== "ok") {
                resolve({ error: "Page Content Security Policy blocks script execution. The page's CSP does not allow inline scripts." });
                return;
            }

            timer = setTimeout(function() {
                settle({ error: "Script execution timed out after 30 seconds" });
            }, TIMEOUT);

            window.addEventListener("message", onMessage);

            // Build main-world script — userCode embedded via JSON.stringify (injection-safe).
            // The AsyncFunction constructor gives the code its own return-capable scope
            // and allows await at the top level, so the last expression is returned.
            var mainScript = [
                "(async function() {",
                "  try {",
                "    var AsyncFunc = Object.getPrototypeOf(async function(){}).constructor;",
                "    var fn = new AsyncFunc(" + JSON.stringify(userCode) + ");",
                "    var result = await fn();",
                "    var output;",
                "    if (result === undefined) {",
                "      output = 'undefined';",
                "    } else if (result !== null && typeof result === 'object') {",
                "      if (typeof Element !== 'undefined' && result instanceof Element) {",
                "        output = Object.prototype.toString.call(result) + ' (DOM element \\u2014 use .outerHTML or .textContent to serialize)';",
                "      } else {",
                "        try { output = JSON.stringify(result, null, 2); }",
                "        catch(circ) { window.postMessage({ [" + JSON.stringify(RESULT_FLAG) + "]: true, error: 'Result contains circular references' }, '*'); return; }",
                "      }",
                "    } else {",
                "      output = String(result);",
                "    }",
                "    if (output.length > " + MAX_OUTPUT + ") output = output.slice(0, " + MAX_OUTPUT + ") + '\\n[output truncated]';",
                "    window.postMessage({ [" + JSON.stringify(RESULT_FLAG) + "]: true, value: output }, '*');",
                "  } catch(e) {",
                "    var msg = (e instanceof Error)",
                "      ? 'JavaScript error: ' + e.message + '\\n' + (e.stack || '(no stack)')",
                "      : String(e);",
                "    window.postMessage({ [" + JSON.stringify(RESULT_FLAG) + "]: true, error: msg }, '*');",
                "  }",
                "})();"
            ].join("\\n");

            var script = document.createElement("script");
            script.textContent = mainScript;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        });
    })(${JSON.stringify(text)})`;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ action: string, text: string, tabId?: number }} args
 * @returns {Promise<string>} String representation of the execution result.
 * @throws {Error} on validation failure, tab resolution failure, or execution error.
 */
async function handleJavaScriptTool(args) {
    const { action, text, tabId: virtualTabId = null } = args || {};

    if (!action || action !== "javascript_exec") {
        throw new Error("'javascript_exec' is the only supported action");
    }
    if (!text || typeof text !== "string" || text.trim() === "") {
        throw new Error("Code parameter is required");
    }

    const realTabId = await globalThis.resolveTab(virtualTabId);

    let results;
    try {
        results = await browser.tabs.executeScript(realTabId, {
            code: buildJavaScriptExecScript(text),
            runAt: "document_idle",
        });
    } catch (err) {
        throw globalThis.classifyExecuteScriptError("javascript_tool", realTabId, err);
    }

    if (!results || results.length === 0 || results[0] == null) {
        throw new Error("javascript_tool: executeScript returned no result");
    }

    const r = results[0];
    if (r.error) {
        throw new Error(r.error);
    }

    return r.value !== undefined ? String(r.value) : "undefined";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("javascript_tool", handleJavaScriptTool);
