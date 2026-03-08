/**
 * navigate — URL navigation and history traversal.
 * Implements the "navigate" MCP tool.
 * See Spec 008 (navigate).
 *
 * Depends on: globalThis.resolveTab (exported by tools/tabs-manager.js)
 */

"use strict";

const NAVIGATION_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Prepend "https://" to bare hostnames.
 * History keywords ("back", "forward") are returned unchanged.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
    if (url === "back" || url === "forward") return url;
    if (/^https?:\/\//i.test(url)) return url;
    return "https://" + url;
}

// ---------------------------------------------------------------------------
// Navigation settlement
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves with the tab's final URL once
 * browser.tabs.onUpdated fires with status === "complete" for the given tab.
 * Rejects with a timeout error after NAVIGATION_TIMEOUT_MS ms.
 *
 * @param {number} realTabId
 * @returns {Promise<string>} final URL
 */
function waitForNavigation(realTabId) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            browser.tabs.onUpdated.removeListener(listener);
            reject(new Error("Navigation timed out after 30 seconds"));
        }, NAVIGATION_TIMEOUT_MS);

        function listener(tabId, changeInfo, tab) {
            if (tabId === realTabId && changeInfo.status === "complete") {
                clearTimeout(timer);
                browser.tabs.onUpdated.removeListener(listener);
                resolve(tab.url);
            }
        }

        browser.tabs.onUpdated.addListener(listener);
    });
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ url: string, tabId?: number }} args
 * @returns {Promise<string>} "Navigated to <finalUrl>"
 */
async function handleNavigate(args) {
    const { url, tabId } = args || {};

    // Validate
    if (!url || typeof url !== "string" || url.trim() === "") {
        throw new Error("url must be a non-empty string");
    }

    // Resolve real tab ID via the shared helper from tabs-manager.
    // resolveTab treats null and undefined identically (both → active tab).
    const realTabId = await globalThis.resolveTab(tabId);

    const normalized = normalizeUrl(url.trim());

    // Start listening before triggering navigation so we don't miss the event
    const settlementPromise = waitForNavigation(realTabId);

    if (normalized === "back") {
        await browser.tabs.goBack(realTabId);
    } else if (normalized === "forward") {
        await browser.tabs.goForward(realTabId);
    } else {
        await browser.tabs.update(realTabId, { url: normalized });
    }

    const finalUrl = await settlementPromise;
    return `Navigated to ${finalUrl}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool("navigate", handleNavigate);
