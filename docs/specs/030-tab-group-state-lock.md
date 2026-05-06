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

All four mutation sites (`handleTabsContextMcp`, `handleTabsCreateMcp`, `resolveTab`'s stale-mark path, `pruneStaleGroups`) route through the helper. The two-phase manual mitigation in `pruneStaleGroups` is removed — the lock provides the same guarantee uniformly.

## Tests

- T_concurrent: two `tabs_create_mcp` calls launched via `Promise.all` produce two distinct virtual tabs and two distinct real tabs in one group. Without the lock, the `nextTabId++` race produces only one tab. (`Tests/JS/tabs-manager.test.js`)
- All existing T1–T9 and T_prune1–T_prune4 cases continue to pass without behavioral change.

## Origin

Surfaced by the `/improve-codebase-architecture` audit on 2026-05-06. Tracked in [issue #61](https://github.com/chriscantu/claude-safari-extension/issues/61).
