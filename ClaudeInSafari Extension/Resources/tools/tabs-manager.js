/**
 * Tabs Manager — virtual tab group management.
 * Implements: tabs_context_mcp, tabs_create_mcp, resolveTab (shared helper).
 * See Spec 013 (tabs-manager).
 */

"use strict";

const STORAGE_KEY = "__claudeTabGroups";

// User-facing strings and tab defaults — kept module-local rather than in a
// shared file because tabs-manager.js is the only producer.
const ABOUT_BLANK = "about:blank";
const DEFAULT_TAB_TITLE = "New Tab";
const NO_GROUP_MESSAGE = "No MCP tab group exists. Use tabs_create_mcp to create a new tab.";

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
// Transactional lock over tab-group state
// ---------------------------------------------------------------------------
//
// All read-modify-write sequences against __claudeTabGroups MUST go through
// withTabGroupLock to serialize concurrent tool calls. Without it, two tools
// can readState() the same snapshot, mutate independently, and writeState()
// in sequence — losing one set of changes.
//
// JS is single-threaded but `await` yields to the event loop, so an
// in-memory promise chain is sufficient: each acquirer awaits the previous
// holder's release before reading state.

let lockChain = Promise.resolve();

/**
 * Run a critical section with exclusive access to tab-group state.
 *
 * The callback receives a fresh snapshot of state and may mutate it in place.
 * On return, the (possibly mutated) state is persisted and the callback's
 * return value is forwarded to the caller. To skip the persistence step
 * (read-only critical section), return `LOCK_SKIP_WRITE` via the helper:
 *
 *   return withTabGroupLock.skipWrite(myReturnValue);
 *
 * @template T
 * @param {(state: {nextGroupId:number, nextTabId:number, groups:Object}) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
async function withTabGroupLock(fn) {
    const prior = lockChain;
    let release;
    lockChain = new Promise((r) => { release = r; });
    try {
        await prior;
        const state = await readState();
        const out = await fn(state);
        if (out && out.__skipWrite === SKIP_WRITE_MARK) {
            return out.value;
        }
        await writeState(state);
        return out;
    } finally {
        release();
    }
}

const SKIP_WRITE_MARK = Symbol("tabGroupLock.skipWrite");
withTabGroupLock.skipWrite = (value) => ({ __skipWrite: SKIP_WRITE_MARK, value });

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
        // Safari MV2's browser.tabs.query is unreliable in several scenarios:
        // - After native app relaunch (make kill && make run)
        // - When called from sendNativeMessage callback context
        // - During focus transitions between Safari, Inspector, and Terminal
        // Retry with increasing delays to ride out transient unavailability.
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, attempt * 300));
            }
            try {
                let [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
                if (!activeTab) {
                    [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
                }
                if (!activeTab) {
                    const allActive = await browser.tabs.query({ active: true });
                    activeTab = allActive.find(t => !t.url?.startsWith("safari-extension://")) || allActive[0];
                }
                if (activeTab) {
                    return activeTab.id;
                }
            } catch (queryErr) {
                // browser.tabs.query can hard-reject during focus transitions or after
                // native app relaunch. Swallow and retry — on final attempt, fall through
                // to the "No active tab" throw below.
                if (attempt === 2) {
                    console.warn("resolveTab: tabs.query rejected on all attempts:", queryErr);
                }
            }
        }
        throw new Error("No active tab found in the current window");
    }

    const outcome = await withTabGroupLock(async (state) => {
        for (const group of Object.values(state.groups)) {
            const entry = group.tabs[virtualTabId];
            if (!entry) continue;

            try {
                await browser.tabs.get(entry.realTabId);
                return withTabGroupLock.skipWrite({ ok: true, realTabId: entry.realTabId });
            } catch (_) {
                entry.isStale = true;
                return { ok: false };
            }
        }
        return withTabGroupLock.skipWrite({ ok: false });
    });

    if (outcome.ok) return outcome.realTabId;
    throw new Error(`Tab not found: ${virtualTabId}`);
}

// ---------------------------------------------------------------------------
// Tool: tabs_context_mcp
// ---------------------------------------------------------------------------

async function handleTabsContextMcp(args) {
    const { createIfEmpty = false } = args || {};

    return await withTabGroupLock(async (state) => {
        let groupId = currentGroupId(state.groups);

        if (groupId === null) {
            if (!createIfEmpty) {
                return withTabGroupLock.skipWrite(NO_GROUP_MESSAGE);
            }
            groupId = String(state.nextGroupId++);
            state.groups[groupId] = { tabs: {} };
            return `=== MCP Tab Group (Group ${groupId}) ===\n\nTotal: 0 tab(s)`;
        }

        const group = state.groups[groupId];
        for (const entry of Object.values(group.tabs)) {
            await refreshStaleness(entry);
        }

        const lines = [`=== MCP Tab Group (Group ${groupId}) ===`, ""];
        const tabEntries = Object.entries(group.tabs);
        for (const [vtid, entry] of tabEntries) {
            const staleTag = entry.isStale ? " [STALE]" : "";
            lines.push(`Tab ${vtid}: ${entry.title} — ${entry.url}${staleTag}`);
        }
        lines.push("");
        lines.push(`Total: ${tabEntries.length} tab(s)`);
        return lines.join("\n");
    });
}

// ---------------------------------------------------------------------------
// Tool: tabs_create_mcp
// ---------------------------------------------------------------------------

async function handleTabsCreateMcp(_args) {
    return await withTabGroupLock(async (state) => {
        let groupId = currentGroupId(state.groups);
        if (groupId === null) {
            groupId = String(state.nextGroupId++);
            state.groups[groupId] = { tabs: {} };
        }

        let newTab;
        try {
            newTab = await browser.tabs.create({ url: ABOUT_BLANK, active: true });
        } catch (err) {
            throw new Error(err.message || String(err));
        }

        const virtualTabId = state.nextTabId++;
        state.groups[groupId].tabs[virtualTabId] = {
            realTabId: newTab.id,
            url: newTab.url || ABOUT_BLANK,
            title: newTab.title || DEFAULT_TAB_TITLE,
            isStale: false,
        };

        return (
            `Created new MCP tab (Tab ${virtualTabId}) in Group ${groupId}.\n` +
            `The new tab is ready for navigation.`
        );
    });
}

// ---------------------------------------------------------------------------
// Prune stale groups (Spec 025 §1)
// ---------------------------------------------------------------------------

/**
 * Flatten the (group, vtid, entry) triples in state.groups into a single list.
 */
function flattenTabEntries(groups) {
    return Object.entries(groups).flatMap(([groupId, group]) =>
        Object.entries(group.tabs).map(([vtid, entry]) => ({ groupId, vtid, entry }))
    );
}

/**
 * Identify tab entries whose real tab no longer exists.
 * Read-only — does not mutate state. Safe to run outside the lock so that
 * the (potentially N sequential `browser.tabs.get`) probe phase does not
 * block concurrent tool calls.
 */
async function findStaleEntries(state) {
    const stale = [];
    for (const { groupId, vtid, entry } of flattenTabEntries(state.groups)) {
        if (typeof entry.realTabId !== "number") {
            console.warn(`prune: corrupt entry vtid=${vtid} in group=${groupId}`);
            stale.push({ groupId, vtid });
            continue;
        }
        try {
            await browser.tabs.get(entry.realTabId);
        } catch (_) {
            stale.push({ groupId, vtid });
        }
    }
    return stale;
}

/**
 * Apply removals from a previously-collected stale list. Each deletion is
 * guarded by an existence check, so concurrent additions to other vtids
 * between scan and apply are preserved.
 */
function applyStaleRemovals(state, staleEntries) {
    for (const { groupId, vtid } of staleEntries) {
        const group = state.groups[groupId];
        if (!group) continue;
        delete group.tabs[vtid];
        if (Object.keys(group.tabs).length === 0) {
            delete state.groups[groupId];
        }
    }
}

/**
 * Remove tab entries whose real tab no longer exists.
 * Delete groups that become empty after pruning.
 * Called periodically from background.js on a 60-second interval.
 *
 * Two-phase: probe outside the lock (so tool calls aren't queued behind N
 * sequential `browser.tabs.get` calls), then re-read fresh state under the
 * lock and apply removals.
 */
async function pruneStaleGroups() {
    const snapshot = await readState();
    if (!snapshot.groups || Object.keys(snapshot.groups).length === 0) return;

    const staleEntries = await findStaleEntries(snapshot);
    if (staleEntries.length === 0) return;

    await withTabGroupLock(async (state) => {
        applyStaleRemovals(state, staleEntries);
    });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool("tabs_context_mcp", handleTabsContextMcp);
registerTool("tabs_create_mcp", handleTabsCreateMcp);

// Expose resolveTab and pruneStaleGroups globally so other modules can use them
if (typeof globalThis !== "undefined") {
    globalThis.resolveTab = resolveTab;
    globalThis.pruneStaleGroups = pruneStaleGroups;
}
