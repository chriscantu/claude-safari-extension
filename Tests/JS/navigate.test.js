/**
 * Tests for tools/navigate.js
 * Covers all test cases defined in Specs/008-navigate.md (T1–T7),
 * plus supplementary cases T5b–T5c, T8–T19.
 *
 * Key mock challenges:
 *   - browser.tabs.onUpdated: event-listener pattern; captured and fired manually
 *   - browser.tabs.onRemoved: event-listener pattern for tab closure detection
 *   - 30-second timeout: controlled via Jest fake timers (T7)
 *   - resolveTab: injected on globalThis before module load
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a browser mock. _fireOnUpdated() and _fireOnRemoved() let tests
 * trigger events manually to simulate navigation completing or tab closure.
 */
function makeBrowserMock(opts = {}) {
    const {
        updateUrl = "https://example.com",   // final URL returned after navigation
    } = opts;

    let onUpdatedListener = null;
    let onRemovedListener = null;

    return {
        tabs: {
            update: jest.fn(async () => ({ id: 10, url: updateUrl })),
            goBack: jest.fn(async () => {}),
            goForward: jest.fn(async () => {}),
            query: jest.fn(async () => [{ id: 10, url: "about:blank" }]),
            onUpdated: {
                addListener: jest.fn((fn) => { onUpdatedListener = fn; }),
                removeListener: jest.fn(),
            },
            onRemoved: {
                addListener: jest.fn((fn) => { onRemovedListener = fn; }),
                removeListener: jest.fn(),
            },
        },
        _fireOnUpdated(tabId, changeInfo, tab) {
            if (onUpdatedListener) onUpdatedListener(tabId, changeInfo, tab);
        },
        _fireOnRemoved(tabId) {
            if (onRemovedListener) onRemovedListener(tabId);
        },
    };
}

/**
 * Simulate a full navigation sequence (loading → complete) for the given tab.
 */
function simulateNavigation(browser, tabId, finalUrl) {
    browser._fireOnUpdated(tabId, { status: "loading" }, { url: "about:blank" });
    browser._fireOnUpdated(tabId, { status: "complete" }, { url: finalUrl });
}

/**
 * Load the navigate module fresh. Injects browser mock and resolveTab.
 */
function loadModule(browser, resolveTabImpl) {
    jest.resetModules();
    globalThis.browser = browser;

    // Inject resolveTab as the shared helper from tabs-manager
    globalThis.resolveTab = resolveTabImpl || (async () => 10);

    const registrations = {};
    globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
    require("../../ClaudeInSafari Extension/Resources/tools/navigate.js");
    return registrations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("navigate", () => {
    // T1: navigate to a full URL
    test("T1: navigates to a full https URL and returns final URL", async () => {
        const browser = makeBrowserMock({ updateUrl: "https://example.com" });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "https://example.com" });

        // Let the promise register the listener, then fire navigation sequence
        await Promise.resolve();
        simulateNavigation(browser, 10, "https://example.com");

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "https://example.com" });
    });

    // T2: URL without scheme gets https:// prepended
    test("T2: prepends https:// to URLs without a scheme", async () => {
        const browser = makeBrowserMock({ updateUrl: "https://example.com" });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "example.com" });

        await Promise.resolve();
        simulateNavigation(browser, 10, "https://example.com");

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "https://example.com" });
    });

    // T3: "back" triggers goBack (no "loading" event needed — BFCache safe)
    test("T3: 'back' calls goBack and returns the previous URL", async () => {
        const prevUrl = "https://previous.com";
        const browser = makeBrowserMock({ updateUrl: prevUrl });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "back" });

        await Promise.resolve();
        // History navigations skip the "loading" guard — direct "complete" resolves
        browser._fireOnUpdated(10, { status: "complete" }, { url: prevUrl });

        const result = await promise;
        expect(result).toBe(`Navigated to ${prevUrl}`);
        expect(browser.tabs.goBack).toHaveBeenCalledWith(10);
        expect(browser.tabs.update).not.toHaveBeenCalled();
    });

    // T4: "forward" triggers goForward (no "loading" event needed — BFCache safe)
    test("T4: 'forward' calls goForward and returns the next URL", async () => {
        const nextUrl = "https://next.com";
        const browser = makeBrowserMock({ updateUrl: nextUrl });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "forward" });

        await Promise.resolve();
        // History navigations skip the "loading" guard — direct "complete" resolves
        browser._fireOnUpdated(10, { status: "complete" }, { url: nextUrl });

        const result = await promise;
        expect(result).toBe(`Navigated to ${nextUrl}`);
        expect(browser.tabs.goForward).toHaveBeenCalledWith(10);
        expect(browser.tabs.update).not.toHaveBeenCalled();
    });

    // T5: empty url throws an error
    test("T5: empty url throws an error", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        await expect(tools["navigate"]({ url: "" }))
            .rejects.toThrow("url must be a non-empty string");
    });

    // T5b: missing url key entirely
    test("T5b: missing url key throws an error", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        await expect(tools["navigate"]({}))
            .rejects.toThrow("url must be a non-empty string");
    });

    // T5c: null args object
    test("T5c: null args throws an error", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        await expect(tools["navigate"](null))
            .rejects.toThrow("url must be a non-empty string");
    });

    // T6: invalid tabId — resolveTab throws "Tab not found"
    test("T6: invalid tabId propagates 'Tab not found' error", async () => {
        const browser = makeBrowserMock();
        const badResolve = async () => { throw new Error("Tab not found: 99"); };
        const tools = loadModule(browser, badResolve);

        await expect(tools["navigate"]({ url: "https://example.com", tabId: 99 }))
            .rejects.toThrow("Tab not found: 99");
    });

    // T7: navigation timeout after 30 seconds
    test("T7: times out after 30 seconds if onUpdated never fires", async () => {
        jest.useFakeTimers();

        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "https://example.com" });

        // Allow the listener to be registered
        await Promise.resolve();

        // Advance time past the 30-second timeout
        jest.advanceTimersByTime(31000);

        await expect(promise).rejects.toThrow("Navigation timed out after 30 seconds");

        // Both listeners must be cleaned up
        expect(browser.tabs.onUpdated.removeListener).toHaveBeenCalled();
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();

        jest.useRealTimers();
    });

    // T8: browser.tabs.update rejection cleans up listeners
    test("T8: browser.tabs.update rejection cleans up listeners and propagates error", async () => {
        const browser = makeBrowserMock();
        browser.tabs.update = jest.fn(async () => {
            throw new Error("Cannot navigate to restricted URL");
        });
        const tools = loadModule(browser);

        await expect(tools["navigate"]({ url: "chrome://extensions" }))
            .rejects.toThrow("Cannot navigate to restricted URL");

        // Settlement listeners must have been cleaned up via .cancel()
        expect(browser.tabs.onUpdated.removeListener).toHaveBeenCalled();
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
    });

    // T9: onUpdated events from other tab IDs are ignored
    test("T9: ignores onUpdated events from other tab IDs", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "https://example.com" });
        await Promise.resolve();

        // Fire loading+complete for wrong tab — should NOT resolve
        browser._fireOnUpdated(999, { status: "loading" }, { url: "https://wrong.com" });
        browser._fireOnUpdated(999, { status: "complete" }, { url: "https://wrong.com" });

        // Now fire for correct tab
        simulateNavigation(browser, 10, "https://example.com");

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
    });

    // T10: onUpdated events with status !== "complete" don't resolve prematurely
    test("T10: ignores onUpdated events with status other than 'complete'", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "https://example.com" });
        await Promise.resolve();

        // "loading" alone should not resolve
        browser._fireOnUpdated(10, { status: "loading" }, { url: "about:blank" });

        // Only "complete" after "loading" should resolve
        browser._fireOnUpdated(10, { status: "complete" }, { url: "https://example.com" });

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
    });

    // T11: tab closed during navigation gives clear error
    test("T11: tab closed during navigation rejects with clear error", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "https://example.com" });
        await Promise.resolve();

        // Simulate the tab being closed
        browser._fireOnRemoved(10);

        await expect(promise).rejects.toThrow("Tab 10 was closed during navigation");

        // All listeners must be cleaned up
        expect(browser.tabs.onUpdated.removeListener).toHaveBeenCalled();
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
    });

    // T12: whitespace-only url is treated as empty
    test("T12: whitespace-only url throws an error", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        await expect(tools["navigate"]({ url: "   " }))
            .rejects.toThrow("url must be a non-empty string");
    });

    // T13: http:// URLs are preserved without re-prefixing
    test("T13: http:// URLs are preserved without re-prefixing", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "http://insecure.example.com" });

        await Promise.resolve();
        simulateNavigation(browser, 10, "http://insecure.example.com");

        await promise;
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "http://insecure.example.com" });
    });

    // T14: capitalized "Back" is treated as a URL, not history navigation
    test("T14: 'Back' (capitalized) is treated as a URL, not history navigation", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "Back" });

        await Promise.resolve();
        simulateNavigation(browser, 10, "https://Back");

        await promise;
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "https://Back" });
        expect(browser.tabs.goBack).not.toHaveBeenCalled();
    });

    // T15: stale completion from prior navigation is ignored (URL nav only)
    test("T15: ignores 'complete' event that fires before any 'loading' event", async () => {
        jest.useFakeTimers();

        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "https://example.com" });
        await Promise.resolve();

        // Fire a stale "complete" from a previous page load (no "loading" first)
        browser._fireOnUpdated(10, { status: "complete" }, { url: "https://stale-page.com" });

        // The promise should NOT have resolved yet — advance to timeout
        jest.advanceTimersByTime(31000);

        await expect(promise).rejects.toThrow("Navigation timed out after 30 seconds");

        jest.useRealTimers();
    });

    // T16: URL with leading/trailing whitespace is trimmed
    test("T16: trims whitespace around URL before navigating", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "  https://example.com  " });

        await Promise.resolve();
        simulateNavigation(browser, 10, "https://example.com");

        await promise;
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "https://example.com" });
    });

    // T17: goBack rejection cleans up listeners and propagates error
    test("T17: goBack rejection cleans up listeners and propagates error", async () => {
        const browser = makeBrowserMock();
        browser.tabs.goBack = jest.fn(async () => {
            throw new Error("No previous page in history");
        });
        const tools = loadModule(browser);

        await expect(tools["navigate"]({ url: "back" }))
            .rejects.toThrow("No previous page in history");

        expect(browser.tabs.onUpdated.removeListener).toHaveBeenCalled();
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalled();
    });

    // T18: onRemoved for a different tab ID is ignored
    test("T18: ignores onRemoved events from other tab IDs", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "https://example.com" });
        await Promise.resolve();

        // Close a different tab — should NOT reject
        browser._fireOnRemoved(999);

        // Now complete the real navigation
        simulateNavigation(browser, 10, "https://example.com");

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
    });

    // T19: after ignoring stale complete, subsequent loading+complete resolves
    test("T19: recovers after stale complete — subsequent loading+complete resolves", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);
        const promise = tools["navigate"]({ url: "https://example.com" });
        await Promise.resolve();

        // Stale complete (no loading first) — ignored
        browser._fireOnUpdated(10, { status: "complete" }, { url: "https://stale.com" });

        // Real navigation sequence
        simulateNavigation(browser, 10, "https://example.com");

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
    });
});
