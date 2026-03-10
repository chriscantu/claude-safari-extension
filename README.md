# Claude in Safari

A macOS Safari Web Extension that brings the [Claude in Chrome](https://claude.ai) browser automation features to Safari. It lets Claude Code CLI control Safari via the Model Context Protocol (MCP) — reading pages, clicking elements, filling forms, taking screenshots, and more.

## How It Works

```
Claude Code CLI
    ↕  Unix domain socket  (newline-delimited JSON)
    ↕  /tmp/claude-mcp-browser-bridge-<username>/<pid>.sock
Native Swift App  (MCP server · screenshots · window management · file I/O)
    ↕  browser.runtime.sendNativeMessage()
Safari Web Extension  (background script · content scripts · tool handlers)
    ↕  browser.scripting.executeScript
Web Pages
```

The native app exposes the same socket path and protocol as the Chrome extension's native messaging host, so Claude Code works with it out of the box.

## Requirements

- macOS 13 Ventura or later
- Safari 16.4 or later
- Xcode 16 or later (to build)

## Building

```sh
# Clone the repo
git clone https://github.com/chriscantu/claude-safari-extension.git
cd claude-safari-extension

# Open in Xcode
open ClaudeInSafari.xcodeproj

# Or build from the command line
xcodebuild build \
  -project ClaudeInSafari.xcodeproj \
  -scheme ClaudeInSafari \
  -destination "platform=macOS"
```

## Running Tests

```sh
xcodebuild test \
  -project ClaudeInSafari.xcodeproj \
  -scheme ClaudeInSafariTests \
  -destination "platform=macOS"
```

## Installing the Extension

1. Build and run the app (`ClaudeInSafari.app`).
2. Open Safari → **Settings → Extensions**.
3. Enable **Claude in Safari**.
4. Grant the requested permissions (all URLs, optional Screen Recording for screenshots).

The native app starts the MCP socket server automatically on launch.

## Project Layout

See [STRUCTURE.md](STRUCTURE.md) for the full canonical directory layout.

```
ClaudeInSafari/            # macOS app — MCP server, screenshots, AppleScript
ClaudeInSafari Extension/  # Safari Web Extension — tool handlers, content scripts
Shared/                    # Constants shared between both targets
Specs/                     # Feature specifications (written before code)
Tests/                     # Swift unit tests
```

## Development Workflow

This project follows the principles in [PRINCIPLES.md](PRINCIPLES.md):

1. **Spec first** — write a spec in `Specs/` before any implementation.
2. **Test first** — write a passing test before marking a feature complete.
3. **Iterative commits** — commit each small batch of working code.
4. **Structure compliance** — all files must be placed per `STRUCTURE.md`.

### Adding a New Tool

1. Write a spec: `Specs/<NNN>-<tool-name>.md`
2. Write tests: `Tests/` (Swift) or `Tests/js/` (JavaScript)
3. Implement in the matching file from `STRUCTURE.md`
4. Register the tool in `tool-registry.js`
5. Run tests, commit

## Features

| Tool | Status |
|------|--------|
| MCP socket server + message framing | ✅ Done |
| Native ↔ extension bridge | ✅ Done |
| Tool registry + tabs manager | ✅ Done |
| `read_page` — accessibility tree snapshot | ✅ Done |
| `navigate` — URL navigation & history traversal | ✅ Done |
| `find` — find elements by natural language | ✅ Done |
| `form_input` — fill inputs, checkboxes, selects | ✅ Done |
| `get_page_text` — extract article/main text | ✅ Done |
| `javascript_tool` — run JS in page context | 🔲 Planned |
| `read_console_messages` — captured console logs | 🔲 Planned (content script scaffolded) |
| `read_network_requests` — captured network log | 🔲 Planned (content script scaffolded) |
| `computer` — mouse, keyboard, scroll | 🔲 Planned |
| `computer` (screenshot) — ScreenCaptureKit | 🔲 Planned |
| `resize_window` — AppleScript window management | 🔲 Planned |
| `tabs_context_mcp` / `tabs_create_mcp` | ✅ Done |
| `gif_creator` | 🔲 Planned |
| `file_upload` / `upload_image` | 🔲 Planned |

## License

MIT
