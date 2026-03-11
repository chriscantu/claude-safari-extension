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

/**
 * Wraps browser.tabs.executeScript with three safety mechanisms:
 *   1. A settled-flag guard preventing double-settlement races.
 *   2. An onRemoved listener that rejects immediately if the tab closes.
 *   3. A 30-second timeout that rejects if the script never completes.
 *
 * Callers should check `err.message` for "was closed during" before calling
 * classifyExecuteScriptError, so the tab-closed message is not overwritten.
 *
 * @param {number} realTabId  - resolved browser tab ID
 * @param {string} scriptCode - JS source to inject (IIFE string)
 * @param {string} toolName   - e.g. "read_network_requests" (for error messages)
 * @returns {Promise<any[]>} the raw executeScript result array
 */
function executeScriptWithTabGuard(realTabId, scriptCode, toolName) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;

        function cleanup() {
            browser.tabs.onRemoved.removeListener(onTabRemoved);
            clearTimeout(timeoutId);
        }

        function onTabRemoved(tabId) {
            if (tabId !== realTabId || settled) return;
            settled = true;
            cleanup();
            reject(new Error(`Tab ${realTabId} was closed during ${toolName}`));
        }

        browser.tabs.onRemoved.addListener(onTabRemoved);

        timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`${toolName}: executeScript timed out after 30s`));
        }, 30000);

        browser.tabs.executeScript(realTabId, {
            code: scriptCode,
            runAt: "document_idle",
        }).then((r) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(r);
        }).catch((err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        });
    });
}

// Export for use by background.js
if (typeof globalThis !== "undefined") {
    globalThis.registerTool = registerTool;
    globalThis.executeTool = executeTool;
    globalThis.classifyExecuteScriptError = classifyExecuteScriptError;
    globalThis.executeScriptWithTabGuard = executeScriptWithTabGuard;
}
