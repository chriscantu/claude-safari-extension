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
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
        const resolveTabFn = globalThis.resolveTab;

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
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
        const resolveTabFn = globalThis.resolveTab;

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
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
        const resolveTabFn = globalThis.resolveTab;

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

// ---------------------------------------------------------------------------
// pruneStaleGroups (Spec 025 §1)
// ---------------------------------------------------------------------------

describe("pruneStaleGroups", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.registerTool;
        delete globalThis.pruneStaleGroups;
    });

    function setup(opts) {
        jest.resetModules();
        const bm = makeBrowserMock(opts);
        globalThis.browser = bm;
        globalThis.registerTool = jest.fn();
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
        return bm;
    }

    test("T_prune1: removes tabs whose real tab no longer exists", async () => {
        const bm = setup({
            existingRealTabs: { 10: { id: 10, url: "https://a.com", title: "A" } },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 3,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 10, url: "https://a.com", title: "A", isStale: false },
                                "2": { realTabId: 99, url: "https://gone.com", title: "Gone", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups["1"].tabs)).toEqual(["1"]);
    });

    test("T_prune2: deletes group when all tabs are dead", async () => {
        const bm = setup({
            existingRealTabs: {},
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 2,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 99, url: "https://gone.com", title: "Gone", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups)).toEqual([]);
    });

    test("T_prune3: no-op when no groups exist", async () => {
        const bm = setup({ existingRealTabs: {} });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(state).toBeUndefined();
    });

    test("T_prune4: preserves groups with all live tabs", async () => {
        const bm = setup({
            existingRealTabs: {
                10: { id: 10, url: "https://a.com", title: "A" },
                11: { id: 11, url: "https://b.com", title: "B" },
            },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 3,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 10, url: "https://a.com", title: "A", isStale: false },
                                "2": { realTabId: 11, url: "https://b.com", title: "B", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups["1"].tabs)).toEqual(["1", "2"]);
    });
});

// ---------------------------------------------------------------------------
// withTabGroupLock — concurrency / serialization
// ---------------------------------------------------------------------------

describe("withTabGroupLock", () => {
    afterEach(() => {
        jest.resetModules();
        delete globalThis.browser;
        delete globalThis.registerTool;
        delete globalThis.pruneStaleGroups;
        delete globalThis.resolveTab;
    });

    test("T_concurrent: interleaved tabs_create_mcp calls do not lose tabs (lock serializes RMW)", async () => {
        // Mock browser.tabs.create with a yield so two concurrent handlers
        // would interleave in the absence of a lock. Without serialization,
        // both readState() observe nextTabId=1 and writeState() in sequence,
        // producing one tab. With the lock, both succeed and produce two.
        const bm = makeBrowserMock({ nextRealTabId: 700 });
        let createCount = 0;
        bm.tabs.create = jest.fn(async () => {
            createCount++;
            const id = 699 + createCount;
            await new Promise((r) => setTimeout(r, 0));
            return { id, url: "about:blank", title: "New Tab" };
        });
        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await Promise.all([
            registrations["tabs_create_mcp"]({}),
            registrations["tabs_create_mcp"]({}),
        ]);

        const state = bm.storage.session._raw.__claudeTabGroups;
        const groupIds = Object.keys(state.groups);
        expect(groupIds.length).toBe(1);
        const tabs = state.groups[groupIds[0]].tabs;
        // Both virtual tabs must persist — would be 1 without the lock.
        expect(Object.keys(tabs).length).toBe(2);
        // Distinct virtual IDs and distinct real IDs.
        const realIds = Object.values(tabs).map((t) => t.realTabId);
        expect(new Set(realIds).size).toBe(2);
    });

    test("T_lock_release_on_throw: callback throw releases lock, partial mutations not persisted, next acquirer succeeds", async () => {
        // First tabs_create_mcp call: tabs.create rejects → callback throws.
        // The lock's try/finally must release so the second call succeeds.
        // The first call's in-callback mutation (state.groups[<new>] = {tabs:{}})
        // must NOT be persisted because writeState never runs on throw.
        const bm = makeBrowserMock({ nextRealTabId: 800 });
        let attempt = 0;
        bm.tabs.create = jest.fn(async () => {
            attempt++;
            if (attempt === 1) throw new Error("simulated create failure");
            return { id: 850, url: "about:blank", title: "New Tab" };
        });
        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await expect(registrations["tabs_create_mcp"]({}))
            .rejects.toThrow("simulated create failure");
        // Failed call must not have persisted partial state (no group created).
        expect(bm.storage.session._raw.__claudeTabGroups).toBeUndefined();

        // Lock released — second call must succeed.
        const result = await registrations["tabs_create_mcp"]({});
        expect(result).toMatch(/Created new MCP tab/);
        const state = bm.storage.session._raw.__claudeTabGroups;
        expect(Object.keys(state.groups).length).toBe(1);
    });

    test("T_prune_race_window: tabs_create_mcp racing with prune does not lose the new tab", async () => {
        // Setup: vtid 1 → live (realTabId 10), vtid 2 → gone (realTabId 99).
        const bm = makeBrowserMock({
            existingRealTabs: { 10: { id: 10, url: "https://a.com", title: "A" } },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 3,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 10, url: "https://a.com", title: "A", isStale: false },
                                "2": { realTabId: 99, url: "https://gone.com", title: "Gone", isStale: false },
                            },
                        },
                    },
                },
            },
        });
        // Definitive "gone" pattern so findStaleEntries tombstones vtid 2.
        bm.tabs.get = jest.fn(async (id) => {
            if (id === 99) throw new Error(`No tab with id: ${id}`);
            if (id === 10) return { id: 10, url: "https://a.com", title: "A" };
            // The newly created real tab also resolves.
            return { id, url: "about:blank", title: "New" };
        });
        bm.tabs.create = jest.fn(async () => {
            // Yield so prune's findStaleEntries loop can interleave.
            await new Promise((r) => setTimeout(r, 0));
            return { id: 250, url: "about:blank", title: "New" };
        });

        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await Promise.all([
            globalThis.pruneStaleGroups(),
            registrations["tabs_create_mcp"]({}),
        ]);

        const state = bm.storage.session._raw.__claudeTabGroups;
        // Stale vtid 2 removed by prune.
        expect(state.groups["1"].tabs["2"]).toBeUndefined();
        // Live vtid 1 preserved.
        expect(state.groups["1"].tabs["1"]).toBeDefined();
        // Newly created vtid 3 from the racing tabs_create_mcp must survive.
        expect(state.groups["1"].tabs["3"]).toBeDefined();
        expect(state.groups["1"].tabs["3"].realTabId).toBe(250);
    });

    test("T_findStaleEntries_transient: transient tabs.get error preserves entry (not tombstoned)", async () => {
        // Non-tab-gone error (simulates extension context invalidation,
        // bridge hiccup) must NOT cause the vtid to be evicted.
        const bm = makeBrowserMock({
            existingRealTabs: {},
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 2,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 77, url: "https://x.com", title: "X", isStale: false },
                            },
                        },
                    },
                },
            },
        });
        bm.tabs.get = jest.fn(async () => {
            throw new Error("Extension context invalidated");
        });

        jest.resetModules();
        globalThis.browser = bm;
        globalThis.registerTool = jest.fn();
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        // Entry preserved despite probe error.
        expect(state.groups["1"].tabs["1"]).toBeDefined();
    });

    test("T_lock_fifo: serial dispatch preserves order across varying callback delays", async () => {
        // Three tabs_create_mcp calls dispatched in order. Even with varying
        // mock-create delays, FIFO acquisition must yield virtual IDs 1, 2, 3
        // in dispatch order.
        const bm = makeBrowserMock({ nextRealTabId: 900 });
        let calls = 0;
        bm.tabs.create = jest.fn(async () => {
            calls++;
            const id = 900 + calls;
            // Decreasing delay — without FIFO, later calls would land first.
            await new Promise((r) => setTimeout(r, (4 - calls) * 5));
            return { id, url: "about:blank", title: "New Tab" };
        });
        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        const [r1, r2, r3] = await Promise.all([
            registrations["tabs_create_mcp"]({}),
            registrations["tabs_create_mcp"]({}),
            registrations["tabs_create_mcp"]({}),
        ]);
        const ids = [r1, r2, r3].map((r) => Number(r.match(/Tab (\d+)/)[1]));
        expect(ids).toEqual([1, 2, 3]);
    });

    test("T_resolveTab_no_write_on_success: successful resolveTab does not write storage", async () => {
        const bm = makeBrowserMock({ nextRealTabId: 1000 });
        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await registrations["tabs_create_mcp"]({});
        const stored = bm.storage.session._raw.__claudeTabGroups;
        const groupId = Object.keys(stored.groups)[0];
        const vtid = Number(Object.keys(stored.groups[groupId].tabs)[0]);
        const expectedRealId = stored.groups[groupId].tabs[vtid].realTabId;

        bm.storage.session.set.mockClear();
        const realId = await globalThis.resolveTab(vtid);
        expect(realId).toBe(expectedRealId);
        // skipWrite path: no storage write.
        expect(bm.storage.session.set).not.toHaveBeenCalled();
    });

    test("T_resolveTab_persists_stale: definitive tab-gone marks isStale=true in storage", async () => {
        const bm = makeBrowserMock({ nextRealTabId: 1100 });
        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await registrations["tabs_create_mcp"]({});
        const stored = bm.storage.session._raw.__claudeTabGroups;
        const groupId = Object.keys(stored.groups)[0];
        const vtid = Number(Object.keys(stored.groups[groupId].tabs)[0]);
        const realId = stored.groups[groupId].tabs[vtid].realTabId;

        // Simulate the real tab being closed (definitive tab-gone shape).
        bm.tabs.get.mockImplementation(async (id) => {
            throw new Error(`No tab with id: ${id}`);
        });

        await expect(globalThis.resolveTab(vtid)).rejects.toThrow(`Tab not found: ${vtid}`);
        const after = bm.storage.session._raw.__claudeTabGroups;
        // Stale flag persisted via the non-skipWrite return path.
        expect(after.groups[groupId].tabs[vtid].isStale).toBe(true);
        // Sanity: realTabId unchanged.
        expect(after.groups[groupId].tabs[vtid].realTabId).toBe(realId);
    });
});
