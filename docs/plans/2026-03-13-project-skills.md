# Project Skills Implementation Plan

## Goal

Add two project-level Claude Code skills to `.claude/skills/` so that Claude can reliably follow the correct workflow when implementing new MCP tools and running regression tests on this project.

## Why Skills Instead of CLAUDE.md

`CLAUDE.md` is always loaded and covers rules that should inform every response. Skills are loaded on-demand when a specific workflow is triggered. The workflows below are complex enough to warrant a dedicated skill that Claude is directed to explicitly at the right moment — rather than hoping the relevant CLAUDE.md section is weighted correctly mid-session.

## Skills to Create

---

### 1. `new-tool` — Implementing a New MCP Tool

**Trigger description (for skill frontmatter):**
> Use when adding a new MCP tool to Claude in Safari — from spec through implementation, tests, and PR. Covers the full workflow: spec check, branch creation, TDD, manifest/load-order updates, STRUCTURE.md compliance, and regression test additions.

**What it should cover:**

1. **Pre-work checklist**
   - Read the spec (`Specs/NNN-tool-name.md`) before touching any code
   - Create a feature branch: `git checkout -b feature/<tool-name>`
   - Confirm the tool file location: `ClaudeInSafari Extension/Resources/tools/<tool-name>.js`

2. **File creation checklist** (per STRUCTURE.md)
   - `tools/<tool-name>.js` — one tool per file, kebab-case
   - `Tests/JS/<tool-name>.test.js` — JS tests
   - Swift tests updated if ToolRouter changes

3. **Manifest + load-order** (most commonly missed step)
   - Add to `manifest.json` `background.scripts` array
   - Add matching entry to load-order comment in `background.js`
   - Both must stay in sync (code review checklist item)

4. **TDD flow**
   - Write failing test first
   - Implement minimal handler
   - `npm test` must pass before moving on
   - Run `make test-swift` if Swift files changed

5. **Registration pattern**
   - `globalThis.registerTool("tool_name", handler)` at bottom of file
   - Tab resolution: `globalThis.resolveTab(virtualTabId)`
   - Error classification: `globalThis.classifyExecuteScriptError`

6. **Regression test additions**
   - Add fast-fail cases and E2E cases to `docs/regression-tests.md`

7. **PR checklist** (CLAUDE.md Code Review Checklist)
   - Event listener lifecycle
   - STRUCTURE.md compliance
   - DRY / SOLID

---

### 2. `regression-test` — Running the Manual Regression Suite

**Trigger description (for skill frontmatter):**
> Use when running the manual regression test suite before merging a PR — covers the required setup, which sections to always run, known pre-existing failures to skip, and the PR checklist summary.

**What it should cover:**

1. **Prerequisites**
   - `make dev` — build, launch, health check
   - `npm test && make test-swift` — automated tests must pass first
   - Safari: Allow Unsigned Extensions ✓, extension enabled ✓

2. **Always run** (core, fast)
   - Sections 1–6: automated tests, infrastructure, screenshot, navigation, page reading, page interaction

3. **Known pre-existing failures** (do not block PRs on these)
   - Section 7 (`javascript_tool`): returns "executeScript returned no result" — Safari doesn't await Promises from `browser.tabs.executeScript`
   - `computer` with `read_page` refs: only `find` refs work (different DOM attribute system)
   - `file_upload` on `file://` pages: use HTTP (`python3 -m http.server 8765 --directory /tmp`)

4. **PR-specific sections**
   - Always run the section for the feature being PR'd
   - Run cross-tool E2E (Section 13) for any tool that interacts with others

5. **PR checklist summary** (from end of regression-tests.md)
   - Copy checklist into PR description

---

## Implementation Order

1. `new-tool` first — immediately useful for the next tool implementation session
2. `regression-test` second — useful before every merge

## File Locations

```
.claude/skills/
  new-tool/
    SKILL.md
  regression-test/
    SKILL.md
```

Both committed to git alongside the existing `safari-ext-debug` skill.

## Notes

- Keep each skill under 150 lines — link to `docs/regression-tests.md` and relevant Specs rather than duplicating content
- Skill descriptions must start with "Use when..." and describe triggering conditions only (not the workflow summary)
