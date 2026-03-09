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
 * @param {string} toolName  - e.g. "find" or "read_page" (used in message prefix)
 * @param {number} realTabId - resolved browser tab ID (used in tab-gone message)
 * @param {unknown} err      - the caught error from browser.tabs.executeScript
 * @returns {Error} a new Error with a descriptive message
 */
function classifyExecuteScriptError(toolName, realTabId, err) {
    const msg = (err && err.message) || String(err);
    if (/cannot access|scheme|about:|chrome:|file:/i.test(msg)) {
        return new Error(
            `${toolName}: cannot inject into this page (restricted URL or scheme). ` +
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
