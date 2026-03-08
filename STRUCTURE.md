# Project Structure

This document defines the canonical layout for the Claude in Safari project. All code MUST be organized according to this guide (see PRINCIPLES.md rule 4).

```
claude-safari-extension/
├── PRINCIPLES.md                            # Project rules (immutable without user approval)
├── STRUCTURE.md                             # This file — canonical project layout
├── CLAUDE.md                                # Claude Code conventions and context
│
├── ClaudeInSafari/                          # Xcode project root
│   ├── ClaudeInSafari.xcodeproj
│   │
│   ├── ClaudeInSafari/                      # macOS App Target
│   │   ├── App/
│   │   │   └── AppDelegate.swift            # App lifecycle, menu bar status item, setup wizard
│   │   ├── MCP/
│   │   │   ├── MCPSocketServer.swift        # Unix domain socket server (GCD-based)
│   │   │   ├── MessageFramer.swift          # 4-byte big-endian length-prefix framing
│   │   │   └── ToolRouter.swift             # Routes tool requests: native-handled vs extension-handled
│   │   ├── Services/
│   │   │   ├── ScreenshotService.swift      # ScreenCaptureKit-based screenshot capture
│   │   │   ├── AppleScriptBridge.swift      # Safari window resize/management via AppleScript
│   │   │   └── FileService.swift            # Read local files for file_upload tool
│   │   ├── Models/
│   │   │   ├── MCPMessage.swift             # MCP JSON-RPC message types (Codable structs)
│   │   │   └── ToolModels.swift             # Tool request/response models
│   │   └── Info.plist
│   │
│   ├── ClaudeInSafari Extension/            # Safari Web Extension Target
│   │   ├── SafariWebExtensionHandler.swift  # NSExtensionRequestHandling: native <-> extension bridge
│   │   ├── Info.plist
│   │   └── Resources/
│   │       ├── manifest.json                # Safari Web Extension manifest (MV2)
│   │       ├── background.js                # Background script: event loop, tool dispatch, native messaging
│   │       │
│   │       ├── content-scripts/             # Scripts injected into web pages
│   │       │   ├── accessibility-tree.js    # DOM traversal, ref_id mapping, role detection
│   │       │   ├── console-monitor.js       # console.* method override for message capture
│   │       │   ├── network-monitor.js       # fetch/XHR patching + PerformanceObserver
│   │       │   └── agent-visual-indicator.js # Orange pulsing border + "Stop Claude" button
│   │       │
│   │       ├── tools/                       # Tool handler modules (one per MCP tool)
│   │       │   ├── constants.js             # Shared JS constants (NATIVE_APP_ID, etc.)
│   │       │   ├── tool-registry.js         # Tool name -> handler dispatch map
│   │       │   ├── read-page.js             # read_page: accessibility tree extraction
│   │       │   ├── find.js                  # find: natural language element search
│   │       │   ├── form-input.js            # form_input: set values on form elements
│   │       │   ├── computer.js              # computer: mouse, keyboard, scroll actions
│   │       │   ├── javascript-tool.js       # javascript_tool: execute JS in page context
│   │       │   ├── navigate.js              # navigate: URL navigation, history back/forward
│   │       │   ├── get-page-text.js         # get_page_text: extract raw text from page
│   │       │   ├── tabs-manager.js          # tabs_context_mcp + tabs_create_mcp: virtual tab groups
│   │       │   ├── read-console.js          # read_console_messages: read captured console output
│   │       │   ├── read-network.js          # read_network_requests: read captured network requests
│   │       │   ├── gif-creator.js           # gif_creator: record, stop, export animated GIFs
│   │       │   ├── upload-image.js          # upload_image: upload screenshot/image to page element
│   │       │   └── file-upload.js           # file_upload: upload local file to file input
│   │       │
│   │       ├── lib/                         # Third-party libraries
│   │       │   └── gif.js                   # GIF encoder library
│   │       │
│   │       ├── popup.html                   # Extension popup UI
│   │       ├── popup.js                     # Extension popup logic
│   │       └── images/
│   │           ├── icon-16.png
│   │           ├── icon-48.png
│   │           └── icon-128.png
│   │
│   ├── Shared/                              # Code shared between app and extension targets
│   │   └── Constants.swift                  # App group ID, notification names, shared keys
│   │
│   └── Tests/                               # All test files
│       ├── Swift/                            # XCTest suites for native app
│       │   ├── MCPMessageTests.swift
│       │   ├── MCPSocketServerTests.swift
│       │   ├── MessageFramerTests.swift
│       │   ├── ToolRouterTests.swift
│       │   ├── ScreenshotServiceTests.swift
│       │   ├── AppleScriptBridgeTests.swift
│       │   ├── FileServiceTests.swift
│       │   └── SafariWebExtensionHandlerTests.swift
│       └── JS/                              # JavaScript test suites
│           ├── tool-registry.test.js
│           ├── read-page.test.js
│           ├── find.test.js
│           ├── form-input.test.js
│           ├── computer.test.js
│           ├── javascript-tool.test.js
│           ├── navigate.test.js
│           ├── tabs-manager.test.js
│           ├── console-monitor.test.js
│           ├── network-monitor.test.js
│           └── gif-creator.test.js
│
└── Specs/                                   # Feature specifications (one per feature)
    ├── 001-mcp-socket-server.md             # Unix domain socket server
    ├── 002-message-framing.md               # 4-byte BE length-prefix protocol
    ├── 003-native-extension-bridge.md       # SafariWebExtensionHandler communication
    ├── 004-tool-registry.md                 # Tool dispatch framework
    ├── 005-read-page.md                     # Accessibility tree extraction
    ├── 006-find.md                          # Natural language element search
    ├── 007-form-input.md                    # Form value setting
    ├── 008-navigate.md                      # URL navigation
    ├── 009-get-page-text.md                 # Page text extraction
    ├── 010-computer-mouse-keyboard.md       # Mouse/keyboard/scroll simulation
    ├── 011-computer-screenshot.md           # Screenshot via ScreenCaptureKit
    ├── 012-javascript-tool.md               # Page-context JS execution
    ├── 013-tabs-manager.md                  # Virtual tab group management
    ├── 014-read-console.md                  # Console message capture
    ├── 015-read-network.md                  # Network request capture
    ├── 016-resize-window.md                 # Window resize via AppleScript
    ├── 017-gif-creator.md                   # GIF recording and export
    ├── 018-upload-image.md                  # Image upload to page elements
    ├── 019-file-upload.md                   # Local file upload
    └── 020-agent-visual-indicator.md        # Agent activity overlay
```

## Naming Conventions

- **Swift files**: PascalCase (e.g., `MCPSocketServer.swift`)
- **JavaScript files**: kebab-case (e.g., `tool-registry.js`)
- **Test files**: Match source file name + `Tests` suffix (Swift) or `.test.js` suffix (JS)
- **Spec files**: 3-digit number prefix + kebab-case description (e.g., `001-mcp-socket-server.md`)

## Target Requirements

- **macOS App**: Deployment target macOS 13.0+ (Ventura) for ScreenCaptureKit
- **Safari Extension**: Safari 16.4+ for `world: "MAIN"` in `browser.scripting.executeScript`
- **Manifest**: MV2 with `"persistent": false` for background script lifecycle
