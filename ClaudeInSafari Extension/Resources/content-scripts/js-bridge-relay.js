/**
 * Content script: js-bridge-relay
 *
 * Polls for javascript_tool results written as DOM attributes by main-world
 * <script> elements, and relays them to the background via sendMessage.
 *
 * Why a persistent content script:
 *   Scripts injected via browser.tabs.executeScript run in ephemeral isolated-
 *   world contexts. After the IIFE returns synchronously, Safari tears down the
 *   context — all pending async callbacks (setInterval, setTimeout, sendMessage
 *   callbacks) are silently dropped. A manifest-loaded content script has a
 *   persistent context that survives for the page lifetime.
 *
 * Why DOM attribute polling instead of window.postMessage:
 *   In Safari MV2, window.postMessage from a main-world <script> element is NOT
 *   delivered to isolated-world content script event listeners. The DOM tree IS
 *   shared across worlds, so attribute writes from the main world are visible
 *   to isolated-world polling.
 *
 * Protocol:
 *   The main-world script (injected by javascript-tool.js's bridge IIFE) writes
 *   JSON({value|error}) to: document.documentElement.data-claude-js-result-{corrId}
 *   This relay polls for attributes matching that prefix every 50ms.
 *   When found, it reads the value, removes the attribute, parses the JSON,
 *   and forwards { [corrId]: true, value?, error? } to the background.
 *
 * Security:
 *   - The attribute prefix is unique enough that accidental matching is negligible.
 *   - The local-machine MCP trust boundary makes same-page spoofing an accepted risk.
 */

"use strict";

const JS_RESULT_ATTR_PREFIX = "data-claude-js-result-";
const JS_RESULT_POLL_MS = 50;


setInterval(function pollJsResults() {
    var el = document.documentElement;
    if (!el) return;

    var attrs = el.getAttributeNames();
    for (var i = 0; i < attrs.length; i++) {
        var attr = attrs[i];
        if (attr.indexOf(JS_RESULT_ATTR_PREFIX) !== 0) continue;

        var raw = el.getAttribute(attr);
        el.removeAttribute(attr);

        // Extract corrId: attribute name is "data-claude-js-result-{corrId}"
        var corrId = attr.slice(JS_RESULT_ATTR_PREFIX.length);

        try {
            var parsed = JSON.parse(raw);
            browser.runtime.sendMessage({
                [corrId]: true,
                value: parsed.value,
                error: parsed.error,
            }).catch(function(sendErr) {
                console.error("js-bridge-relay: sendMessage failed for", corrId, sendErr);
            });
        } catch (parseErr) {
            browser.runtime.sendMessage({
                [corrId]: true,
                error: "Failed to parse script result: " + parseErr.message,
            }).catch(function(sendErr) {
                console.error("js-bridge-relay: sendMessage (parse error path) failed for", corrId, sendErr);
            });
        }
    }
}, JS_RESULT_POLL_MS);
