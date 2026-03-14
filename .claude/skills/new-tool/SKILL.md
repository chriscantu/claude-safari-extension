---
name: new-tool
description: Use when adding a new MCP tool to Claude in Safari — covers the full workflow from spec through implementation, tests, manifest updates, and PR creation.
---

# New Tool Implementation

Follow every step in order. Do not skip pre-work or manifest steps — both are commonly missed.

---

## 1. Pre-work

```fish
git checkout -b feature/<tool-name>
```

- Read `Specs/NNN-<tool-name>.md` before touching any code
- Confirm tool file location: `ClaudeInSafari Extension/Resources/tools/<tool-name>.js`

---

## 2. File Creation (per STRUCTURE.md)

| What | Where |
|---|---|
| Tool handler | `ClaudeInSafari Extension/Resources/tools/<tool-name>.js` |
| JS tests | `Tests/JS/<tool-name>.test.js` |
| Swift tests | Update `Tests/` if ToolRouter changes |

One tool per file. Kebab-case filenames. No shared utility files unless used by 2+ tools.

---

## 3. Manifest + Load Order (most commonly missed)

Two places must stay in sync — both must be updated together:

1. `manifest.json` → `background.scripts` array: add `"tools/<tool-name>.js"`
2. `background.js` → load-order comment at top: add matching entry

**Code review checklist item**: verify both are present before requesting review.

---

## 4. TDD Flow

```fish
npm test   # must be green before moving on
```

1. Write failing test first
2. Implement minimal handler
3. `npm test` passes
4. `make test-swift` if any Swift files changed

---

## 5. Registration Pattern

```js
// Bottom of tool file
globalThis.registerTool("tool_name", async (args) => {
  const tab = await globalThis.resolveTab(args.virtual_tab_id);
  // ...
});
```

- Tab resolution: `globalThis.resolveTab(virtualTabId)` — never re-implement
- Error classification: `globalThis.classifyExecuteScriptError` for executeScript errors
- executeScript tools: use `executeScriptWithTabGuard` from tool-registry.js
- Safari must be frontmost for all executeScript-based tools

---

## 6. Regression Test Additions

Add to `docs/regression-tests.md`:
- Fast-fail cases (verify error handling / input validation)
- E2E cases (live Safari, happy path + at least one error path)
- If the tool interacts with others, add a cross-tool case to Section 13

---

## 7. PR Checklist (CLAUDE.md Code Review Checklist)

Before opening PR, verify:

- [ ] Event listener lifecycle: listeners cleaned up on ALL exit paths (resolve, reject, timeout)
- [ ] Cancellable promises: `.cancel()` method if the promise owns listeners or timers
- [ ] `onRemoved` listener: navigation settlement rejects immediately on tab close
- [ ] Manifest + load-order in sync
- [ ] STRUCTURE.md compliance (one file per tool, correct paths)
- [ ] `resolveTab` and `registerTool` used — not re-implemented
- [ ] `npm test` and `make test-swift` pass
- [ ] Regression test entries added
