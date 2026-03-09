/**
 * Tool: get_page_text
 *
 * Extracts the human-readable text content from the active tab's page.
 * Prioritises article/main content; falls back to full body.
 * Returns plain text with HTML tags stripped and noise collapsed.
 *
 * Args:
 *   tabId  (number|null) – virtual tab ID; null → active tab
 *
 * See Spec 009 (get_page_text).
 */

"use strict";

// ---------------------------------------------------------------------------
// Content-script payload (runs in the page context via executeScript)
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained IIFE to inject into the page.
 * Operates on a DOM clone so the live page is never mutated.
 *
 * @returns {string} JS source to pass to browser.tabs.executeScript
 */
function buildGetPageTextScript() {
    return `(function() {
        "use strict";
        try {
            var MAX_CHARS = 100000;

            // --- 1. Select the best root element (priority order per spec) ---
            var articles = document.querySelectorAll("article");
            var root;
            if (articles.length === 1) {
                root = articles[0];
            } else if (document.querySelector("main")) {
                root = document.querySelector("main");
            } else if (document.querySelector('[role="main"]')) {
                root = document.querySelector('[role="main"]');
            } else {
                root = document.body;
            }

            if (!root) return { text: "" };

            // --- 2. Clone the root to avoid mutating the live DOM ---
            var clone = root.cloneNode(true);
            var isBodyFallback = (root === document.body);

            // --- 3. Remove noise elements from the clone ---
            var noiseSelectors = ["script", "style", "noscript", '[aria-hidden="true"]'];
            if (isBodyFallback) {
                noiseSelectors.push("nav", "header", "footer");
            }
            noiseSelectors.forEach(function(sel) {
                clone.querySelectorAll(sel).forEach(function(el) { el.remove(); });
            });

            // --- 4. Extract text via innerText (layout-aware, block-to-newline) ---
            // Attach the clone to a detached container so innerText is computed.
            var container = document.createElement("div");
            container.style.cssText = "position:absolute;left:-9999px;visibility:hidden";
            container.appendChild(clone);
            document.body.appendChild(container);
            var raw = clone.innerText || "";
            document.body.removeChild(container);

            // --- 5. Post-process: collapse blank lines, trim lines, remove empties ---
            var lines = raw.split("\\n");
            var out = [];
            var prevBlank = false;
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line === "") {
                    if (!prevBlank) { out.push(""); }
                    prevBlank = true;
                } else {
                    out.push(line);
                    prevBlank = false;
                }
            }
            var text = out.join("\\n").trim();

            // --- 6. Truncate if over limit ---
            if (text.length > MAX_CHARS) {
                text = text.slice(0, MAX_CHARS) + "\\n[content truncated]";
            }

            return { text: text };
        } catch (e) {
            return { __error: e.message || String(e) };
        }
    })()`;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ tabId?: number|null }} args
 * @returns {Promise<string>} extracted page text
 * @throws {Error} from resolveTab when tab resolution fails
 * @throws {Error} "get_page_text: ..." on executeScript failure or page error
 */
async function handleGetPageText(args) {
    const { tabId: virtualTabId = null } = args || {};

    const realTabId = await globalThis.resolveTab(virtualTabId);

    let results;
    try {
        results = await browser.tabs.executeScript(realTabId, {
            code: buildGetPageTextScript(),
            runAt: "document_idle",
        });
    } catch (err) {
        throw globalThis.classifyExecuteScriptError("get_page_text", realTabId, err);
    }

    if (!results || results.length === 0) {
        throw new Error("get_page_text: executeScript returned no result (unexpected)");
    }
    const result = results[0];
    if (result === undefined || result === null) {
        throw new Error("get_page_text: no result from page script");
    }
    if (result.__error) {
        throw new Error(`get_page_text: page script error: ${result.__error}`);
    }

    return result.text;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("get_page_text", handleGetPageText);
