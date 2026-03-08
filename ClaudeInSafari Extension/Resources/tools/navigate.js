/**
 * navigate — URL navigation and history traversal.
 * Implements the "navigate" MCP tool.
 * See Specs/008-navigate.md.
 *
 * Depends on: globalThis.resolveTab (exported by tools/tabs-manager.js)
 */

"use strict";

const NAVIGATION_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Prepend "https://" when the input lacks an http(s) scheme.
 * History keywords ("back", "forward") are case-sensitive and returned unchanged.
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
 * Returns a cancellable promise that resolves with the tab's final URL once
 * browser.tabs.onUpdated fires with status === "complete" for the given tab.
 * Also listens for browser.tabs.onRemoved to detect tab closure mid-navigation.
 * Rejects with a timeout error after NAVIGATION_TIMEOUT_MS ms.
 *
 * For URL navigations, requires a "loading" status event before accepting
 * "complete" to filter out stale completions from prior page loads. For
 * history navigations (back/forward), this guard is skipped because Safari
 * may serve BFCached pages without a "loading" event.
 *
 * NOTE: With MV2 "persistent": false, the background page could theoretically
 * be suspended before these listeners fire. The keepalive alarm in background.js
 * mitigates but does not eliminate this risk.
 *
 * The returned promise has a .cancel() method that cleans up all listeners
 * and timers. Callers MUST invoke .cancel() if abandoning the promise early
 * (e.g., when the browser API call rejects).
 *
 * @param {number} realTabId
 * @param {object} [options]
 * @param {boolean} [options.requireLoadingEvent=true] - When true, waits for
 *   a "loading" status before accepting "complete". Set to false for history
 *   navigations that may skip the "loading" phase.
 * @returns {Promise<string> & { cancel: () => void }} final URL
 * @throws {Error} "Navigation timed out after 30 seconds"
 * @throws {Error} "Tab <id> was closed during navigation"
 */
function waitForNavigation(realTabId, { requireLoadingEvent = true } = {}) {
    let cleanup;

    const promise = new Promise((resolve, reject) => {
        let settled = false;
        let navigationStarted = !requireLoadingEvent;

        function doCleanup() {
            clearTimeout(timer);
            browser.tabs.onUpdated.removeListener(onUpdated);
            browser.tabs.onRemoved.removeListener(onRemoved);
        }

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            doCleanup();
            reject(new Error("Navigation timed out after 30 seconds"));
        }, NAVIGATION_TIMEOUT_MS);

        function onUpdated(tabId, changeInfo, tab) {
            if (tabId !== realTabId || settled) return;

            // Track that the tab started loading (filters out stale completions
            // from a previous page load that was already in-flight).
            if (changeInfo.status === "loading") {
                navigationStarted = true;
            }

            if (changeInfo.status === "complete" && navigationStarted) {
                settled = true;
                doCleanup();
                resolve(tab.url);
            }
        }

        function onRemoved(tabId) {
            if (tabId === realTabId && !settled) {
                settled = true;
                doCleanup();
                reject(new Error(`Tab ${realTabId} was closed during navigation`));
            }
        }

        browser.tabs.onUpdated.addListener(onUpdated);
        browser.tabs.onRemoved.addListener(onRemoved);

        cleanup = doCleanup;
    });

    promise.cancel = cleanup;
    return promise;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * @param {{ url: string, tabId?: number }} args
 * @returns {Promise<string>} "Navigated to <finalUrl>"
 * @throws {Error} "url must be a non-empty string" when url is missing or empty
 * @throws {Error} "Tab not found: <tabId>" when resolveTab cannot resolve the virtual tab
 * @throws {Error} "Navigation timed out after 30 seconds" when onUpdated never fires
 * @throws {Error} "Tab <id> was closed during navigation" when the tab is closed mid-nav
 */
async function handleNavigate(args) {
    const { url, tabId } = args || {};

    if (!url || typeof url !== "string" || url.trim() === "") {
        throw new Error("url must be a non-empty string");
    }

    // When tabId is omitted, resolveTab falls back to the active tab.
    const realTabId = await globalThis.resolveTab(tabId);

    const normalized = normalizeUrl(url.trim());
    const isHistoryNav = normalized === "back" || normalized === "forward";

    // Start listening before triggering navigation so we don't miss the event.
    // History navigations skip the "loading" guard since Safari may serve
    // BFCached pages without firing a "loading" status event.
    const settlementPromise = waitForNavigation(realTabId, {
        requireLoadingEvent: !isHistoryNav,
    });

    try {
        if (normalized === "back") {
            await browser.tabs.goBack(realTabId);
        } else if (normalized === "forward") {
            await browser.tabs.goForward(realTabId);
        } else {
            await browser.tabs.update(realTabId, { url: normalized });
        }
    } catch (err) {
        // Clean up the settlement listener/timer before propagating
        settlementPromise.cancel();
        throw err;
    }

    const finalUrl = await settlementPromise;
    return `Navigated to ${finalUrl}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool("navigate", handleNavigate);
