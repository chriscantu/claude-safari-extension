/**
 * Tool: javascript_tool
 *
 * Executes arbitrary JavaScript in the active tab's page main world.
 *
 * Safari MV2 has no browser.scripting.executeScript with world:"MAIN", so
 * execution uses a two-phase approach:
 *
 *   Phase 1 — bridge injection (single executeScript):
 *     A content script (isolated world) is injected via executeScript. It runs
 *     a synchronous CSP probe, then injects a <script> element that runs user
 *     code in the main world. The main-world script writes its result or error
 *     to a DOM attribute on document.documentElement, keyed on correlationId.
 *
 *   Phase 2 — result polling (repeated executeScript):
 *     The background polls by calling executeScript with a synchronous read of
 *     the DOM attribute. When the attribute is present, the poll script removes
 *     it and returns the JSON-serialized result. The background parses it and
 *     settles the promise.
 *
 * Why DOM-attribute polling instead of browser.runtime.sendMessage:
 *   executeScript-injected scripts run in an ephemeral isolated-world context
 *   that does not persist for async operations after the IIFE returns. Any
 *   window.addEventListener or browser.runtime.sendMessage call scheduled
 *   after the IIFE completes is silently dropped. Synchronous executeScript
 *   return values, by contrast, work reliably in Safari MV2.
 *
 * CSP detection: before the main-world script is injected, a synchronous probe
 * <script> element mutates a DOM attribute. If the attribute is unchanged after
 * appendChild, CSP blocks inline scripts and the bridge writes a CSP error to
 * the result attribute immediately. The first poll picks it up.
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

const RESULT_FLAG        = "__claudeJsToolResult";
const RESULT_ATTR_PREFIX = "data-claude-js-result-";
const MAX_OUTPUT         = 100000;
const TIMEOUT_MS         = 30000;
const POLL_INTERVAL_MS   = 100;

// ---------------------------------------------------------------------------
// IIFE builder
// ---------------------------------------------------------------------------

/**
 * Builds the bridge content script that runs in the isolated world.
 *
 * The bridge:
 *   1. Runs a synchronous CSP probe. On failure, writes error to the result
 *      attribute and returns immediately (poll will pick it up).
 *   2. Builds a main-world script that runs user code and writes the result
 *      (or error) to document.documentElement[RESULT_ATTR_PREFIX + corrId].
 *   3. Injects the main-world script via a <script> element and returns.
 *
 * Security:
 *   - text is JSON-serialized at build time — never raw-concatenated.
 *   - correlationId is JSON-serialized at build time.
 *   - The result attribute name includes the corrId, so concurrent calls
 *     write to distinct attributes.
 *
 * @param {string} text          - The user-provided JavaScript code to execute.
 * @param {string} correlationId - Per-call nonce; used as the DOM attribute suffix.
 * @returns {string} JS source for browser.tabs.executeScript code option.
 */
function buildJavaScriptExecScript(text, correlationId) {
    return `(function(userCode, corrId) {
        "use strict";
        var MAX_OUT = ${MAX_OUTPUT};
        var resultAttr = ${JSON.stringify(RESULT_ATTR_PREFIX)} + corrId;

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
            document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: "Cannot inject script: document has no injectable parent element (" + appendErr.message + ")" }));
            return;
        }
        probe.remove();

        if (probe.getAttribute(probeAttr) !== "ok") {
            document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: "Page Content Security Policy blocks script execution. The page's CSP does not allow inline scripts." }));
            return;
        }

        // Build and inject main-world script.
        // userCode is embedded via JSON.stringify at bridge-build time — not raw-concatenated.
        //
        // AsyncFunction constructor with inner function call gives console-like semantics:
        //   last expression value is returned, await is valid inside.
        //
        // The result is written to a DOM attribute, which persists across JS worlds
        // and is readable by subsequent isolated-world executeScript poll calls.
        var mainScript = [
            "(async function() {",
            "  var rAttr = " + JSON.stringify(resultAttr) + ";",
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
            "        catch(circ) { document.documentElement.setAttribute(rAttr, JSON.stringify({error: 'Result contains circular references'})); return; }",
            "      }",
            "    } else {",
            "      output = String(result);",
            "    }",
            "    if (output.length > " + MAX_OUT + ") output = output.slice(0, " + MAX_OUT + ") + '\\n[output truncated]';",
            "    document.documentElement.setAttribute(rAttr, JSON.stringify({value: output}));",
            "  } catch(e) {",
            "    var msg;",
            "    if (e instanceof Error) {",
            "      msg = 'JavaScript error: ' + e.message + '\\n' + (e.stack || '(no stack)');",
            "    } else {",
            "      try { msg = JSON.stringify(e, null, 2); } catch(_) { msg = String(e); }",
            "    }",
            "    document.documentElement.setAttribute(rAttr, JSON.stringify({error: msg}));",
            "  }",
            "})();"
        ].join("\\n");

        var script = document.createElement("script");
        script.textContent = mainScript;
        try {
            (document.head || document.documentElement).appendChild(script);
        } catch (injectErr) {
            document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: "Script injection failed: " + injectErr.message }));
            return;
        }
        script.remove();
        // Bridge returns synchronously. The main-world script runs async;
        // the background will poll the DOM attribute for the result.
    })(${JSON.stringify(text)}, ${JSON.stringify(correlationId)})`;
}

// ---------------------------------------------------------------------------
// Poll script builder
// ---------------------------------------------------------------------------

/**
 * Builds a synchronous poll script that reads and clears the result attribute.
 *
 * Returns the JSON-serialized result string if the attribute is present,
 * or null if the main-world script has not written it yet.
 *
 * Safari MV2 executeScript reliably returns synchronous (non-Promise) values.
 *
 * @param {string} correlationId - Per-call nonce matching the bridge injection.
 * @returns {string} JS source for browser.tabs.executeScript code option.
 */
function buildPollScript(correlationId) {
    const attr = JSON.stringify(RESULT_ATTR_PREFIX + correlationId);
    return `(function() {
        var r = document.documentElement.getAttribute(${attr});
        if (r !== null) { document.documentElement.removeAttribute(${attr}); return r; }
        return null;
    })()`;
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
        let pollTimer = null;
        const deadline = Date.now() + TIMEOUT_MS;

        function settle(value, isError) {
            if (settled) return;
            settled = true;
            clearTimeout(pollTimer);
            browser.tabs.onRemoved.removeListener(onTabRemoved);
            if (isError) {
                reject(value instanceof Error ? value : new Error(value));
            } else {
                resolve(value);
            }
        }

        function onTabRemoved(closedTabId) {
            if (closedTabId === realTabId) {
                settle(`Tab ${realTabId} was closed during javascript_tool`, true);
            }
        }

        function poll() {
            if (settled) return;
            if (Date.now() >= deadline) {
                settle("Script execution timed out after 30 seconds", true);
                return;
            }
            browser.tabs.executeScript(realTabId, {
                code: buildPollScript(correlationId),
                runAt: "document_idle",
            }).then((results) => {
                if (settled) return;
                const raw = results && results[0];
                if (raw) {
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch (e) {
                        settle("Failed to parse result: " + e.message, true);
                        return;
                    }
                    if (parsed.error) {
                        settle(parsed.error, true);
                    } else {
                        settle(parsed.value !== undefined ? String(parsed.value) : "undefined", false);
                    }
                } else {
                    // Result not ready — schedule next poll.
                    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
                }
            }).catch((err) => {
                if (settled) return;
                const classified = typeof globalThis.classifyExecuteScriptError === "function"
                    ? globalThis.classifyExecuteScriptError("javascript_tool", realTabId, err)
                    : err;
                settle(classified, true);
            });
        }

        browser.tabs.onRemoved.addListener(onTabRemoved);

        // Phase 1: inject bridge to run user code in the main world.
        browser.tabs.executeScript(realTabId, {
            code: buildJavaScriptExecScript(text, correlationId),
            runAt: "document_idle",
        }).then(() => {
            // Phase 2: start polling for the result attribute.
            // poll() is called without an initial delay so that synchronous
            // user code (e.g. "1 + 1") resolves in the next microtask.
            // Async user code will not be ready yet; poll() schedules itself
            // with POLL_INTERVAL_MS until the attribute appears or timeout fires.
            poll();
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
