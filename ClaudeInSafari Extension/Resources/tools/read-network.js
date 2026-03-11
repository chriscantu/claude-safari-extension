/**
 * Tool: read_network_requests
 *
 * Reads captured HTTP requests (fetch, XHR) from a specific tab.
 * The content script network-monitor.js patches fetch and XMLHttpRequest at
 * document_start and stores captured requests in window.__claudeNetworkRequests.
 *
 * Args:
 *   tabId        (number)  – virtual tab ID (required)
 *   urlPattern?  (string)  – plain substring filter (case-insensitive). Default: none.
 *   clear?       (boolean) – if true, clear requests after reading. Default: false.
 *   limit?       (number)  – max requests to return (most recent). Default: 100.
 *
 * See Spec 015 (read_network_requests).
 */

"use strict";

// ---------------------------------------------------------------------------
// Content-script payload (runs in the page context via executeScript)
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained IIFE that atomically reads (and optionally clears)
 * window.__claudeNetworkRequests. Filtering and limiting happen in the
 * background script after injection returns to keep injected code minimal.
 *
 * @param {boolean} clear - whether to clear the buffer after reading
 * @returns {string} JS source to pass to browser.tabs.executeScript
 */
function buildReadNetworkScript(clear) {
    const clearFlag = clear ? "true" : "false";
    return `(function() {
        try {
            var reqs = (window.__claudeNetworkRequests || []).slice();
            if (${clearFlag}) { window.__claudeNetworkRequests = []; }
            return { requests: reqs };
        } catch (e) {
            return { __error: e.message || String(e) };
        }
    })()`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats a single network request entry into the spec output line.
 * Named with a "Network" prefix to avoid colliding with formatEntry in other
 * tool files that share the MV2 background script's global scope.
 *
 * @param {{ type: string, method: string, url: string, status: number|null,
 *           statusText?: string, error?: string, startTime: number, endTime?: number }} entry
 * @returns {string}
 */
function formatNetworkEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return `[unknown] (invalid entry: ${JSON.stringify(entry)})`;
    }
    const type = entry.type || "fetch";
    const method = (entry.method || "GET").toUpperCase();
    const url = entry.url || "(unknown)";

    let statusPart;
    if (entry.error != null) {
        statusPart = `ERR: ${entry.error}`;
    } else if (entry.status === 0) {
        statusPart = "0 (no response)";
    } else {
        const code = entry.status != null ? entry.status : "?";
        const text = entry.statusText != null ? ` ${entry.statusText}` : "";
        statusPart = `${code}${text}`;
    }

    let durationPart;
    if (entry.endTime == null) {
        durationPart = "pending";
    } else {
        durationPart = `${entry.endTime - entry.startTime}ms`;
    }

    return `[${type}] ${method} ${url} → ${statusPart} (${durationPart})`;
}

/**
 * Formats the final list of requests into the spec output string.
 * Named with a "Network" prefix to avoid colliding with formatOutput in other
 * tool files that share the MV2 background script's global scope.
 *
 * @param {number} virtualTabId
 * @param {Array} requests
 * @param {boolean} cleared
 * @returns {string}
 */
function formatNetworkOutput(virtualTabId, requests, cleared) {
    let out;
    if (requests.length === 0) {
        out = `No network requests found for tab ${virtualTabId}.`;
    } else {
        const lines = [`Network requests for tab ${virtualTabId} (${requests.length} requests):`, ""];
        for (const entry of requests) {
            lines.push(formatNetworkEntry(entry));
        }
        out = lines.join("\n");
    }

    if (cleared) {
        out += "\n(Requests cleared)";
    }
    return out;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ tabId: number, urlPattern?: string, clear?: boolean, limit?: number }} args
 * @returns {Promise<string>} formatted network requests
 * @throws {Error} "read_network_requests: tabId parameter is required" when tabId is missing
 * @throws {Error} "read_network_requests: could not resolve tab..." when tab resolution fails
 * @throws {Error} "read_network_requests: ..." when executeScript rejects (classifyExecuteScriptError)
 * @throws {Error} "read_network_requests: executeScript returned no result (unexpected)" when
 *   executeScript resolves with a falsy value or an empty array — both indicate a Safari
 *   injection failure rather than an empty buffer (an empty buffer returns { requests: [] }
 *   as results[0], not a falsy or zero-length results array).
 */
async function handleReadNetworkRequests(args) {
    const {
        tabId: virtualTabId,
        urlPattern = null,
        clear = false,
        limit = 100,
    } = args || {};

    if (virtualTabId == null) {
        throw new Error("read_network_requests: tabId parameter is required");
    }

    let realTabId;
    try {
        realTabId = await globalThis.resolveTab(virtualTabId);
    } catch (err) {
        throw new Error(
            `read_network_requests: could not resolve tab (tabId=${virtualTabId}): ${(err && err.message) || String(err)}. ` +
            `Use tabs_context_mcp to list available tabs.`
        );
    }

    let results;
    try {
        results = await globalThis.executeScriptWithTabGuard(
            realTabId,
            buildReadNetworkScript(clear),
            "read_network_requests"
        );
    } catch (err) {
        if (err && /was closed during/.test(err.message)) throw err;
        if (typeof globalThis.classifyExecuteScriptError === "function") {
            throw globalThis.classifyExecuteScriptError("read_network_requests", realTabId, err);
        }
        throw err;
    }

    if (!results || results.length === 0) {
        throw new Error("read_network_requests: executeScript returned no result (unexpected)");
    }
    const result = results[0];
    if (result === undefined || result === null) {
        // executeScript returned null — content script may not have loaded yet.
        // Return empty rather than error per spec (T12), but log so it's visible.
        console.warn("[read_network_requests] executeScript returned null; network-monitor.js may not have loaded yet");
        return formatNetworkOutput(virtualTabId, [], clear);
    }
    if (result.__error != null) {
        throw new Error(`read_network_requests: page script error: ${result.__error}`);
    }
    if (!Array.isArray(result.requests)) {
        throw new Error(
            `read_network_requests: unexpected result shape: ${JSON.stringify(result)}. ` +
            `Expected { requests: Array } or { __error: string }.`
        );
    }

    // --- Apply filters in background script ---
    let requests = result.requests;

    if (urlPattern != null) {
        const lower = urlPattern.toLowerCase();
        requests = requests.filter((r) => (r.url || "").toLowerCase().includes(lower));
    }

    // limit: keep most recent N, then output in chronological (oldest-first) order
    if (requests.length > limit) {
        requests = requests.slice(-limit);
    }

    return formatNetworkOutput(virtualTabId, requests, clear);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("read_network_requests", handleReadNetworkRequests);
