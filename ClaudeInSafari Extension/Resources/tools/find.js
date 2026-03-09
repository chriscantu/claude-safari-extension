/**
 * Tool: find
 *
 * Searches the active tab's page for elements matching a natural-language query.
 * Returns up to 20 matching elements with ref_id, role, name, and bounding rect.
 * Results can be used directly with computer (click/hover) and form_input.
 *
 * Args:
 *   query   (string)      – Natural-language description of the element (required)
 *   tabId   (number|null) – Virtual tab ID; null → active tab
 *
 * See Spec 006 (find).
 */

"use strict";

// ---------------------------------------------------------------------------
// Content-script payload (runs in the page context via executeScript)
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained IIFE to inject into the page.
 * The query is JSON-serialized so special characters cannot escape the JS literal.
 *
 * Matching priority (per spec):
 *   1. Exact accessible name (case-insensitive)
 *   2. Partial accessible name
 *   3. placeholder attribute contains query
 *   4. aria-label / aria-labelledby contains query
 *   5. Role keyword in query + partial name match
 *
 * @param {string} query - already-trimmed search string
 * @returns {string} JS source to pass to browser.tabs.executeScript
 */
function buildFindScript(query) {
    return `(function(query) {
        "use strict";
        window.__claudeRefCounter = window.__claudeRefCounter || 0;
        window.__claudeElementMap = window.__claudeElementMap || {};

        var SKIP_TAGS = { script:1, style:1, meta:1, link:1, title:1, noscript:1, head:1 };
        var ROLE_KEYWORDS = ["button","link","input","checkbox","radio","select","heading","image","img","form"];

        function getRole(el) {
            var r = el.getAttribute("role");
            if (r) return r;
            var tag = el.tagName.toLowerCase();
            var type = (el.getAttribute("type") || "").toLowerCase();
            if (tag === "input") {
                if (type === "submit" || type === "button") return "button";
                if (type === "checkbox") return "checkbox";
                if (type === "radio") return "radio";
                if (type === "search") return "searchbox";
                return "textbox";
            }
            return { a:"link", button:"button", select:"combobox", textarea:"textbox",
                     h1:"heading", h2:"heading", h3:"heading", h4:"heading",
                     h5:"heading", h6:"heading", img:"image", form:"form" }[tag] || "generic";
        }

        function getAccessibleName(el) {
            var tag = el.tagName.toLowerCase();
            if (tag === "select") {
                var opt = el.querySelector("option[selected]") || el.options[el.selectedIndex];
                if (opt && opt.textContent) return opt.textContent.trim();
            }
            var v;
            v = el.getAttribute("aria-label"); if (v && v.trim()) return v.trim();
            v = el.getAttribute("aria-labelledby");
            if (v) { var le = document.getElementById(v); if (le && le.textContent.trim()) return le.textContent.trim(); }
            v = el.getAttribute("placeholder"); if (v && v.trim()) return v.trim();
            v = el.getAttribute("alt");         if (v && v.trim()) return v.trim();
            v = el.getAttribute("title");       if (v && v.trim()) return v.trim();
            if (el.id) {
                var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
            }
            var text = el.textContent;
            if (text && text.trim()) return text.trim().substring(0, 100);
            return "";
        }

        function assignRef(el) {
            var ref = el.getAttribute("data-claude-ref");
            if (!ref) {
                window.__claudeRefCounter++;
                ref = "ref_" + window.__claudeRefCounter;
                el.setAttribute("data-claude-ref", ref);
                window.__claudeElementMap[ref] = el;
            }
            return ref;
        }

        function getRect(el) {
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y),
                     width: Math.round(r.width), height: Math.round(r.height) };
        }

        var q = query.toLowerCase();

        // Parse optional role keyword from query (e.g. "search bar" → detectedRole="input", textPart="search")
        var detectedRole = null, textPart = q;
        for (var ki = 0; ki < ROLE_KEYWORDS.length; ki++) {
            if (q.includes(ROLE_KEYWORDS[ki])) {
                detectedRole = ROLE_KEYWORDS[ki];
                textPart = q.replace(ROLE_KEYWORDS[ki], "").trim();
                break;
            }
        }

        var seen = new Set();
        // Five priority buckets: exact, partial, placeholder, aria-label, role+keyword
        var b = [[], [], [], [], []];

        var all = document.querySelectorAll("*");
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var tag = el.tagName.toLowerCase();
            if (SKIP_TAGS[tag]) continue;

            var isHidden = tag === "input" && el.getAttribute("type") === "hidden";
            if (!isHidden) {
                var r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
            }

            var name = getAccessibleName(el);
            var nl = name.toLowerCase();

            if (!seen.has(el) && nl === q)             { seen.add(el); b[0].push(el); continue; }
            if (!seen.has(el) && nl.includes(q))       { seen.add(el); b[1].push(el); continue; }

            var ph = el.getAttribute("placeholder");
            if (!seen.has(el) && ph && ph.toLowerCase().includes(q)) { seen.add(el); b[2].push(el); continue; }

            var al = el.getAttribute("aria-label");
            var alb = el.getAttribute("aria-labelledby");
            var albText = alb ? (function(id) { var e = document.getElementById(id); return e ? e.textContent.trim() : ""; })(alb) : "";
            if (!seen.has(el) && ((al && al.toLowerCase().includes(q)) || albText.toLowerCase().includes(q))) {
                seen.add(el); b[3].push(el); continue;
            }

            if (!seen.has(el) && detectedRole) {
                var elRole = getRole(el);
                var roleMatch = elRole === detectedRole
                    || (detectedRole === "img"    && elRole === "image")
                    || (detectedRole === "select" && elRole === "combobox")
                    || (detectedRole === "input"  && (elRole === "textbox" || elRole === "searchbox" || elRole === "combobox"));
                if (roleMatch && (!textPart || nl.includes(textPart))) {
                    seen.add(el); b[4].push(el);
                }
            }
        }

        var combined = b[0].concat(b[1]).concat(b[2]).concat(b[3]).concat(b[4]);
        var total = combined.length;
        var top20 = combined.slice(0, 20);

        var matches = top20.map(function(el) {
            var ref = assignRef(el);
            var hidden = el.tagName.toLowerCase() === "input" && el.getAttribute("type") === "hidden";
            return { role: getRole(el), name: getAccessibleName(el), refId: ref,
                     rect: hidden ? null : getRect(el) };
        });

        return { matches: matches, total: total };
    })(${JSON.stringify(query)})`;
}

// ---------------------------------------------------------------------------
// Output formatter
// ---------------------------------------------------------------------------

/**
 * Converts raw match data into the canonical text format defined in Spec 006.
 *
 * @param {string} query
 * @param {Array<{role:string, name:string, refId:string, rect:{x,y,width,height}|null}>} matches
 * @param {number} total
 * @returns {string}
 */
function formatMatches(query, matches, total) {
    if (total === 0) {
        return `No elements found matching "${query}".`;
    }

    const lines = [`Found ${total} match${total === 1 ? "" : "es"} for "${query}":\n`];
    matches.forEach((m, idx) => {
        const rect = m.rect
            ? ` at (${m.rect.x}, ${m.rect.y}, ${m.rect.width}x${m.rect.height})`
            : "";
        lines.push(`${idx + 1}. ${m.role} "${m.name}" [ref=${m.refId}]${rect}`);
    });

    if (total > 20) {
        lines.push(
            `\nNote: showing first 20 of ${total} matches. Use a more specific query to narrow results.`
        );
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ query: string, tabId?: number }} args
 * @returns {Promise<string>} formatted match list
 * @throws {Error} "query must be a non-empty string"
 * @throws {Error} "Cannot access tab <tabId>: ..." when resolveTab fails
 * @throws {Error} "find: ..." on executeScript failure
 */
async function handleFind(args) {
    const { query, tabId: virtualTabId = null } = args || {};

    if (!query || typeof query !== "string" || query.trim() === "") {
        throw new Error("query must be a non-empty string");
    }

    let realTabId;
    try {
        realTabId = await globalThis.resolveTab(virtualTabId);
    } catch (err) {
        throw new Error(
            `Cannot access tab ${virtualTabId}: ${err.message || String(err)}`
        );
    }

    const q = query.trim();
    let results;
    try {
        results = await browser.tabs.executeScript(realTabId, {
            code: buildFindScript(q),
            runAt: "document_idle",
        });
    } catch (err) {
        const msg = err.message || String(err);
        if (/cannot access|scheme|about:|chrome:|file:/i.test(msg)) {
            throw new Error(
                `find: cannot inject into this page (restricted URL or scheme). ` +
                `Navigate to an http/https page first. (${msg})`
            );
        }
        if (/no tab with id|invalid tab/i.test(msg)) {
            throw new Error(
                `find: tab ${realTabId} no longer exists. ` +
                `Use tabs_context_mcp to list available tabs. (${msg})`
            );
        }
        throw new Error(`find: executeScript failed: ${msg}`);
    }

    const result = results && results[0];
    if (!result) {
        throw new Error("find: no result from page script");
    }
    if (result.error) {
        throw new Error(result.error);
    }

    const { matches, total } = result;
    return formatMatches(q, matches, total);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

globalThis.registerTool("find", handleFind);
