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
 *   depth      (number|null)  – max tree depth (default: 15)
 *   max_chars  (number|null)  – character cap on output (default: 50000)
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
        max_chars: maxChars = null,
        ref_id: refId = null,
    } = args || {};

    const realTabId = await globalThis.resolveTab(virtualTabId);

    // Call the function installed by the content script.
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
                    ${depth === null ? "undefined" : depth},
                    ${maxChars === null ? "null" : maxChars},
                    ${refId === null ? "undefined" : JSON.stringify(refId)}
                );
            })()`,
            runAt: "document_idle",
        });
    } catch (err) {
        throw new Error(`executeScript failed: ${err.message || String(err)}`);
    }

    const result = results && results[0];
    if (!result) {
        throw new Error("No result from accessibility tree script");
    }

    if (result.error) {
        throw new Error(result.error);
    }

    const { pageContent = "", viewport = {} } = result;
    const lines = [
        `Viewport: ${viewport.width || "?"}x${viewport.height || "?"}`,
        "",
        pageContent,
    ];
    return lines.join("\n");
}

registerTool("read_page", handleReadPage);
