/**
 * Tool: read_page
 *
 * Returns an accessibility-tree snapshot of the current page.
 * Delegates to window.__generateAccessibilityTree (installed by
 * content-scripts/accessibility-tree.js at document_start).
 *
 * Args:
 *   tabId      (number|null)  – virtual tab ID; null → active tab
 *   filter     (string)       – "all" | "interactive" (default: "all")
 *   depth      (number|null)  – max tree depth; null uses content-script default (15)
 *   max_chars  (number)       – character cap on output (default: 50000)
 *   ref_id     (string|null)  – focus on a specific element ref
 *
 * See Spec 005 (read-page).
 */

"use strict";

async function handleReadPage(args) {
    const {
        tabId: virtualTabId = null,
        filter = "all",
        depth = null,
        max_chars: maxChars = 50000,
        ref_id: refId = null,
    } = args || {};

    if (filter !== "all" && filter !== "interactive") {
        throw new Error(`read_page: filter must be "all" or "interactive", got: ${JSON.stringify(filter)}`);
    }
    if (depth !== null && (!Number.isInteger(depth) || depth < 1)) {
        throw new Error(`read_page: depth must be a positive integer, got: ${JSON.stringify(depth)}`);
    }
    if (maxChars !== null && (!Number.isInteger(maxChars) || maxChars < 1)) {
        throw new Error(`read_page: max_chars must be a positive integer, got: ${JSON.stringify(maxChars)}`);
    }

    let realTabId;
    try {
        realTabId = await globalThis.resolveTab(virtualTabId);
    } catch (err) {
        throw new Error(
            `read_page: could not resolve tab (tabId=${virtualTabId}): ${err.message || String(err)}. ` +
            `Use tabs_context_mcp to list available tabs.`
        );
    }

    // Call the function installed by the content script at document_start.
    // runAt: "document_idle" ensures the DOM is queryable; __generateAccessibilityTree
    // is installed earlier at document_start so it is always available by this point.
    // executeScript returns an array of per-frame results; index 0 is the top frame.
    let results;
    try {
        results = await browser.tabs.executeScript(realTabId, {
            code: `(function() {
                if (typeof window.__generateAccessibilityTree !== "function") {
                    return { error: "Accessibility tree content script not loaded. Try reloading the page.", pageContent: "", viewport: { width: window.innerWidth, height: window.innerHeight } };
                }
                return window.__generateAccessibilityTree(
                    ${JSON.stringify(filter)},
                    ${JSON.stringify(depth === null ? undefined : depth)},
                    ${JSON.stringify(maxChars)},
                    ${JSON.stringify(refId === null ? undefined : refId)}
                );
            })()`,
            runAt: "document_idle",
        });
    } catch (err) {
        const msg = err.message || String(err);
        if (/cannot access|scheme|about:|chrome:|file:/i.test(msg)) {
            throw new Error(
                `read_page: cannot inject into this page (restricted URL or scheme). ` +
                `Navigate to an http/https page first. (${msg})`
            );
        }
        if (/no tab with id|invalid tab/i.test(msg)) {
            throw new Error(
                `read_page: tab ${realTabId} no longer exists. ` +
                `Use tabs_context_mcp to list available tabs. (${msg})`
            );
        }
        throw new Error(`read_page: executeScript failed: ${msg}`);
    }

    const result = results && results[0];
    if (!result) {
        throw new Error("No result from accessibility tree script");
    }

    if (result.error) {
        throw new Error(result.error);
    }

    const { pageContent = "", viewport = {} } = result;
    const w = viewport.width != null ? viewport.width : "?";
    const h = viewport.height != null ? viewport.height : "?";
    return [`Viewport: ${w}x${h}`, "", pageContent].join("\n");
}

globalThis.registerTool("read_page", handleReadPage);
