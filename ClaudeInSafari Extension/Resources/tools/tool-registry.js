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
        return {
            result: {
                content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
            },
        };
    } catch (error) {
        return {
            error: {
                content: [{ type: "text", text: error.message || String(error) }],
            },
        };
    }
}

// Export for use by background.js
if (typeof globalThis !== "undefined") {
    globalThis.registerTool = registerTool;
    globalThis.executeTool = executeTool;
}
