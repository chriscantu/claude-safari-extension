/**
 * Tests for tools/tabs-manager.js
 * Covers all test cases defined in Spec 013 (T1–T8).
 *
 * The module is loaded via require() after setting up a globalThis.browser mock.
 * Each test rebuilds the module state using jest.resetModules().
 */

"use strict";

// ---------------------------------------------------------------------------
// Browser API mock factory
// ---------------------------------------------------------------------------

function makeBrowserMock(opts = {}) {
    const {
        existingRealTabs = {},   // { [realTabId]: { id, url, title } }
        activeTabId = 99,
        storageData = {},
    } = opts;

    const storage = { ...storageData };

    return {
        storage: {
            session: {
                get: jest.fn(async (key) => {
                    if (typeof key === "string") return { [key]: storage[key] };
                    // key is an array
                    return key.reduce((acc, k) => {
                        if (storage[k] !== undefined) acc[k] = storage[k];
                        return acc;
                    }, {});
                }),
                set: jest.fn(async (obj) => {
                    Object.assign(storage, obj);
                }),
                _raw: storage,
            },
        },
        tabs: {
            get: jest.fn(async (tabId) => {
                const tab = existingRealTabs[tabId];
                if (!tab) throw new Error(`No tab with id: ${tabId}`);
                return tab;
            }),
            create: jest.fn(async ({ url, active }) => {
                const id = opts.nextRealTabId ?? 200;
                opts.nextRealTabId = (opts.nextRealTabId ?? 200) + 1;
                const tab = { id, url: url || "about:blank", title: "New Tab" };
                existingRealTabs[id] = tab;
                return tab;
            }),
            query: jest.fn(async ({ active, currentWindow }) => {
                return [existingRealTabs[activeTabId] ?? { id: activeTabId, url: "about:blank", title: "Active" }];
            }),
        },
    };
}

// ---------------------------------------------------------------------------
// Module loader helper — re-requires module fresh per test
// ---------------------------------------------------------------------------

function loadModule(browser) {
    jest.resetModules();
    globalThis.browser = browser;
    // registerTool collects registrations; we just need the exported functions
    const registrations = {};
    globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
    require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
    return registrations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tabs-manager", () => {
    // T1: tabs_context_mcp with no group, createIfEmpty false (default)
    test("T1: returns 'No MCP tab group exists' when storage is empty", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        const result = await tools["tabs_context_mcp"]({});
        expect(result).toContain("No MCP tab group exists");
    });

    // T2: tabs_context_mcp with createIfEmpty:true and no existing group
    test("T2: createIfEmpty:true creates a group and reports it as empty", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        const result = await tools["tabs_context_mcp"]({ createIfEmpty: true });
        expect(result).toMatch(/MCP Tab Group \(Group \d+\)/);
        expect(result).toContain("Total: 0 tab(s)");
        // Storage should now have a group
        const stored = browser.storage.session._raw["__claudeTabGroups"];
        expect(stored).toBeDefined();
        expect(Object.keys(stored.groups).length).toBe(1);
    });

    // T3: tabs_create_mcp creates a tab and returns a virtual tab ID
    test("T3: tabs_create_mcp creates a real tab and returns confirmation", async () => {
        const browser = makeBrowserMock();
        const tools = loadModule(browser);

        const result = await tools["tabs_create_mcp"]({});
        expect(result).toMatch(/Created new MCP tab \(Tab \d+\)/);
        expect(result).toMatch(/Group \d+/);
        expect(browser.tabs.create).toHaveBeenCalledWith({ url: "about:blank", active: true });
    });

    // T4: tabs_context_mcp after creating 2 tabs lists both with their URLs
    test("T4: lists both tabs after two tabs_create_mcp calls", async () => {
        const browser = makeBrowserMock({ nextRealTabId: 201 });
        const tools = loadModule(browser);

        await tools["tabs_create_mcp"]({});
        await tools["tabs_create_mcp"]({});

        const result = await tools["tabs_context_mcp"]({});
        expect(result).toMatch(/MCP Tab Group/);
        expect(result).toContain("Total: 2 tab(s)");
        // Both virtual tabs should appear
        expect((result.match(/Tab \d+:/g) || []).length).toBe(2);
    });

    // T5: resolveTab(null) returns the active tab's real ID
    test("T5: resolveTab(null) returns the currently active tab ID", async () => {
        const activeTabId = 55;
        const browser = makeBrowserMock({
            existingRealTabs: { [activeTabId]: { id: activeTabId, url: "https://example.com", title: "Example" } },
            activeTabId,
        });
        jest.resetModules();
        globalThis.browser = browser;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        let resolveTabFn;
        globalThis.__captureResolveTab = (fn) => { resolveTabFn = fn; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        expect(resolveTabFn).toBeDefined();
        const realId = await resolveTabFn(null);
        expect(realId).toBe(activeTabId);
    });

    // T6: resolveTab on a stale (closed) tab throws "Tab not found"
    test("T6: resolveTab on stale tab throws 'Tab not found'", async () => {
        const browser = makeBrowserMock({ nextRealTabId: 300 });
        jest.resetModules();
        globalThis.browser = browser;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        let resolveTabFn;
        globalThis.__captureResolveTab = (fn) => { resolveTabFn = fn; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        // Create a tab first
        await registrations["tabs_create_mcp"]({});
        const stored = browser.storage.session._raw["__claudeTabGroups"];
        const groupId = Object.keys(stored.groups)[0];
        const virtualTabId = Number(Object.keys(stored.groups[groupId].tabs)[0]);
        const realTabId = stored.groups[groupId].tabs[virtualTabId].realTabId;

        // Simulate closing the real tab
        delete browser.tabs.get.getMockImplementation;
        browser.tabs.get.mockRejectedValueOnce(new Error(`No tab with id: ${realTabId}`));

        await expect(resolveTabFn(virtualTabId)).rejects.toThrow(`Tab not found: ${virtualTabId}`);
    });

    // T7: tabs_context_mcp shows [STALE] for a closed tab
    test("T7: closed real tab appears as [STALE] in tabs_context_mcp output", async () => {
        const browser = makeBrowserMock({ nextRealTabId: 400 });
        const tools = loadModule(browser);

        await tools["tabs_create_mcp"]({});
        const stored = browser.storage.session._raw["__claudeTabGroups"];
        const groupId = Object.keys(stored.groups)[0];
        const virtualTabId = Number(Object.keys(stored.groups[groupId].tabs)[0]);
        const realTabId = stored.groups[groupId].tabs[virtualTabId].realTabId;

        // Simulate the real tab being closed
        browser.tabs.get.mockImplementation(async (id) => {
            if (id === realTabId) throw new Error(`No tab with id: ${id}`);
            throw new Error(`No tab with id: ${id}`);
        });

        const result = await tools["tabs_context_mcp"]({});
        expect(result).toContain("[STALE]");
    });

    // T9: resolveTab(null) throws when browser.tabs.query returns no active tab
    test("T9: resolveTab(null) throws when no active tab is found", async () => {
        const browser = makeBrowserMock({ activeTabId: 99 });
        // Override query to return an empty array (no active tab)
        browser.tabs.query = jest.fn(async () => []);
        jest.resetModules();
        globalThis.browser = browser;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        let resolveTabFn;
        globalThis.__captureResolveTab = (fn) => { resolveTabFn = fn; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await expect(resolveTabFn(null)).rejects.toThrow("No active tab found in the current window");
    });

    // T8: two sequential tabs_create_mcp calls produce different virtual tab IDs
    test("T8: two sequential tabs_create_mcp calls get different virtual tab IDs", async () => {
        const browser = makeBrowserMock({ nextRealTabId: 500 });
        const tools = loadModule(browser);

        const r1 = await tools["tabs_create_mcp"]({});
        const r2 = await tools["tabs_create_mcp"]({});

        const id1 = r1.match(/Tab (\d+)/)[1];
        const id2 = r2.match(/Tab (\d+)/)[1];
        expect(id1).not.toBe(id2);
    });
});
