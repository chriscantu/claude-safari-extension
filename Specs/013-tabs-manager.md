# Spec 013 — Tabs Manager

## Overview

The Tabs Manager implements the virtual tab group concept used by all tools that specify
`tabId`. Safari does not have a native `tabGroups` API, so virtual groups are managed in
the extension background script using `browser.storage.session`.

The Tabs Manager also handles the `tabs_context_mcp` and `tabs_create_mcp` tool calls.

## Scope

- Background: `ClaudeInSafari Extension/Resources/tools/tabs-manager.js`
- Tool names: `"tabs_context_mcp"`, `"tabs_create_mcp"`
- No content script injection required.

## Core Concept

A **virtual tab group** is a set of real Safari tab IDs that belong to a single Claude session.
Each group has:
- A **group ID** (integer, assigned by the Tabs Manager, starts at 1)
- A list of **virtual tab slots** mapping virtual tab IDs to real Safari tab IDs

Virtual tab IDs are stable within the session. If a real tab is closed, the virtual slot
is marked as stale.

## Storage Schema

Stored in `browser.storage.session` under key `"__claudeTabGroups"`:

```ts
{
  nextGroupId: number;          // Next group ID to assign
  nextTabId: number;            // Next virtual tab ID to assign
  groups: {
    [groupId: number]: {
      tabs: {
        [virtualTabId: number]: {
          realTabId:   number;
          url:         string;   // Last known URL
          title:       string;   // Last known title
          isStale:     boolean;  // True if real tab was closed
        }
      }
    }
  }
}
```

## Tool: tabs_context_mcp

### Arguments

```ts
{
  createIfEmpty?: boolean;  // If true, create a new group if none exists. Default: false.
}
```

### Return Value

Returns all virtual tab IDs in the current group and their metadata:

```
=== MCP Tab Group (Group <groupId>) ===

Tab <virtualTabId>: <title> — <url>
Tab <virtualTabId>: <title> — <url> [STALE]
...

Total: <N> tab(s)
```

If no group exists and `createIfEmpty` is false:
```
No MCP tab group exists. Use tabs_create_mcp to create a new tab.
```

If no group exists and `createIfEmpty` is true: create a new group (with no tabs), then
report it as empty.

### Behavior

1. Read storage. Identify the "current" group (the most recently created group that has at
   least one non-stale tab, or the most recently created group if all are stale).
2. For each virtual tab, check if the real tab still exists (`browser.tabs.get(realTabId)`).
   If the tab doesn't exist, mark it as stale in storage.
3. Return the formatted list.

## Tool: tabs_create_mcp

### Arguments

```ts
{} // No arguments
```

### Return Value

```
Created new MCP tab (Tab <virtualTabId>) in Group <groupId>.
The new tab is ready for navigation.
```

### Behavior

1. Open a new real Safari tab (`browser.tabs.create({ url: "about:blank", active: true })`).
2. Assign the next virtual tab ID.
3. Add to the current group (or create a new group if none exists).
4. Persist to `browser.storage.session`.
5. Return confirmation with the virtual tab ID.

## Helper: resolveTab(virtualTabId)

Used by all other tools internally (not exposed as an MCP tool):

```ts
async function resolveTab(virtualTabId: number): Promise<number>
// Returns the real Safari tabId for a given virtual tabId.
// Throws Error("Tab not found: <virtualTabId>") if not found or stale.
```

If `virtualTabId` is `null` or `undefined`: return the ID of the currently active tab
(`browser.tabs.query({ active: true, currentWindow: true })[0].id`).

## Stale Tab Handling

A tab is stale when `browser.tabs.get(realTabId)` rejects. Stale tabs:
- Are displayed with `[STALE]` in `tabs_context_mcp` output.
- Cause `resolveTab` to throw.
- Are NOT automatically removed from storage (to preserve group membership history).

## Error Handling

| Condition                        | Behavior                                              |
|----------------------------------|-------------------------------------------------------|
| `resolveTab` on stale tab        | Throws `"Tab not found: <virtualTabId>"`              |
| `resolveTab` on unknown tabId    | Throws `"Tab not found: <virtualTabId>"`              |
| Storage read fails               | `isError: true`, "Storage unavailable"                |
| Tab creation fails               | `isError: true`, browser error message                |

## Test Cases

| ID  | Input                                        | Expected Output                                          |
|-----|----------------------------------------------|----------------------------------------------------------|
| T1  | `tabs_context_mcp` with no group             | "No MCP tab group exists..."                            |
| T2  | `tabs_context_mcp` with `createIfEmpty:true` | Creates group, returns empty group message              |
| T3  | `tabs_create_mcp`                            | Creates tab, returns virtual tab ID                     |
| T4  | `tabs_context_mcp` after creating 2 tabs     | Lists both tabs with their URLs                         |
| T5  | `resolveTab(null)`                           | Returns active tab's real ID                            |
| T6  | Real tab closed; `resolveTab` called         | Throws "Tab not found"                                  |
| T7  | Real tab closed; `tabs_context_mcp` called   | Shows tab as `[STALE]`                                  |
| T8  | Two sequential `tabs_create_mcp` calls       | Different virtual tab IDs assigned                      |
