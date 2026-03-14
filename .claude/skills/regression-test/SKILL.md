---
name: regression-test
description: Use when running the manual regression test suite before merging a PR — covers setup, which sections to always run, known pre-existing failures to skip, and the PR checklist.
---

# Manual Regression Test Suite

Full test suite: `docs/regression-tests.md`. This skill covers what to run, what to skip, and how to confirm pass/fail.

---

## 1. Prerequisites

```fish
make dev                            # build, launch, create dev.sock symlink
npm test && make test-swift         # automated tests must pass first
```

**Safari manual checks** (cannot be automated):
- Safari → Develop → Allow Unsigned Extensions ✓
- Safari → Settings → Extensions → Claude in Safari ✓ (enabled)
- Extension visible in Develop → Web Extension Background Pages

---

## 2. Always Run (Sections 1–6)

These are fast and cover core infrastructure. Run for every PR:

| Section | What it covers |
|---|---|
| 1 | Automated test suite |
| 2 | Infrastructure (socket, tool registration) |
| 3 | Screenshot |
| 4 | Navigation |
| 5 | Page reading |
| 6 | Page interaction |

---

## 3. Known Pre-existing Failures (Do Not Block PRs)

| Tool / Section | Symptom | Root cause |
|---|---|---|
| Section 7 (`javascript_tool`) | "executeScript returned no result" | Safari MV2 doesn't await Promise return values from injected scripts — always null |
| `computer` with `read_page` refs | "Element 'ref_N' not found" | `accessibility-tree.js` uses in-memory WeakRef map; `computer.js` needs `data-claude-ref` DOM attrs (set only by `find.js`). Must use `find` before `computer(ref)`. |
| `file_upload` on `file://` pages | "No result from injected script" | Safari restricts `executeScript` on `file://` pages. Use HTTP: `python3 -m http.server 8765 --directory /tmp` |

These are pre-existing bugs not introduced by the PR under test. Document them in the PR description but do not block merge.

---

## 4. PR-Specific Sections

Always run the section(s) for the feature being PR'd:

- Section 7: `javascript_tool`
- Section 8: `computer` + `find`
- Section 9–12: tool-specific sections
- **Section 13** (cross-tool E2E): run if the PR touches any tool that interacts with navigation, find, or computer

---

## 5. PR Checklist

At the end of `docs/regression-tests.md` there is a PR checklist. Copy it into the PR description before requesting review.

---

## send Command Reference

```fish
make send TOOL=<tool_name> ARGS='{"key": "value"}'
```

`make send` activates Safari automatically before each call. Use this, not `mcp-test.py` directly.
