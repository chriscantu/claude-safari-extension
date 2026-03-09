/**
 * Tabs Manager — virtual tab group management.
 * Implements: tabs_context_mcp, tabs_create_mcp, resolveTab (shared helper).
 * See Spec 013 (tabs-manager).
 */

"use strict";

const STORAGE_KEY = "__claudeTabGroups";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** @returns {Promise<{nextGroupId:number, nextTabId:number, groups:Object}>} */
async function readState() {
    const result = await browser.storage.session.get(STORAGE_KEY);
    return result[STORAGE_KEY] || { nextGroupId: 1, nextTabId: 1, groups: {} };
}

/** @param {{nextGroupId:number, nextTabId:number, groups:Object}} state */
async function writeState(state) {
    await browser.storage.session.set({ [STORAGE_KEY]: state });
}

// ---------------------------------------------------------------------------
// Current group resolution
// ---------------------------------------------------------------------------

/**
 * Returns the "current" group: the most recently created group with at least
 * one non-stale tab, or the highest-ID group if all are stale/empty.
 * Returns null if no groups exist.
 *
 * @param {Object} groups
 * @returns {string|null} groupId (as string key)
 */
function currentGroupId(groups) {
    const ids = Object.keys(groups).map(Number).sort((a, b) => b - a); // descending
    if (ids.length === 0) return null;

    // Prefer highest-ID group that has at least one non-stale tab
    for (const id of ids) {
        const tabs = groups[id].tabs;
        const hasLive = Object.values(tabs).some((t) => !t.isStale);
        if (hasLive) return String(id);
    }
    // Fall back to highest-ID group (all stale / empty)
    return String(ids[0]);
}

// ---------------------------------------------------------------------------
// Stale check helper
// ---------------------------------------------------------------------------

/**
 * Checks whether a real tab still exists and marks it stale in-place if not.
 * Mutates tabEntry.isStale.
 */
async function refreshStaleness(tabEntry) {
    try {
        await browser.tabs.get(tabEntry.realTabId);
        tabEntry.isStale = false;
    } catch (_) {
        tabEntry.isStale = true;
    }
}

// ---------------------------------------------------------------------------
// resolveTab — exported for use by other tool modules
// ---------------------------------------------------------------------------

/**
 * Resolves a virtual tab ID to the corresponding real Safari tab ID.
 *
 * @param {number|null|undefined} virtualTabId
 * @returns {Promise<number>} real Safari tab ID
 * @throws {Error} "Tab not found: <virtualTabId>" if stale or unknown
 */
async function resolveTab(virtualTabId) {
    // null / undefined → active tab
    if (virtualTabId == null) {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
            throw new Error("No active tab found in the current window");
        }
        return activeTab.id;
    }

    const state = await readState();
    for (const group of Object.values(state.groups)) {
        const entry = group.tabs[virtualTabId];
        if (!entry) continue;

        // Verify the real tab still exists
        try {
            await browser.tabs.get(entry.realTabId);
            return entry.realTabId;
        } catch (_) {
            // Mark stale and persist
            entry.isStale = true;
            await writeState(state);
            throw new Error(`Tab not found: ${virtualTabId}`);
        }
    }

    throw new Error(`Tab not found: ${virtualTabId}`);
}

// ---------------------------------------------------------------------------
// Tool: tabs_context_mcp
// ---------------------------------------------------------------------------

async function handleTabsContextMcp(args) {
    const { createIfEmpty = false } = args || {};

    let state = await readState();
    let groupId = currentGroupId(state.groups);

    if (groupId === null) {
        if (!createIfEmpty) {
            return "No MCP tab group exists. Use tabs_create_mcp to create a new tab.";
        }
        // Create an empty group
        groupId = String(state.nextGroupId++);
        state.groups[groupId] = { tabs: {} };
        await writeState(state);
        return `=== MCP Tab Group (Group ${groupId}) ===\n\nTotal: 0 tab(s)`;
    }

    // Refresh staleness for all tabs in the current group
    const group = state.groups[groupId];
    for (const entry of Object.values(group.tabs)) {
        await refreshStaleness(entry);
    }
    await writeState(state);

    // Build output
    const lines = [`=== MCP Tab Group (Group ${groupId}) ===`, ""];
    const tabEntries = Object.entries(group.tabs);
    for (const [vtid, entry] of tabEntries) {
        const staleTag = entry.isStale ? " [STALE]" : "";
        lines.push(`Tab ${vtid}: ${entry.title} — ${entry.url}${staleTag}`);
    }
    lines.push("");
    lines.push(`Total: ${tabEntries.length} tab(s)`);
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool: tabs_create_mcp
// ---------------------------------------------------------------------------

async function handleTabsCreateMcp(_args) {
    let state = await readState();

    // Ensure a group exists
    let groupId = currentGroupId(state.groups);
    if (groupId === null) {
        groupId = String(state.nextGroupId++);
        state.groups[groupId] = { tabs: {} };
    }

    // Open a new real tab
    let newTab;
    try {
        newTab = await browser.tabs.create({ url: "about:blank", active: true });
    } catch (err) {
        throw new Error(err.message || String(err));
    }

    // Assign a virtual tab ID
    const virtualTabId = state.nextTabId++;
    state.groups[groupId].tabs[virtualTabId] = {
        realTabId: newTab.id,
        url: newTab.url || "about:blank",
        title: newTab.title || "New Tab",
        isStale: false,
    };

    await writeState(state);

    return (
        `Created new MCP tab (Tab ${virtualTabId}) in Group ${groupId}.\n` +
        `The new tab is ready for navigation.`
    );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool("tabs_context_mcp", handleTabsContextMcp);
registerTool("tabs_create_mcp", handleTabsCreateMcp);

// Expose resolveTab globally so other tool modules can use it
if (typeof globalThis !== "undefined") {
    globalThis.resolveTab = resolveTab;

    // Test hook: allows tests to capture the resolveTab function directly
    if (typeof globalThis.__captureResolveTab === "function") {
        globalThis.__captureResolveTab(resolveTab);
    }
}
