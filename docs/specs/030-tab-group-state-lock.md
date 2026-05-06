# Spec 030: Transactional Lock for Tab-Group State

## Problem

Tab-group state in `browser.storage.session` (`__claudeTabGroups`) is mutated via read-modify-write across multiple call sites in `tabs-manager.js`:

- `handleTabsContextMcp` (creates an empty group when `createIfEmpty:true`, refreshes staleness)
- `handleTabsCreateMcp` (creates a group + virtual tab, increments `nextGroupId` / `nextTabId`)
- `resolveTab` (marks a stale tab in place)
- `pruneStaleGroups` (removes dead tabs / empty groups)

JS is single-threaded but every `await` yields to the event loop. Concurrent tool invocations (or the periodic prune job racing a tool call) can interleave:

1. Caller A: `readState()` → snapshot S0
2. Caller B: `readState()` → snapshot S0
3. Caller A: mutate S0a, `writeState(S0a)`
4. Caller B: mutate S0b, `writeState(S0b)` — **A's update lost**

Only `pruneStaleGroups` previously used a manual two-phase compute-then-reapply pattern to mitigate the race. Every other site was exposed.

## Goals

1. Eliminate the lost-update race class on `__claudeTabGroups`
2. Centralize concurrency control in one helper instead of duplicating the two-phase pattern across every site
3. Keep the mutation logic at each call site readable — no inversion of control beyond a single callback boundary

## Non-Goals

- Cross-process synchronization (only one extension JS context exists at a time)
- Locking other `browser.storage.session` keys (e.g., `computer-wait-alarmName` in `computer.js`) — those are owned by a single tool and have no read-modify-write pattern
- **Lock cancellation / timeout.** `withTabGroupLock` has no timeout or cancel hook. If the callback's awaited work hangs indefinitely (e.g., `browser.tabs.create` never resolves because Safari is unresponsive), the lock chain stalls until the runtime tears down the extension context. This matches the rest of the codebase's approach to native-bridge calls (one-shot, no per-call timeout — see `tool-registry.js`). Adding a cancellation path would require a deadline-aware wrapper around every awaited browser API call inside critical sections; out of scope for this PR. Revisit if hangs are observed in practice.

## Design

A module-level promise chain serializes critical sections:

```js
let lockChain = Promise.resolve();

async function withTabGroupLock(fn) {
    const prior = lockChain;
    let release;
    lockChain = new Promise((r) => { release = r; });
    try {
        await prior;
        const state = await readState();
        const out = await fn(state);
        if (out && out.__skipWrite === SKIP_WRITE_MARK) return out.value;
        await writeState(state);
        return out;
    } finally {
        release();
    }
}
withTabGroupLock.skipWrite = (value) => ({ __skipWrite: SKIP_WRITE_MARK, value });
```

Contract:

- The callback receives a fresh snapshot and may mutate it in place. On return, the (possibly mutated) state is persisted.
- To skip the write (read-only path or explicit "do not commit"), return `withTabGroupLock.skipWrite(returnValue)`.
- Throwing from inside the callback releases the lock (via `finally`) and propagates the error; partial mutations are NOT persisted.

All four mutation sites (`handleTabsContextMcp`, `handleTabsCreateMcp`, `resolveTab`'s stale-mark path, `pruneStaleGroups`) route through the helper.

`pruneStaleGroups` and `handleTabsContextMcp` each use a three-phase shape so the lock is never held across N sequential `browser.tabs.get` round-trips:

- **Phase 1 (under lock):** read state, decide groupId / mutations that don't depend on liveness, snapshot `(vtid, realTabId)` pairs to probe.
- **Phase 2 (no lock):** call `probeRealTab(realTabId)` for each pair. Concurrent tool calls can acquire the lock during this phase.
- **Phase 3 (under lock):** re-read fresh state, apply the per-vtid result (delete or update `isStale`) only if the entry still exists.

`handleTabsCreateMcp` holds the lock through `browser.tabs.create` because the `nextTabId++` increment must be atomic with the new `realTabId` being recorded — otherwise two concurrent calls would observe the same `nextTabId` and one record would overwrite the other. The cost: concurrent `tabs_context_mcp` / `resolveTab` / `pruneStaleGroups` acquirers queue behind Safari's tab-open latency (typically tens of milliseconds; multi-second under cold start or heavy load). This trade-off is accepted; revisit if profile data shows tab-create stalls becoming a real latency hotspot.

`resolveTab` holds the lock through one `browser.tabs.get` call (via `probeRealTab`). Unlike `handleTabsContextMcp` and `pruneStaleGroups`, which release the lock during their probe phases, `resolveTab` uses a single locked region so the entry lookup, probe result, and optional staleness write are all atomic — a concurrent `pruneStaleGroups` must not see a stale entry as live between our find and our write. The cost: every other lock acquirer queues behind one `browser.tabs.get` round-trip on every `resolveTab` call. Accepted because (a) it is exactly one IPC call per invocation, not N sequential, and (b) splitting into three phases would require two lock acquisitions per `resolveTab`, adding latency to the success path which is the hot path (every tab-consuming tool — navigate, click, type, screenshot — goes through this function). The inline LOCK-HOLD NOTE in `tabs-manager.js::resolveTab` mirrors this rationale at the call site.

`resolveTab` keeps a single locked region but uses `probeRealTab` so a transient probe error releases the lock without writing.

### Transient-error policy

`browser.tabs.get` can reject for reasons other than "tab closed" — extension context invalidated, native bridge dropped a message, focus transition. Treating every rejection as a tombstone would corrupt the virtual group on transient errors.

All probe sites (`findStaleEntries`, `resolveTab`, `handleTabsContextMcp`'s phase-2 loop) call the shared `probeRealTab(realTabId)` helper, which classifies the result as `live` / `gone` / `transient`. Only `gone` (rejection message matches `TAB_GONE_PATTERN` — `/no tab with id|invalid tab/i`) tombstones an entry. `transient` results are logged via `console.warn` and the entry is preserved; the next probe re-applies the policy.

`TAB_GONE_PATTERN` is defined once in `tool-registry.js` and exposed via `globalThis.TAB_GONE_PATTERN` so the same shape is used by both `classifyExecuteScriptError` (synthesizing the user-visible error message) and the probe sites in `tabs-manager.js` (deciding whether to tombstone). Manifest load order (`tool-registry.js` before `tabs-manager.js`) guarantees the global is populated before consumers read it.

In `resolveTab`, a transient probe surfaces the original error to the caller (wrapped as `"resolveTab: vtid=N unreachable (transient): ..."`) instead of `"Tab not found"`, so callers can distinguish a closed tab from a temporarily unreachable one.

### Tab-ID reuse assumption

`applyStaleRemovals` deletes the tombstoned vtid unconditionally (after an existence guard). This is safe under Safari's empirical behavior of monotonically increasing per-session tab IDs. If a future Safari behavior reuses real tab IDs within a session, scan→apply must run inside a single locked region.

The same monotonic assumption underpins `handleTabsContextMcp`'s phase-3 update policy: only flip entries TO `isStale: true`, never back to `false`. A phase-2 `live` probe result must NOT clear a stale mark set by a concurrent `resolveTab` between phases — under monotonic IDs, a closed tab does not become live again. This also lets phase 3 take the `skipWrite` path when no flag flipped (the hot-path all-live case), avoiding storage churn on every `tabs_context_mcp` call.

## Tests

- `T_concurrent` — two parallel `tabs_create_mcp` calls produce two distinct virtual tabs and two distinct real tabs in one group. Without the lock, `nextTabId++` races and one tab is lost.
- `T_lock_release_on_throw` — first call throws via failing `browser.tabs.create`; lock releases, partial state not persisted, second call succeeds.
- `T_prune_race_window` — `pruneStaleGroups` and `tabs_create_mcp` run concurrently; new vtid added during prune is preserved, stale vtid is removed, live vtid is preserved.
- `T_findStaleEntries_transient` — non-`TAB_GONE_PATTERN` error preserves the entry instead of evicting it.
- `T_lock_fifo` — three serial `tabs_create_mcp` calls with decreasing mock delays still produce vtids `1, 2, 3` in dispatch order.
- `T_resolveTab_no_write_on_success` — successful resolution exercises the `skipWrite` path; zero `browser.storage.session.set` calls observed.
- `T_resolveTab_persists_stale` — definitive tab-gone rejection causes `isStale: true` to be persisted via the non-`skipWrite` return path.
- `T_resolveTab_transient` — non-`TAB_GONE_PATTERN` rejection through `resolveTab` does NOT flip `isStale`, does NOT write storage, and surfaces the underlying error message to the caller.
- `T_prune_ghost_group` — `applyStaleRemovals` tolerates a group disappearing between phase-1 snapshot and phase-3 lock acquisition (the `if (!group) continue` guard).
- `T_prune_corrupt` — `findStaleEntries` flags entries with non-numeric `realTabId` for removal so corrupt records don't accumulate.
- `T_context_resolveTab_race` — phase-2 of `tabs_context_mcp` records `live`; concurrent `resolveTab` lands a stale mark between phases; phase 3 must NOT revert it back to `live`.
- `T_context_no_write_when_clean` — `tabs_context_mcp` against an all-live group performs zero `storage.session.set` calls (skipWrite hot path).
- `T_prune_no_write_when_already_removed` — `applyStaleRemovals` no-op (every staleEntry already removed by a concurrent caller) takes the `skipWrite` path; no storage churn on the race window.
- `T_currentGroupId_all_stale_fallback` — when every group is all-stale, the highest-ID group is selected as last resort.
- All existing T1–T9 and T_prune1–T_prune4 cases continue to pass without behavioral change.

### Sharp edges for future contributors

- **Falsy callback returns trigger writeState.** The `withTabGroupLock` skipWrite check is `out && out.__skipWrite === SKIP_WRITE_MARK`. Returning any falsy value (`undefined`, `null`, `false`, `0`, `""`) bypasses the check and falls through to `writeState`. This is intentional and exploited by `pruneStaleGroups` (`return removed ? undefined : withTabGroupLock.skipWrite(undefined)`) — `undefined` means "I mutated, please write." The trap: a future read-only callback that forgets to wrap its return value with `withTabGroupLock.skipWrite(...)` will silently produce a spurious storage write on the hot path. Always wrap the return when no mutation occurred. The contract is restated in the function's JSDoc.

### Coverage gaps (intentional)

- **Slow-create latency.** `T_concurrent` and `T_lock_fifo` mock `browser.tabs.create` with `setTimeout(0)` (resolves on next microtask). A multi-second `tabs.create` would queue every other lock acquirer for that duration — accepted per Spec 030 §Design and `handleTabsCreateMcp`'s inline comment. No automated test exercises this latency profile; observable behavior surfaces only in live Safari under cold-start / heavy-load conditions and is captured by manual regression §14.3.
- **Hung-callback recovery.** No test simulates a `browser.tabs.create` (or any in-callback await) that never resolves. The lock chain has no timeout — see Non-Goals above.

## Origin

Surfaced by the `/improve-codebase-architecture` audit on 2026-05-06. Tracked in [issue #61](https://github.com/chriscantu/claude-safari-extension/issues/61).
