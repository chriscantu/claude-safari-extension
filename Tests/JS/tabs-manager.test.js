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
// Cross-module bootstrap: load tool-registry.js so the TAB_GONE_PATTERN
// global lands on globalThis exactly as it does in production (manifest
// load order: tool-registry.js → tabs-manager.js). Avoids duplicating the
// regex shape in the test file — if the pattern tightens in
// tool-registry.js, these tests pick it up automatically.
//
// Side effects: tool-registry also installs registerTool / executeTool /
// classifyExecuteScriptError on globalThis. Per-test loaders below override
// globalThis.registerTool with a capture stub before requiring tabs-manager,
// so the production registerTool is shadowed cleanly.
// ---------------------------------------------------------------------------

beforeEach(() => {
    jest.resetModules();
    require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
});

// ---------------------------------------------------------------------------
// Startup guard — fail-fast on missing globalThis.TAB_GONE_PATTERN
// ---------------------------------------------------------------------------

describe("startup guard", () => {
    test("throws if TAB_GONE_PATTERN is not set on globalThis (load-order regression)", () => {
        jest.resetModules();
        // beforeEach installs it; we explicitly remove it here to exercise the guard.
        delete globalThis.TAB_GONE_PATTERN;
        expect(() =>
            require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js")
        ).toThrow(/tool-registry\.js must be loaded before tabs-manager\.js/);
    });
});

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
        //
        // Seed storage with a sentinel pre-existing state so a partial-write
        // regression would be detectable: if the throwing callback ever
        // persisted its in-flight mutation, the sentinel state would be
        // overwritten and the post-throw assertions below would fail.
        const sentinel = {
            __claudeTabGroups: {
                nextGroupId: 5, nextTabId: 7,
                groups: {
                    "4": {
                        tabs: {
                            "6": { realTabId: 999, url: "https://sentinel.test", title: "S", isStale: false },
                        },
                    },
                },
            },
        };
        const bm = makeBrowserMock({
            existingRealTabs: { 999: { id: 999, url: "https://sentinel.test", title: "S" } },
            storageData: sentinel,
        });
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

        // Sentinel state must be intact: the throwing callback's in-flight
        // mutation (incremented nextTabId, possible new group entry) was
        // discarded because writeState never ran.
        const afterThrow = bm.storage.session._raw.__claudeTabGroups;
        expect(afterThrow.nextTabId).toBe(7);
        expect(afterThrow.nextGroupId).toBe(5);
        expect(Object.keys(afterThrow.groups).sort()).toEqual(["4"]);
        expect(afterThrow.groups["4"].tabs["6"].url).toBe("https://sentinel.test");

        // Lock released — second call must succeed.
        const result = await registrations["tabs_create_mcp"]({});
        expect(result).toMatch(/Created new MCP tab/);
        const after = bm.storage.session._raw.__claudeTabGroups;
        // Second call advances counters from the unmutated sentinel baseline.
        expect(after.nextTabId).toBe(8);
        // New tab landed under the existing group "4" (currentGroupId picked it).
        expect(after.groups["4"].tabs["7"]).toBeDefined();
        expect(after.groups["4"].tabs["7"].realTabId).toBe(850);
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

    test("T_resolveTab_transient: transient tabs.get error does not mark entry stale", async () => {
        // Spec 030: resolveTab MUST NOT tombstone on non-TAB_GONE_PATTERN errors.
        const bm = makeBrowserMock({ nextRealTabId: 1200 });
        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await registrations["tabs_create_mcp"]({});
        const stored = bm.storage.session._raw.__claudeTabGroups;
        const groupId = Object.keys(stored.groups)[0];
        const vtid = Number(Object.keys(stored.groups[groupId].tabs)[0]);

        // Transient (non-pattern) rejection — extension context invalidated.
        bm.tabs.get.mockImplementation(async () => {
            throw new Error("Extension context invalidated");
        });
        bm.storage.session.set.mockClear();

        await expect(globalThis.resolveTab(vtid))
            .rejects.toThrow(/unreachable \(transient\).*Extension context invalidated/);

        const after = bm.storage.session._raw.__claudeTabGroups;
        // isStale must NOT have been flipped to true.
        expect(after.groups[groupId].tabs[vtid].isStale).toBe(false);
        // No write happened (skipWrite path).
        expect(bm.storage.session.set).not.toHaveBeenCalled();
    });

    test("T_prune_ghost_group: applyStaleRemovals tolerates a group that disappeared between phases", async () => {
        // Phase-1 readState (outside lock) sees group "1" with a stale tab.
        // Phase-2 readState (inside lock) sees no groups — concurrent prune
        // or close removed it. The `if (!group) continue` guard must prevent
        // a TypeError; storage must remain consistent.
        const bm = makeBrowserMock({ existingRealTabs: {} });
        const stalePresent = {
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
        };
        const ghosted = {
            __claudeTabGroups: { nextGroupId: 2, nextTabId: 2, groups: {} },
        };
        // Phase-1 snapshot exposes the stale entry; phase-2 (and later)
        // re-reads see the ghosted state. mockResolvedValueOnce + a fallback
        // is robust to extra readState() calls (a future defensive early-out
        // wouldn't silently advance the mock past the intended race).
        bm.storage.session.get = jest.fn()
            .mockResolvedValueOnce({ ...stalePresent })
            .mockResolvedValue({ ...ghosted });

        jest.resetModules();
        globalThis.browser = bm;
        globalThis.registerTool = jest.fn();
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        // Must not throw despite the ghost-group race.
        await expect(globalThis.pruneStaleGroups()).resolves.toBeUndefined();
    });

    test("T_prune_corrupt: findStaleEntries flags non-numeric realTabId for removal", async () => {
        const bm = makeBrowserMock({
            existingRealTabs: { 10: { id: 10, url: "https://a.com", title: "A" } },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 3,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 10, url: "https://a.com", title: "A", isStale: false },
                                "2": { realTabId: "bad", url: "https://x.com", title: "Bad", isStale: false },
                            },
                        },
                    },
                },
            },
        });
        jest.resetModules();
        globalThis.browser = bm;
        globalThis.registerTool = jest.fn();
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        await globalThis.pruneStaleGroups();

        const state = bm.storage.session._raw.__claudeTabGroups;
        // Corrupt entry pruned.
        expect(state.groups["1"].tabs["2"]).toBeUndefined();
        // Live entry preserved.
        expect(state.groups["1"].tabs["1"]).toBeDefined();
    });

    test("T_context_ghost_group: handleTabsContextMcp tolerates target group disappearing between phase 1 and phase 3", async () => {
        // Phase-1 read sees group "1" with one tab. Phase-3 re-read (after the
        // out-of-lock probe phase) sees no groups — concurrent prune removed it.
        // The `if (!group)` guard in Phase 3 must surface NO_GROUP_MESSAGE
        // instead of a TypeError on `state.groups[init.groupId].tabs`.
        const bm = makeBrowserMock({
            existingRealTabs: { 50: { id: 50, url: "https://x.com", title: "X" } },
        });
        const phase1State = {
            __claudeTabGroups: {
                nextGroupId: 2, nextTabId: 2,
                groups: {
                    "1": {
                        tabs: {
                            "1": { realTabId: 50, url: "https://x.com", title: "X", isStale: false },
                        },
                    },
                },
            },
        };
        const ghosted = {
            __claudeTabGroups: { nextGroupId: 2, nextTabId: 2, groups: {} },
        };
        // Phase 1 reads the populated state; later reads see the ghost.
        // Use mockResolvedValueOnce so the mock is robust to extra reads
        // (e.g., a future defensive guard) rather than coupling to an
        // exact call count.
        bm.storage.session.get = jest.fn()
            .mockResolvedValueOnce({ ...phase1State })
            .mockResolvedValue({ ...ghosted });

        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        const result = await registrations["tabs_context_mcp"]({});
        expect(result).toBe("No MCP tab group exists. Use tabs_create_mcp to create a new tab.");
    });

    test("T_context_resolveTab_race: phase-3 must not clear a stale mark set by concurrent resolveTab", async () => {
        // Setup: vtid 1 is live initially. tabs_context_mcp's phase-2 probe
        // sees it live → records {vtid:1, isStale:false}. Between phase 2 and
        // phase 3, resolveTab acquires the lock, observes the tab is gone,
        // sets isStale=true, releases. Phase 3 must then NOT overwrite back
        // to false (Spec 030: monotonic IDs → tabs don't un-stale).
        const bm = makeBrowserMock({
            existingRealTabs: { 1300: { id: 1300, url: "https://r.com", title: "R" } },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 2,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 1300, url: "https://r.com", title: "R", isStale: false },
                            },
                        },
                    },
                },
            },
        });
        // First tabs.get (phase-2 probe) → live. Subsequent calls (resolveTab) → gone.
        let getCalls = 0;
        bm.tabs.get = jest.fn(async (id) => {
            getCalls++;
            if (getCalls === 1) return { id, url: "https://r.com", title: "R" };
            throw new Error(`No tab with id: ${id}`);
        });

        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        const [, resolveOutcome] = await Promise.all([
            registrations["tabs_context_mcp"]({}),
            globalThis.resolveTab(1).catch((e) => e),
        ]);

        // resolveTab observed the gone state and threw "Tab not found".
        expect(resolveOutcome).toBeInstanceOf(Error);
        expect(resolveOutcome.message).toContain("Tab not found: 1");

        // Critical: phase 3 of tabs_context_mcp must not have reverted isStale.
        const after = bm.storage.session._raw.__claudeTabGroups;
        expect(after.groups["1"].tabs["1"].isStale).toBe(true);
    });

    test("T_context_no_write_when_clean: tabs_context_mcp on all-live group skips storage write", async () => {
        // Hot-path optimization (Spec 030): if no isStale flag flipped, the
        // phase-3 callback must take the skipWrite path so no storage churn
        // occurs on read-only `tabs_context_mcp` calls.
        const bm = makeBrowserMock({
            existingRealTabs: { 1400: { id: 1400, url: "https://l.com", title: "L" } },
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 2,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 1400, url: "https://l.com", title: "L", isStale: false },
                            },
                        },
                    },
                },
            },
        });

        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        bm.storage.session.set.mockClear();
        const result = await registrations["tabs_context_mcp"]({});
        expect(result).toContain("Tab 1:");
        expect(result).not.toContain("[STALE]");
        // No storage write — no isStale flag changed.
        expect(bm.storage.session.set).not.toHaveBeenCalled();
    });

    test("T_prune_no_write_when_already_removed: applyStaleRemovals no-op skips storage write", async () => {
        // Probe phase identifies a stale vtid; before lock acquisition,
        // a concurrent caller has already deleted it. applyStaleRemovals
        // becomes a no-op — the prune commit must skip writeState rather
        // than churn storage with the unmodified fresh state.
        const bm = makeBrowserMock({ existingRealTabs: {} });

        // First read returns the populated state (probe phase).
        // Second+ reads see the already-cleaned state (lock phase).
        const populated = {
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
        };
        const cleaned = {
            __claudeTabGroups: { nextGroupId: 2, nextTabId: 2, groups: {} },
        };
        // First read returns the populated state (probe phase); subsequent
        // reads see the already-cleaned state (lock phase). mockResolvedValueOnce
        // makes intent explicit and is robust to extra reads.
        bm.storage.session.get = jest.fn()
            .mockResolvedValueOnce({ ...populated })
            .mockResolvedValue({ ...cleaned });

        jest.resetModules();
        globalThis.browser = bm;
        globalThis.registerTool = jest.fn();
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        bm.storage.session.set.mockClear();
        await globalThis.pruneStaleGroups();
        // applyStaleRemovals was a no-op (entry already gone) → no write.
        expect(bm.storage.session.set).not.toHaveBeenCalled();
    });

    test("T_currentGroupId_all_stale_fallback: prefers highest-ID group when every group is all-stale", async () => {
        // Two groups, all tabs in both are isStale: true. currentGroupId
        // must fall through the live-group preference loop and return the
        // highest-ID group ("2"). Without the fallback, tabs_context_mcp
        // would report no group and create a stale-context surprise.
        const bm = makeBrowserMock({
            existingRealTabs: {},
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 3, nextTabId: 5,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 901, url: "https://a.com", title: "A", isStale: true },
                            },
                        },
                        "2": {
                            tabs: {
                                "2": { realTabId: 902, url: "https://b.com", title: "B", isStale: true },
                            },
                        },
                    },
                },
            },
        });
        // Probe rejects with TAB_GONE_PATTERN — entries stay tombstoned.
        bm.tabs.get = jest.fn(async (id) => {
            throw new Error(`No tab with id: ${id}`);
        });

        jest.resetModules();
        globalThis.browser = bm;
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        const result = await registrations["tabs_context_mcp"]({});
        // Highest-ID group selected by the all-stale fallback.
        expect(result).toContain("Group 2");
        expect(result).not.toContain("Group 1");
        // Tab from the selected group surfaced with its [STALE] tag.
        expect(result).toContain("Tab 2:");
        expect(result).toContain("[STALE]");
    });

    test("T_context_transient_probe: handleTabsContextMcp transient probe preserves prior isStale", async () => {
        // Tab starts with isStale: true. Probe rejects with a non-TAB_GONE_PATTERN
        // error. The phase-2 transient branch must NOT push an update, and phase 3
        // must leave isStale unchanged (not flipped to false).
        const bm = makeBrowserMock({
            existingRealTabs: {},
            storageData: {
                __claudeTabGroups: {
                    nextGroupId: 2, nextTabId: 2,
                    groups: {
                        "1": {
                            tabs: {
                                "1": { realTabId: 60, url: "https://y.com", title: "Y", isStale: true },
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
        const registrations = {};
        globalThis.registerTool = (name, handler) => { registrations[name] = handler; };
        require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");

        const result = await registrations["tabs_context_mcp"]({});
        // Output reflects preserved staleness (the [STALE] tag was already set).
        expect(result).toContain("[STALE]");
        // isStale flag in storage was NOT flipped by the transient probe.
        const after = bm.storage.session._raw.__claudeTabGroups;
        expect(after.groups["1"].tabs["1"].isStale).toBe(true);
    });
});
