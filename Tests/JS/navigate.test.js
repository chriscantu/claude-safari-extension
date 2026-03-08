/**
 * Tests for tools/navigate.js
 * Covers all test cases defined in Spec 008 (T1–T7).
 *
 * Key mock challenges:
 *   - browser.tabs.onUpdated: event-listener pattern; captured and fired manually
 *   - 30-second timeout: controlled via Jest fake timers (T7)
 *   - resolveTab: injected on globalThis before module load
 */

"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a browser mock. _fireOnUpdated() lets tests trigger the onUpdated
 * event synchronously to simulate navigation completing.
 */
function makeBrowserMock(opts = {}) {
    const {
        updateUrl = "https://example.com",   // final URL returned after navigation
    } = opts;

    let onUpdatedListener = null;

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
        },
        _fireOnUpdated(tabId, changeInfo, tab) {
            if (onUpdatedListener) onUpdatedListener(tabId, changeInfo, tab);
        },
    };
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

        // Let the promise register the listener, then fire navigation complete
        await Promise.resolve();
        browser._fireOnUpdated(10, { status: "complete" }, { url: "https://example.com" });

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "https://example.com" });
    });

    // T2: bare hostname gets https:// prepended
    test("T2: prepends https:// to URLs without a scheme", async () => {
        const browser = makeBrowserMock({ updateUrl: "https://example.com" });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "example.com" });

        await Promise.resolve();
        browser._fireOnUpdated(10, { status: "complete" }, { url: "https://example.com" });

        const result = await promise;
        expect(result).toBe("Navigated to https://example.com");
        // Must have prepended https://
        expect(browser.tabs.update).toHaveBeenCalledWith(10, { url: "https://example.com" });
    });

    // T3: "back" triggers goBack
    test("T3: 'back' calls goBack and returns the previous URL", async () => {
        const prevUrl = "https://previous.com";
        const browser = makeBrowserMock({ updateUrl: prevUrl });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "back" });

        await Promise.resolve();
        browser._fireOnUpdated(10, { status: "complete" }, { url: prevUrl });

        const result = await promise;
        expect(result).toBe(`Navigated to ${prevUrl}`);
        expect(browser.tabs.goBack).toHaveBeenCalledWith(10);
        expect(browser.tabs.update).not.toHaveBeenCalled();
    });

    // T4: "forward" triggers goForward
    test("T4: 'forward' calls goForward and returns the next URL", async () => {
        const nextUrl = "https://next.com";
        const browser = makeBrowserMock({ updateUrl: nextUrl });
        const tools = loadModule(browser);

        const promise = tools["navigate"]({ url: "forward" });

        await Promise.resolve();
        browser._fireOnUpdated(10, { status: "complete" }, { url: nextUrl });

        const result = await promise;
        expect(result).toBe(`Navigated to ${nextUrl}`);
        expect(browser.tabs.goForward).toHaveBeenCalledWith(10);
        expect(browser.tabs.update).not.toHaveBeenCalled();
    });

    // T5: empty url is an error
    test("T5: empty url returns isError", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        await expect(tools["navigate"]({ url: "" }))
            .rejects.toThrow("url must be a non-empty string");
    });

    // T5b: missing url key entirely
    test("T5b: missing url key is treated the same as empty", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        await expect(tools["navigate"]({}))
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

        // Listener must be cleaned up
        expect(browser.tabs.onUpdated.removeListener).toHaveBeenCalled();

        jest.useRealTimers();
    });
});
