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
 * The bridge script returns a Promise as its last expression. Safari's MV2
 * executeScript implementation awaits Promises returned from injected scripts.
 * Note: this is Safari-specific — Chrome MV2 does not await Promise results.
 *
 * CSP detection: before the main-world script is injected, a synchronous probe
 * <script> element mutates a DOM attribute. If the attribute is unchanged after
 * appendChild, CSP blocks inline scripts and we return an error immediately
 * without waiting for the 30-second timeout. A unique nonce per invocation
 * prevents concurrent calls from sharing the same probe attribute.
 *
 * Concurrent-call isolation: RFLAG (the postMessage channel key) is suffixed
 * with a per-invocation random nonce, so two concurrent calls on the same tab
 * cannot cross-contaminate each other's results. Without this, both onMessage
 * listeners would fire for the first postMessage that arrives.
 *
 * eval() semantics: the main-world script uses eval() inside an AsyncFunction
 * to provide console-like last-expression return semantics. eval() returns the
 * completion value of the last statement (e.g. eval('1+1') returns 2, not
 * undefined). await is valid because direct eval() shares the enclosing async
 * function's execution context. Note: eval() requires 'unsafe-eval' in the
 * page's CSP script-src directive (separate from 'unsafe-inline' for <script>).
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
 * uses eval() inside an AsyncFunction for last-expression return semantics.
 *
 * Security: text is JSON-serialized into the outer IIFE argument at build time
 * (in the background page). Inside the bridge, userCode is JSON-serialized at
 * bridge-build time (in the extension's isolated world) before being passed as
 * the call argument to fn(). No user-controlled string is concatenated without
 * serialization at either stage.
 *
 * Spec 012 describes the timeout/message race as Promise.race. The implementation
 * uses a single Promise with a settled guard flag instead — equivalent and avoids
 * the cleanup race that Promise.race introduces.
 *
 * Note on postMessage spoofing: event.source === window guards against
 * cross-origin iframes. Same-page scripts could still forge the flag, but
 * the local-machine MCP trust boundary makes this an accepted risk.
 *
 * @param {string} text - The user-provided JavaScript code to execute.
 * @returns {string} JS source for browser.tabs.executeScript code option.
 */
function buildJavaScriptExecScript(text) {
    return `(function(userCode) {
        "use strict";
        var RFLAG   = ${JSON.stringify(RESULT_FLAG + "_")} + Math.random().toString(36).slice(2);
        var MAX_OUT = ${MAX_OUTPUT};
        var TIMEOUT = ${TIMEOUT_MS};

        // This Promise always resolves (never rejects). Errors from user code,
        // timeout, and CSP detection resolve with { error: string }; the handler
        // layer converts them to thrown Errors. This avoids unhandled rejections
        // from synchronous exceptions thrown inside the executor.
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

            // event.source === window rejects messages from cross-origin iframes.
            // Same-page scripts could still forge the flag — accepted risk given
            // the local-machine MCP trust boundary (see file-level JSDoc).
            function onMessage(event) {
                if (event.source !== window) return;
                if (event.data && event.data[RFLAG]) {
                    settle(event.data);
                }
            }

            // --- Synchronous CSP probe ---
            // A <script> without async/defer executes synchronously on appendChild.
            // If the attribute stays "pending" after append, CSP blocks inline scripts.
            // A unique nonce prevents concurrent calls from matching each other's probe.
            var cspNonce = Math.random().toString(36).slice(2);
            var probeAttr = "data-claude-csp-probe-" + cspNonce;
            var probe = document.createElement("script");
            probe.setAttribute(probeAttr, "pending");
            probe.textContent = "document.querySelector('[" + probeAttr + "]').setAttribute('" + probeAttr + "','ok');";
            try {
                (document.head || document.documentElement).appendChild(probe);
            } catch (appendErr) {
                settle({ error: "Cannot inject script: document has no injectable parent element (" + appendErr.message + ")" });
                return;
            }
            probe.remove();

            if (probe.getAttribute(probeAttr) !== "ok") {
                settle({ error: "Page Content Security Policy blocks script execution. The page's CSP does not allow inline scripts." });
                return;
            }

            // Register listener before starting the timer: canonical order per
            // CLAUDE.md event listener lifecycle guidance — listener → timer → inject.
            // This ensures the clock never runs against an unregistered handler.
            window.addEventListener("message", onMessage);

            timer = setTimeout(function() {
                settle({ error: "Script execution timed out after 30 seconds" });
            }, TIMEOUT);

            // Build and inject main-world script.
            // userCode is embedded via JSON.stringify(userCode) at bridge-build time
            // (here in the IIFE, before injection) — not at background-page build time.
            //
            // eval() inside an AsyncFunction gives console-like semantics:
            //   eval('1+1') returns 2  (last expression value, not undefined)
            //   eval('const x=5; x*3') returns 15
            //   eval('await fetch(...)') works because direct eval() shares the async context
            //
            // Note: RFLAG and MAX_OUT are IIFE-local variables (declared above as
            // var RFLAG/MAX_OUT). They are referenced here at bridge-runtime via
            // JSON.stringify(RFLAG) and MAX_OUT — both are in IIFE scope. The module-level
            // constants RESULT_FLAG and MAX_OUTPUT are NOT in scope here.
            var mainScript = [
                "(async function() {",
                "  try {",
                "    var AsyncFunc = Object.getPrototypeOf(async function(){}).constructor;",
                "    var fn = new AsyncFunc('return eval(arguments[0])');",
                "    var result = await fn(" + JSON.stringify(userCode) + ");",
                "    var output;",
                "    if (result === undefined) {",
                "      output = 'undefined';",
                "    } else if (result !== null && typeof result === 'object') {",
                "      if (typeof Element !== 'undefined' && result instanceof Element) {",
                "        output = Object.prototype.toString.call(result) + ' (DOM element \\u2014 use .outerHTML or .textContent to serialize)';",
                "      } else {",
                "        try { output = JSON.stringify(result, null, 2); }",
                "        catch(circ) { window.postMessage({ [" + JSON.stringify(RFLAG) + "]: true, error: 'Result contains circular references' }, '*'); return; }",
                "      }",
                "    } else {",
                "      output = String(result);",
                "    }",
                "    if (output.length > " + MAX_OUT + ") output = output.slice(0, " + MAX_OUT + ") + '\\n[output truncated]';",
                "    window.postMessage({ [" + JSON.stringify(RFLAG) + "]: true, value: output }, '*');",
                "  } catch(e) {",
                "    var msg;",
                "    if (e instanceof Error) {",
                "      msg = 'JavaScript error: ' + e.message + '\\n' + (e.stack || '(no stack)');",
                "    } else {",
                "      try { msg = JSON.stringify(e, null, 2); } catch(_) { msg = String(e); }",
                "    }",
                "    window.postMessage({ [" + JSON.stringify(RFLAG) + "]: true, error: msg }, '*');",
                "  }",
                "})();"
            ].join("\\n");

            var script = document.createElement("script");
            script.textContent = mainScript;
            try {
                (document.head || document.documentElement).appendChild(script);
            } catch (injectErr) {
                settle({ error: "Script injection failed: " + injectErr.message });
                return;
            }
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
        results = await globalThis.executeScriptWithTabGuard(
            realTabId,
            buildJavaScriptExecScript(text),
            "javascript_tool"
        );
    } catch (err) {
        if (err && /was closed during/.test(err.message)) throw err;
        if (typeof globalThis.classifyExecuteScriptError === "function") {
            throw globalThis.classifyExecuteScriptError("javascript_tool", realTabId, err);
        }
        throw err;
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
