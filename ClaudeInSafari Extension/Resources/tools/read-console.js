/**
 * Tool: read_console_messages
 *
 * Reads captured browser console output from a specific tab.
 * The content script console-monitor.js overrides console.* at document_start
 * and stores all messages in window.__claudeConsoleMessages.
 *
 * Safari enhancement: returns messages from ALL frames (iframes included),
 * whereas Chrome returns same-domain only. This is more visibility, not a gap.
 *
 * Args:
 *   tabId       (number|null) – virtual tab ID; null → active tab
 *   onlyErrors? (boolean)     – if true, return only error-level messages. Default: false.
 *   clear?      (boolean)     – if true, clear the buffer after reading. Default: false.
 *   pattern?    (string)      – regex to filter messages (case-insensitive). Default: none.
 *   limit?      (number)      – max messages to return (most recent). Default: 100.
 *
 * See Spec 014 (read_console_messages).
 */

"use strict";

// ---------------------------------------------------------------------------
// Content-script payload (runs in the page context via executeScript)
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained IIFE that atomically reads (and optionally clears)
 * window.__claudeConsoleMessages. Filtering and limiting happen in the
 * background script after injection returns to keep injected code minimal.
 *
 * @param {boolean} clear - whether to clear the buffer after reading
 * @returns {string} JS source to pass to browser.tabs.executeScript
 */
function buildReadConsoleScript(clear) {
    const clearFlag = clear ? "true" : "false";
    return `(function() {
        try {
            var msgs = (window.__claudeConsoleMessages || []).slice();
            if (${clearFlag}) { window.__claudeConsoleMessages = []; }
            return { messages: msgs };
        } catch (e) {
            return { __error: e.message || String(e) };
        }
    })()`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats a UTC timestamp (ms since epoch) as HH:MM:SS.mmm.
 *
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimestamp(timestamp) {
    return new Date(timestamp).toISOString().slice(11, 23);
}

/**
 * Formats the final list of messages into the spec output string.
 *
 * @param {number} virtualTabId
 * @param {Array<{level: string, message: string, timestamp: number}>} messages
 * @param {boolean} cleared
 * @returns {string}
 */
function formatOutput(virtualTabId, messages, cleared) {
    if (messages.length === 0) {
        return `No console messages found for tab ${virtualTabId}.`;
    }

    const lines = [`Console messages for tab ${virtualTabId} (${messages.length} messages):`, ""];
    for (const msg of messages) {
        const ts = formatTimestamp(msg.timestamp);
        const level = String(msg.level).toUpperCase();
        lines.push(`[${ts}] [${level}] ${msg.message}`);
    }

    let out = lines.join("\n");
    if (cleared) {
        out += "\n(Messages cleared)";
    }
    return out;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ tabId?: number|null, onlyErrors?: boolean, clear?: boolean, pattern?: string, limit?: number }} args
 * @returns {Promise<string>} formatted console messages
 * @throws {Error} "read_console_messages: tabId parameter is required" when tabId missing and no active tab
 * @throws {Error} "read_console_messages: could not resolve tab ..." when tab resolution fails
 * @throws {Error} "read_console_messages: Invalid regex pattern: ..." when pattern is invalid regex
 * @throws {Error} "read_console_messages: ..." when executeScript rejects (classifyExecuteScriptError)
 */
async function handleReadConsoleMessages(args) {
    const {
        tabId: virtualTabId = null,
        onlyErrors = false,
        clear = false,
        pattern = null,
        limit = 100,
    } = args || {};

    // Validate and compile regex pattern before touching the tab
    let filterRegex = null;
    if (pattern != null) {
        try {
            filterRegex = new RegExp(pattern, "i");
        } catch (err) {
            throw new Error(`read_console_messages: Invalid regex pattern: ${err.message || String(err)}`);
        }
    }

    let realTabId;
    try {
        realTabId = await globalThis.resolveTab(virtualTabId);
    } catch (err) {
        throw new Error(
            `read_console_messages: could not resolve tab (tabId=${virtualTabId}): ${err.message || String(err)}. ` +
            `Use tabs_context_mcp to list available tabs.`
        );
    }

    let results;
    try {
        results = await browser.tabs.executeScript(realTabId, {
            code: buildReadConsoleScript(clear),
            runAt: "document_idle",
        });
    } catch (err) {
        throw globalThis.classifyExecuteScriptError("read_console_messages", realTabId, err);
    }

    if (!results || results.length === 0) {
        throw new Error("read_console_messages: executeScript returned no result (unexpected)");
    }
    const result = results[0];
    if (result === undefined || result === null) {
        // Content script not loaded yet — return empty (not an error per spec)
        return formatOutput(virtualTabId, [], false);
    }
    if (result.__error != null) {
        throw new Error(`read_console_messages: page script error: ${result.__error}`);
    }
    if (!Array.isArray(result.messages)) {
        throw new Error(
            `read_console_messages: unexpected result shape: ${JSON.stringify(result)}. ` +
            `Expected { messages: Array } or { __error: string }.`
        );
    }

    // --- Apply filters in background script ---
    let messages = result.messages;

    if (onlyErrors) {
        messages = messages.filter((m) => m.level === "error");
    }

    if (filterRegex !== null) {
        messages = messages.filter((m) => filterRegex.test(m.message));
    }

    // limit: keep most recent N, then output in chronological (oldest-first) order
    if (messages.length > limit) {
        messages = messages.slice(-limit);
    }

    return formatOutput(virtualTabId, messages, clear);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("read_console_messages", handleReadConsoleMessages);
