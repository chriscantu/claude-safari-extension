# Claude in Safari — Project Context

## What This Is
A macOS Safari Web Extension that replicates the "Claude in Chrome" browser automation extension. It allows Claude Code CLI to control Safari via MCP (Model Context Protocol).

## Architecture
- **Native Swift App** (`ClaudeInSafari/`): MCP socket server, screenshot capture, window management, file I/O
- **Safari Web Extension** (`ClaudeInSafari Extension/`): Background script, content scripts, tool handlers
- Communication: CLI → Unix domain socket → Native App → `browser.runtime.sendNativeMessage()` → Extension → Content Scripts → Web Page

## Shell Environment
- User runs **fish shell** — all terminal commands must be fish-compatible
- No bash heredocs (`<<'EOF'`): write multiline git commit messages to a temp file instead
  ```fish
  echo "subject line

  Body paragraph.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git commit -F /tmp/commitmsg
  ```
- No `$(...)` command substitution: use `(...)` in fish
- `&&` chaining works in fish 3.0+; `;` is fine for unconditional sequencing

## Rules
- Always read PRINCIPLES.md before implementing any feature
- Always check STRUCTURE.md before creating or moving files
- Feature workflow: Spec → Test → Implement → Verify structure
- Run `xcodebuild test` after every change to verify tests pass

## Key Technical Decisions
- **MV2 manifest** (not MV3) for persistent background page reliability on macOS Safari
- **ScreenCaptureKit** for screenshots (Safari's `captureVisibleTab` is unreliable)
- **AppleScript** for window management (Safari's `browser.windows` API is limited)
- **Virtual tab groups** via `browser.storage.session` (no `browser.tabGroups` API in Safari)
- **GCD-based Unix domain socket** for MCP server (NWListener doesn't support UDS)
- **4-byte big-endian length-prefix** framing to match Chrome's native messaging host protocol

## Socket Path Convention
`/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock` — must match Claude Code CLI expectations

## Chrome Extension Reference
Source at: `~/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.59_0/`
- `assets/mcpPermissions-DCuIPzw1.js` — all tool definitions
- `assets/accessibility-tree.js-D8KNCIWO.js` — accessibility tree generator (port verbatim)
- `assets/service-worker.ts-B8kO2DT6.js` — service worker message routing
