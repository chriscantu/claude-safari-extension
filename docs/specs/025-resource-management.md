# Spec 025 — Resource Management

## Goal
Add lifecycle-aware cleanup to four resource types that currently accumulate without bounds: virtual tab groups, poll intervals, in-memory screenshots, and orphaned response files.

## Motivation
Specs 023 and 024 hardened crash resilience and tool execution guards. The remaining gap is resource accumulation during long-running sessions. Tab groups grow in `browser.storage.session` indefinitely, the poll loop uses a binary 100ms/5000ms switch with no gradual backoff, screenshots persist in memory for the app's entire lifetime (even when stale), and response files leak on client disconnect.

## Priority Labels
- **H** = High priority (causes unbounded resource growth)
- **M** = Medium priority (bounded but improvable)

## Scope

### 1. Tab Group Pruning (H)
**Where:** `tabs-manager.js` + `background.js`

Add a `pruneStaleGroups()` function to `tabs-manager.js`:
1. Load tab groups from `browser.storage.session`
2. For each tab entry, call `browser.tabs.get(realTabId)` — if it throws, the tab is closed; remove the entry
3. If a group has zero remaining tabs, delete the entire group
4. Write cleaned state back to session storage

Export via `globalThis.pruneStaleGroups`.

In `background.js`, call `pruneStaleGroups()` on a 60-second interval using a timestamp: track `lastPruneTime = Date.now()` and on each poll cycle check `Date.now() - lastPruneTime >= 60000`. This is timestamp-based (not tick-based) so it works correctly regardless of the variable poll interval from §2. Measure from last prune initiation. Skip if `idleStreak === 0` (tool execution in progress) or if a prune is already in flight (`isPruning` guard flag).

### 2. Poll Backoff (H)
**Where:** `background.js`

Replace the binary `isActive` toggle with exponential backoff during idle:

- Active (request received): 100ms (unchanged)
- Idle ramp: 100ms → 200ms → 400ms → 800ms → 1600ms → 3200ms → 5000ms (cap)

Implementation:
- Track `idleStreak` counter (number of consecutive empty poll responses)
- Compute interval: `Math.min(POLL_INTERVAL_MS * Math.pow(2, idleStreak), POLL_IDLE_INTERVAL_MS)`
- On any request received: reset `idleStreak = 0`
- Retain `isActive` as a semantic flag for "currently executing a tool" (set true when a request is received, set false when the tool response is sent or an error occurs). `idleStreak` tracks poll-level idle; `isActive` tracks tool-level busy. These are independent: `isActive` can be false while `idleStreak` is 0 (just finished a tool, next poll hasn't happened yet).

### 3. Image TTL (M)
**Where:** `ScreenshotService.swift`

Add a `DispatchSourceTimer` that fires every 60 seconds on a background queue:
1. Iterate `imageStore`; remove entries where `Date().timeIntervalSince(image.timestamp) > imageExpirationSeconds`
2. Also remove corresponding entries from `imageOrder`
3. Timer created in `init()`, cancelled in `deinit`

Constants:
- `imageExpirationSeconds: TimeInterval = 300` (5 minutes)
- `cleanupIntervalSeconds: TimeInterval = 60`

Thread safety: `ScreenshotService` uses `NSLock` to protect `imageStore`/`imageOrder`. The timer callback must acquire the same lock (`lock.lock()` / `lock.unlock()`) — the same pattern used by `store()` and `retrieveImage()`. Do not introduce a separate serial queue.

### 4. Orphan Response File Cleanup on Disconnect (M)
**Where:** `ToolRouter.swift`, `socketServer(_:didDisconnect:)` handler

Extend the existing client disconnect handler to delete response files for each pending request belonging to the disconnecting client.

Lock ordering: the current disconnect handler holds `pendingRequestsLock` while collecting request IDs to cancel, then removes entries. To add file deletion safely:
1. Under `pendingRequestsLock`: collect the list of `requestId`s belonging to the disconnecting client, then remove them from `pendingRequests` and `pendingToolContext`.
2. After releasing `pendingRequestsLock`: iterate the collected IDs and delete each response file at `AppConstants.responseFileURL(for: requestId)`. File I/O must happen outside the lock to avoid holding it during disk access.

Do NOT call `failPendingRequest()` from inside the lock — it acquires `pendingRequestsLock` internally and would deadlock.

This prevents orphaned response files from accumulating during a session when clients disconnect while tool responses are in flight. (Startup cleanup already handles the cross-restart case.)

## Files Modified
- `ClaudeInSafari Extension/Resources/tools/tabs-manager.js` — `pruneStaleGroups()` function
- `ClaudeInSafari Extension/Resources/background.js` — prune timer, poll backoff (`idleStreak`)
- `ClaudeInSafari/Services/ScreenshotService.swift` — TTL timer, expiration sweep
- `ClaudeInSafari/MCP/ToolRouter.swift` — response file cleanup in disconnect handler
- `Tests/JS/tabs-manager.test.js` — tests for pruneStaleGroups
- `Tests/JS/background.test.js` — tests for poll backoff
- `Tests/Swift/ScreenshotServiceTests.swift` — tests for image TTL
- `Tests/Swift/ToolRouterTests.swift` — tests for disconnect cleanup

## Out of Scope
- Centralized ResourceManager abstraction — premature for four independent cleanup sites
- GIF frame TTL — frames are already hard-capped at 50 per tab and cleared on recording stop
- Console/network buffer TTL — already bounded by ring-buffer eviction (1000/500 entries)
- Tab guards for remaining executeScript-based tools — separate PR
