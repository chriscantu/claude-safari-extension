/**
 * Tool registry — maps tool names to handler functions.
 * See Spec 004 (tool-registry).
 */
const toolHandlers = {};

function registerTool(name, handler) {
    toolHandlers[name] = handler;
}

async function executeTool(toolName, args, context) {
    const handler = toolHandlers[toolName];
    if (!handler) {
        return {
            error: {
                content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            },
        };
    }

    try {
        const result = await handler(args, context);

        // If the handler already returned a shaped content array (e.g. image blocks),
        // use it as-is. Otherwise coerce to a single text block.
        const content = Array.isArray(result?.content)
            ? result.content
            : [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];

        return { result: { content } };
    } catch (error) {
        console.error(`[tool-registry] ${toolName} threw:`, error);
        return {
            error: {
                content: [{ type: "text", text: error.message || String(error) }],
            },
        };
    }
}

/**
 * Classifies an executeScript error into a user-friendly Error.
 *
 * Logs the raw error before classifying so the original Safari/WebKit error
 * code and stack are visible in the browser console for debugging.
 *
 * Pattern coverage:
 *   - "Extension context invalidated" / "context has been invalidated" —
 *     extension reloaded mid-flight; tell user to reload the page.
 *   - "Cannot access" / "scheme" / "about:" / "chrome:" / "file:" /
 *     "Permission denied" / "WKWebExtensionError" / "restricted page" —
 *     restricted URL or Safari permission denial; tell user to navigate to http/https.
 *   - "No tab with id" / "invalid tab" — stale tab; tell user to use tabs_context_mcp.
 *   - Anything else — generic executeScript failure with raw message appended.
 *
 * @param {string} toolName  - e.g. "find" or "read_page" (used in message prefix)
 * @param {number} realTabId - resolved browser tab ID (used in tab-gone message)
 * @param {unknown} err      - the caught error from browser.tabs.executeScript
 * @returns {Error} a new Error with a descriptive message
 */
function classifyExecuteScriptError(toolName, realTabId, err) {
    console.error(`[${toolName}] executeScript raw error:`, err);
    const msg = (err && err.message) || String(err);
    if (/extension context invalid|context has been invalidated/i.test(msg)) {
        return new Error(
            `${toolName}: the extension context is no longer valid. ` +
            `Try reloading the page and running the tool again. (${msg})`
        );
    }
    // Matches Chrome's "Cannot access chrome://..." and Safari's "Permission denied",
    // "WKWebExtensionError", "Script injection into a restricted page is not allowed", etc.
    if (/cannot access|scheme|about:|chrome:|file:|permission denied|WKWebExtensionError|restricted page/i.test(msg)) {
        return new Error(
            `${toolName}: cannot inject into this page (restricted URL, scheme, or permission denied). ` +
            `Navigate to an http/https page first. (${msg})`
        );
    }
    if (/no tab with id|invalid tab/i.test(msg)) {
        return new Error(
            `${toolName}: tab ${realTabId} no longer exists. ` +
            `Use tabs_context_mcp to list available tabs. (${msg})`
        );
    }
    return new Error(`${toolName}: executeScript failed: ${msg}`);
}

// Export for use by background.js
if (typeof globalThis !== "undefined") {
    globalThis.registerTool = registerTool;
    globalThis.executeTool = executeTool;
    globalThis.classifyExecuteScriptError = classifyExecuteScriptError;
}
