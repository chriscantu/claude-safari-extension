# Spec 004 — Tool Registry

## Overview

The Tool Registry is a JavaScript module that maps tool names to handler functions.
It runs in the background script and dispatches incoming tool requests from the native app
to the appropriate JavaScript handler.

## Scope

- File: `ClaudeInSafari Extension/Resources/tools/tool-registry.js`
- Runtime: Background script (service worker context; no DOM access)

## Interface

```js
// Register a handler for a named tool
registerTool(name: string, handler: ToolHandler): void

// Execute a registered tool; throws ToolNotFoundError if unregistered
executeTool(toolName: string, args: object, context: ToolContext): Promise<ToolResult>
```

### Types

```js
/**
 * @typedef {object} ToolContext
 * @property {number|null} tabId     - Active MCP tab ID (virtual tab group), or null if none
 * @property {string}      requestId - Unique ID for the MCP request
 */

/**
 * @typedef {object} ToolResult
 * @property {{ type: string, text: string }[]} content - Array of content blocks
 * @property {boolean} [isError]                         - True if the tool failed
 */

/**
 * @callback ToolHandler
 * @param {object}      args    - Tool arguments (tool-specific schema)
 * @param {ToolContext} context - Request context
 * @returns {Promise<ToolResult>}
 */
```

## Behavior

### registerTool(name, handler)

- Stores `handler` under `name` in an internal registry map.
- Overwrites any previously registered handler for the same name (last-write wins).
- Throws `TypeError` if `name` is not a non-empty string.
- Throws `TypeError` if `handler` is not a function.

### executeTool(toolName, args, context)

1. Looks up `toolName` in the registry.
2. If not found, returns a `ToolResult` with `isError: true` and text `"Unknown tool: <toolName>"`.
3. If found, calls `handler(args, context)`.
4. If the handler throws or rejects, catches the error and returns a `ToolResult` with
   `isError: true` and text `"Tool '<toolName>' failed: <error.message>"`.
5. Returns the handler's resolved `ToolResult` on success.

**Note:** `executeTool` MUST NOT throw; all errors are returned as `ToolResult` with `isError: true`.

## Registration Pattern

Tools are registered by individual tool files at load time:

```js
// In read-page.js:
registerTool("read_page", readPageHandler);
```

The tool registry module is loaded first; tool files are loaded after it.

## Error Handling

| Condition                  | Behavior                                              |
|---------------------------|-------------------------------------------------------|
| Unknown tool name         | Return `ToolResult` with `isError: true`              |
| Handler throws sync error | Catch, return `ToolResult` with `isError: true`       |
| Handler rejects async     | Catch, return `ToolResult` with `isError: true`       |
| `name` not a string       | Throw `TypeError` from `registerTool`                 |
| `handler` not a function  | Throw `TypeError` from `registerTool`                 |

## Test Cases

| ID  | Input                                          | Expected Output                                      |
|-----|------------------------------------------------|------------------------------------------------------|
| T1  | `registerTool("foo", fn)` + `executeTool("foo", {}, ctx)` | Calls `fn`; returns its result          |
| T2  | `executeTool("unknown", {}, ctx)`              | `{ isError: true, content: [{ type: "text", text: "Unknown tool: unknown" }] }` |
| T3  | Handler throws `new Error("boom")`             | `{ isError: true, content: [{ type: "text", text: "Tool 'x' failed: boom" }] }` |
| T4  | Handler returns `Promise.reject(new Error("async"))` | Same as T3 but async error text              |
| T5  | `registerTool(42, fn)`                         | Throws `TypeError`                                   |
| T6  | `registerTool("foo", "not a function")`        | Throws `TypeError`                                   |
| T7  | Register same name twice; call it              | Second handler is called                             |
| T8  | `executeTool` never throws to caller           | All errors wrapped in `ToolResult`                   |
