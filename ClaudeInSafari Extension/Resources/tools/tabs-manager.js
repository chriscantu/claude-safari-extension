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

// Definitive "tab is gone" error shape from browser.tabs.get. Sourced from
// tool-registry.js (loaded before this file per manifest.json background.scripts
// order — see load-order comment in background.js) and exposed via
// globalThis.TAB_GONE_PATTERN. Single source of truth so the transient-vs-gone
// classification stays in sync across modules. Other errors (extension context
// invalidated, focus transition, throttling) are transient and MUST NOT be
// treated as tombstones — see findStaleEntries and resolveTab.
const TAB_GONE_PATTERN = globalThis.TAB_GONE_PATTERN;
// Startup guard: fail-fast on load-order violation. Without this, a missing
// global silently falls through to `undefined.test(...)` deep inside
// probeRealTab on the first tab-gone rejection — an opaque TypeError that
// hides the real cause (manifest.json background.scripts reorder).
if (!TAB_GONE_PATTERN) {
    throw new Error(
        "tabs-manager: TAB_GONE_PATTERN not set — tool-registry.js must be loaded before tabs-manager.js (check manifest.json background.scripts order)"
    );
}

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

// Sentinel for the skipWrite escape hatch. Declared before withTabGroupLock
// so source order matches the dependency: the function below closes over
// SKIP_WRITE_MARK at call time. (Hoisted-function-over-later-const works at
// runtime, but reading top-to-bottom shouldn't require knowing that.)
const SKIP_WRITE_MARK = Symbol("tabGroupLock.skipWrite");

/**
 * Run a critical section with exclusive access to tab-group state.
 *
 * The callback receives a fresh snapshot of state and may mutate it in place.
 * On return, the (possibly mutated) state is persisted and the callback's
 * return value is forwarded to the caller. To skip the persistence step
 * (read-only critical section), wrap the return value with
 * `withTabGroupLock.skipWrite(...)`:
 *
 *   return withTabGroupLock.skipWrite(myReturnValue);
 *
 * Contract — skipWrite detection: the check is `out && out.__skipWrite ===
 * SKIP_WRITE_MARK`. Returning any falsy value (including `false`, `0`, `""`,
 * `null`, `undefined`) bypasses skipWrite and triggers writeState — even if
 * the callback intended a read-only path. To opt out of the write, ALWAYS
 * wrap the value via `withTabGroupLock.skipWrite(...)`, which produces a
 * truthy sentinel object regardless of `value`.
 *
 * Throws inside the callback propagate to the caller; partial mutations
 * to `state` are NOT persisted because `writeState` is only reached on
 * successful return.
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
 * Probe whether a real tab still exists. Classifies the result under the
 * shared transient-error policy so all sites (resolveTab, prune,
 * tabs_context_mcp) treat tab-gone vs transient errors uniformly.
 *
 * @param {number} realTabId
 * @returns {Promise<{live:true} | {live:false, gone:true} | {live:false, gone:false, err:Error}>}
 *   - `live:true` → tab exists.
 *   - `live:false, gone:true` → tab definitively gone (rejection matched
 *     TAB_GONE_PATTERN). Safe to tombstone.
 *   - `live:false, gone:false, err` → transient failure (extension context
 *     invalidated, native bridge hiccup, focus transition). Caller MUST
 *     preserve the entry; do not mark stale.
 */
async function probeRealTab(realTabId) {
    try {
        await browser.tabs.get(realTabId);
        return { live: true };
    } catch (err) {
        const msg = (err && err.message) || String(err);
        if (TAB_GONE_PATTERN.test(msg)) {
            return { live: false, gone: true };
        }
        return { live: false, gone: false, err };
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

    // LOCK-HOLD NOTE: the mutex is held across probeRealTab (one
    // browser.tabs.get call) because the entry lookup and stale-mark
    // must be atomic — a concurrent pruneStaleGroups must not observe
    // a stale entry as live between our find and our write. Cost: one
    // IPC round-trip (typically tens of ms) while the lock is held;
    // concurrent acquirers queue for that window. Acceptable because
    // resolveTab probes exactly one tab per call (not N sequential
    // ones). See Spec 030 §Design.
    const outcome = await withTabGroupLock(async (state) => {
        for (const group of Object.values(state.groups)) {
            const entry = group.tabs[virtualTabId];
            if (!entry) continue;

            const probe = await probeRealTab(entry.realTabId);
            if (probe.live) {
                return withTabGroupLock.skipWrite({ ok: true, realTabId: entry.realTabId });
            }
            if (probe.gone) {
                // Definitive: tab is gone. Persist isStale=true intentionally —
                // the non-skipWrite return triggers writeState. A later "fix"
                // to skipWrite here would silently lose the staleness marker.
                console.warn(
                    `resolveTab: tab definitively gone for vtid=${virtualTabId} (realTabId=${entry.realTabId})`
                );
                entry.isStale = true;
                return { ok: false, gone: true };
            }
            // Transient — do NOT tombstone. Skip the writeState path and
            // surface the original error so the caller can distinguish
            // "tab gone" from "tab unreachable right now".
            console.warn(
                `resolveTab: transient tabs.get error for vtid=${virtualTabId} (realTabId=${entry.realTabId}); preserving entry:`,
                probe.err
            );
            return withTabGroupLock.skipWrite({ ok: false, gone: false, err: probe.err });
        }
        return withTabGroupLock.skipWrite({ ok: false, gone: true });
    });

    if (outcome.ok) return outcome.realTabId;
    if (outcome.gone) throw new Error(`Tab not found: ${virtualTabId}`);
    // Transient: rethrow original error with context.
    throw new Error(
        `resolveTab: vtid=${virtualTabId} unreachable (transient): ${(outcome.err && outcome.err.message) || String(outcome.err)}`
    );
}

// ---------------------------------------------------------------------------
// Tool: tabs_context_mcp
// ---------------------------------------------------------------------------

async function handleTabsContextMcp(args) {
    const { createIfEmpty = false } = args || {};

    // Phase 1 (under lock): determine the target group, optionally creating
    // an empty one. Snapshot the (vtid, realTabId) pairs we'll probe.
    const init = await withTabGroupLock(async (state) => {
        let groupId = currentGroupId(state.groups);
        if (groupId === null) {
            if (!createIfEmpty) {
                return withTabGroupLock.skipWrite({ done: NO_GROUP_MESSAGE });
            }
            groupId = String(state.nextGroupId++);
            state.groups[groupId] = { tabs: {} };
            return { done: `=== MCP Tab Group (Group ${groupId}) ===\n\nTotal: 0 tab(s)` };
        }
        const probes = Object.entries(state.groups[groupId].tabs).map(
            ([vtid, entry]) => ({ vtid, realTabId: entry.realTabId })
        );
        return withTabGroupLock.skipWrite({ groupId, probes });
    });

    if ("done" in init) return init.done;

    // Phase 2 (no lock): probe staleness for each tab. The lock is released
    // here so concurrent tabs_create_mcp / resolveTab calls aren't blocked
    // by N sequential browser.tabs.get round-trips.
    //
    // Only definitive-gone results are recorded — phase 3's monotonic-stale
    // invariant (entries flip TO stale, never back to live) means a `live`
    // probe is always a no-op on the existing flag. Skipping `live` pushes
    // here makes phase 3's contract self-evident from the data shape.
    // Transient errors preserve the prior value and are logged.
    const staleVtids = [];
    for (const { vtid, realTabId } of init.probes) {
        const probe = await probeRealTab(realTabId);
        if (probe.gone) {
            staleVtids.push(vtid);
        } else if (!probe.live) {
            console.warn(
                `tabs_context_mcp: transient probe error for vtid=${vtid} (realTabId=${realTabId}); preserving prior isStale:`,
                probe.err
            );
        }
    }

    // Phase 3 (under lock): re-read fresh state, apply staleness updates to
    // entries that still exist, and build the output.
    return await withTabGroupLock(async (state) => {
        const group = state.groups[init.groupId];
        if (!group) {
            // Group was concurrently removed (e.g., prune deleted it after
            // it became empty). Surface the standard no-group message.
            return withTabGroupLock.skipWrite(NO_GROUP_MESSAGE);
        }
        // Only flip entries TO stale, never back to live. Under Safari's
        // monotonically-increasing tab-ID policy (Spec 030 §Tab-ID reuse
        // assumption), a closed tab never becomes live again. Track `dirty`
        // so we can skip writeState entirely in the common no-stale-discovered
        // case (tabs_context_mcp is the hot path).
        let dirty = false;
        for (const vtid of staleVtids) {
            const entry = group.tabs[vtid];
            if (entry && !entry.isStale) {
                entry.isStale = true;
                dirty = true;
            }
        }

        const lines = [`=== MCP Tab Group (Group ${init.groupId}) ===`, ""];
        const tabEntries = Object.entries(group.tabs);
        for (const [vtid, entry] of tabEntries) {
            const staleTag = entry.isStale ? " [STALE]" : "";
            lines.push(`Tab ${vtid}: ${entry.title} — ${entry.url}${staleTag}`);
        }
        lines.push("");
        lines.push(`Total: ${tabEntries.length} tab(s)`);
        const output = lines.join("\n");
        return dirty ? output : withTabGroupLock.skipWrite(output);
    });
}

// ---------------------------------------------------------------------------
// Tool: tabs_create_mcp
// ---------------------------------------------------------------------------

async function handleTabsCreateMcp(_args) {
    // KNOWN LOCK-HOLD HOTSPOT: this handler holds the mutex across
    // browser.tabs.create. The vtid assignment (state.nextTabId++) must be
    // atomic with the new realTabId being recorded — otherwise a concurrent
    // tabs_create_mcp could observe the same nextTabId and overwrite. The
    // trade-off is that any concurrent tabs_context_mcp / resolveTab /
    // pruneStaleGroups acquirer queues behind Safari's tab-open latency
    // (typically tens of ms; multi-second under cold start / heavy load).
    // Accepted per Spec 030; revisit if profile shows this becoming a
    // latency hotspot in real use.
    return await withTabGroupLock(async (state) => {
        let groupId = currentGroupId(state.groups);
        if (groupId === null) {
            groupId = String(state.nextGroupId++);
            state.groups[groupId] = { tabs: {} };
        }

        // Let browser.tabs.create rejections propagate with original stack
        // and error metadata. The lock's try/finally still releases.
        const newTab = await browser.tabs.create({ url: ABOUT_BLANK, active: true });

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
 *
 * Only definitive "tab gone" errors (matching TAB_GONE_PATTERN) tombstone
 * a vtid. Transient failures — extension context invalidated, native bridge
 * hiccups, focus transitions — are logged via console.warn and the vtid is
 * preserved. Treating every rejection as a tombstone would corrupt the
 * virtual group on transient errors.
 */
async function findStaleEntries(state) {
    const stale = [];
    for (const { groupId, vtid, entry } of flattenTabEntries(state.groups)) {
        if (typeof entry.realTabId !== "number") {
            console.warn(`prune: corrupt entry vtid=${vtid} in group=${groupId}`);
            stale.push({ groupId, vtid });
            continue;
        }
        const probe = await probeRealTab(entry.realTabId);
        if (probe.gone) {
            stale.push({ groupId, vtid });
        } else if (!probe.live) {
            console.warn(
                `prune: transient error probing vtid=${vtid} (realTabId=${entry.realTabId}); preserving entry:`,
                probe.err
            );
        }
    }
    return stale;
}

/**
 * Apply removals from a previously-collected stale list. Each deletion is
 * guarded by an existence check, so concurrent additions to other vtids
 * between scan and apply are preserved.
 *
 * Assumption: Safari assigns monotonically increasing tab IDs per session
 * (empirically observed). If a future Safari behavior reuses real tab IDs
 * within a session, a closed-and-replaced tab could be evicted by a stale
 * entry from a prior probe. If this invariant breaks, switch to scan→apply
 * inside a single locked region.
 *
 * Returns true if at least one entry was actually removed (caller can skip
 * writeState when nothing changed — relevant when every staleEntry was
 * already removed between probe and lock acquisition by a concurrent caller).
 */
function applyStaleRemovals(state, staleEntries) {
    let removed = false;
    for (const { groupId, vtid } of staleEntries) {
        const group = state.groups[groupId];
        if (!group) continue;
        if (group.tabs[vtid] === undefined) continue;
        delete group.tabs[vtid];
        removed = true;
        if (Object.keys(group.tabs).length === 0) {
            delete state.groups[groupId];
        }
    }
    return removed;
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
    // Read outside the lock intentionally — cheap early-out before the
    // N-probe findStaleEntries phase. A concurrent tabs_create_mcp adding
    // a group between this read and the next prune cycle is fine: those
    // groups are processed on the following 60-second tick. The fresh
    // readState() inside withTabGroupLock below is what enforces correctness.
    const snapshot = await readState();
    if (!snapshot.groups || Object.keys(snapshot.groups).length === 0) return;

    const staleEntries = await findStaleEntries(snapshot);
    if (staleEntries.length === 0) return;

    await withTabGroupLock(async (state) => {
        // Visibility on probe→lock race: if the fresh state under the lock
        // has fewer groups than the snapshot, a concurrent caller (another
        // prune, a tab close cascade, etc.) drained groups in between.
        // applyStaleRemovals will silently no-op for those entries; log so
        // missed prunes don't disappear from the trail.
        const snapshotGroupCount = Object.keys(snapshot.groups).length;
        const freshGroupCount = state.groups ? Object.keys(state.groups).length : 0;
        if (freshGroupCount < snapshotGroupCount) {
            console.warn(
                `prune: race observed — snapshot had ${snapshotGroupCount} group(s), fresh state has ${freshGroupCount}; some staleEntries may be no-ops`
            );
        }
        const removed = applyStaleRemovals(state, staleEntries);
        // Skip the write when nothing changed (avoids a spurious storage
        // write on the probe→lock race window). Otherwise fall through —
        // the implicit `undefined` return is falsy, which withTabGroupLock
        // treats as "please writeState" (see JSDoc on the falsy-triggers-write
        // contract).
        if (!removed) return withTabGroupLock.skipWrite(undefined);
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
