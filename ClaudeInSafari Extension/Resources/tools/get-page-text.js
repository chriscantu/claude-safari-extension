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
 * Operates on a DOM clone to avoid persistent mutations to the live page.
 * The clone is briefly appended to document.body in an off-screen container
 * so that innerText is computed correctly, then immediately removed.
 *
 * @returns {string} JS source to pass to browser.tabs.executeScript
 */
function buildGetPageTextScript() {
    return `(function() {
        "use strict";
        try {
            var MAX_CHARS = 100000;

            // --- 1. Select best root: single <article> wins; multiple <article>
            //        elements → fall through to <main> → [role="main"] → body ---
            var articles = document.querySelectorAll("article");
            var root;
            if (articles.length === 1) {
                root = articles[0] || null;
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
            // Attach the clone to an off-screen container so innerText is computed;
            // use try/finally so the container is always removed even if innerText throws.
            if (!document.body) return { text: "" };
            var container = document.createElement("div");
            container.style.cssText = "position:absolute;left:-9999px;opacity:0";
            container.appendChild(clone);
            document.body.appendChild(container);
            var raw;
            try {
                // innerText is preferred (layout-aware, excludes display:none).
                // textContent is the fallback for environments that do not
                // implement innerText (e.g. jsdom in tests).
                raw = clone.innerText ?? clone.textContent ?? "";
            } finally {
                if (document.body.contains(container)) {
                    document.body.removeChild(container);
                }
            }

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
 * @throws {Error} "get_page_text: could not resolve tab ..." when tab resolution fails
 * @throws {Error} "get_page_text: ..." when executeScript rejects (classifyExecuteScriptError)
 * @throws {Error} "get_page_text: executeScript returned no result ..." when results array is empty
 * @throws {Error} "get_page_text: no result from page script" when results[0] is null/undefined
 * @throws {Error} "get_page_text: page script error: ..." when the injected script itself threw
 * @throws {Error} "get_page_text: unexpected result shape ..." when result.text is not a string
 */
async function handleGetPageText(args) {
    const { tabId: virtualTabId = null } = args || {};

    let realTabId;
    try {
        realTabId = await globalThis.resolveTab(virtualTabId);
    } catch (err) {
        throw new Error(
            `get_page_text: could not resolve tab (tabId=${virtualTabId}): ${err.message || String(err)}. ` +
            `Use tabs_context_mcp to list available tabs.`
        );
    }

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
    if (result.__error != null) {
        throw new Error(`get_page_text: page script error: ${result.__error}`);
    }
    if (typeof result.text !== "string") {
        throw new Error(
            `get_page_text: unexpected result shape: ${JSON.stringify(result)}. ` +
            `Expected { text: string } or { __error: string }.`
        );
    }

    return result.text;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("get_page_text", handleGetPageText);
