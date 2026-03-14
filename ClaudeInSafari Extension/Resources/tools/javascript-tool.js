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
 * Result channel: browser.runtime.sendMessage (NOT executeScript return value).
 * Safari MV2's executeScript does not await Promise return values from injected
 * scripts — results[0] is always null. The bridge calls browser.runtime.sendMessage
 * with a per-call correlationId; handleJavaScriptTool waits on browser.runtime.onMessage
 * for the matching reply.
 *
 * The correlationId is generated in the background, passed to the bridge as its
 * second IIFE argument, and used as the key for both the window.postMessage channel
 * (main world to content script) and the sendMessage channel (content script to
 * background). One nonce covers both channels.
 *
 * CSP detection: before the main-world script is injected, a synchronous probe
 * <script> element mutates a DOM attribute. If the attribute is unchanged after
 * appendChild, CSP blocks inline scripts and we return an error immediately
 * without waiting for the 30-second timeout. The corrId is used as the probe
 * attribute suffix, preventing concurrent calls from sharing the same probe.
 *
 * AsyncFunction semantics: the main-world script uses AsyncFunction constructor
 * with an inner function call to provide console-like last-expression return
 * semantics. This requires 'unsafe-eval' in the page's CSP script-src directive
 * (separate from 'unsafe-inline' for the <script> element itself).
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
 *
 * The bridge:
 *   1. Runs a synchronous CSP probe to detect blocked inline scripts early.
 *   2. Registers a window.postMessage listener keyed on corrId.
 *   3. Injects a <script> element (main world) that runs user code and posts
 *      the result back via window.postMessage({ [corrId]: true, value/error }).
 *   4. On receiving the postMessage, calls browser.runtime.sendMessage to deliver
 *      the result to the background handler waiting on browser.runtime.onMessage.
 *
 * Security:
 *   - text is JSON-serialized at build time — never raw-concatenated.
 *   - correlationId is JSON-serialized at build time.
 *   - event.source === window guards against cross-origin iframe spoofing.
 *   - postMessage spoofing by same-page scripts is an accepted risk given the
 *     local-machine MCP trust boundary.
 *
 * @param {string} text          - The user-provided JavaScript code to execute.
 * @param {string} correlationId - Per-call nonce; key for postMessage and sendMessage channels.
 * @returns {string} JS source for browser.tabs.executeScript code option.
 */
function buildJavaScriptExecScript(text, correlationId) {
    return `(function(userCode, corrId) {
        "use strict";
        var MAX_OUT = ${MAX_OUTPUT};
        var TIMEOUT = ${TIMEOUT_MS};

        var settled = false;
        var timer;

        function settle(data) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            browser.runtime.sendMessage({ [corrId]: true, value: data.value, error: data.error });
        }

        // event.source === window rejects messages from cross-origin iframes.
        // Same-page scripts could still forge the flag — accepted risk given
        // the local-machine MCP trust boundary (see file-level JSDoc).
        function onMessage(event) {
            if (event.source !== window) return;
            if (event.data && event.data[corrId]) {
                settle(event.data);
            }
        }

        // --- Synchronous CSP probe ---
        // A <script> without async/defer executes synchronously on appendChild.
        // If the attribute stays "pending" after append, CSP blocks inline scripts.
        // corrId suffix prevents concurrent calls from sharing the same probe attribute.
        var probeAttr = "data-claude-csp-probe-" + corrId;
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
        // CLAUDE.md event listener lifecycle guidance — listener first, then timer, then inject.
        window.addEventListener("message", onMessage);

        timer = setTimeout(function() {
            settle({ error: "Script execution timed out after 30 seconds" });
        }, TIMEOUT);

        // Build and inject main-world script.
        // userCode is embedded via JSON.stringify(userCode) at bridge-build time
        // (in the IIFE, before injection) — not at background-page build time.
        //
        // AsyncFunction constructor with inner function call gives console-like semantics:
        //   last expression value is returned, await is valid inside.
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
            "        catch(circ) { window.postMessage({ [" + JSON.stringify(corrId) + "]: true, error: 'Result contains circular references' }, '*'); return; }",
            "      }",
            "    } else {",
            "      output = String(result);",
            "    }",
            "    if (output.length > " + MAX_OUT + ") output = output.slice(0, " + MAX_OUT + ") + '\\n[output truncated]';",
            "    window.postMessage({ [" + JSON.stringify(corrId) + "]: true, value: output }, '*');",
            "  } catch(e) {",
            "    var msg;",
            "    if (e instanceof Error) {",
            "      msg = 'JavaScript error: ' + e.message + '\\n' + (e.stack || '(no stack)');",
            "    } else {",
            "      try { msg = JSON.stringify(e, null, 2); } catch(_) { msg = String(e); }",
            "    }",
            "    window.postMessage({ [" + JSON.stringify(corrId) + "]: true, error: msg }, '*');",
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
    })(${JSON.stringify(text)}, ${JSON.stringify(correlationId)})`;
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
    const correlationId = RESULT_FLAG + "_" + Math.random().toString(36).slice(2);

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;

        function settle(value, isError) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            browser.runtime.onMessage.removeListener(onMessage);
            browser.tabs.onRemoved.removeListener(onTabRemoved);
            if (isError) {
                reject(value instanceof Error ? value : new Error(value));
            } else {
                resolve(value);
            }
        }

        function onMessage(message) {
            if (!message || !message[correlationId]) return;
            if (message.error) {
                settle(message.error, true);
            } else {
                settle(message.value !== undefined ? String(message.value) : "undefined", false);
            }
        }

        function onTabRemoved(closedTabId) {
            if (closedTabId === realTabId) {
                settle(`Tab ${realTabId} was closed during javascript_tool`, true);
            }
        }

        browser.runtime.onMessage.addListener(onMessage);
        browser.tabs.onRemoved.addListener(onTabRemoved);

        timer = setTimeout(() => {
            settle("Script execution timed out after 30 seconds", true);
        }, TIMEOUT_MS);

        browser.tabs.executeScript(realTabId, {
            code: buildJavaScriptExecScript(text, correlationId),
            runAt: "document_idle",
        }).catch((err) => {
            if (settled) return;
            const classified = typeof globalThis.classifyExecuteScriptError === "function"
                ? globalThis.classifyExecuteScriptError("javascript_tool", realTabId, err)
                : err;
            settle(classified, true);
        });
    });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("javascript_tool", handleJavaScriptTool);
