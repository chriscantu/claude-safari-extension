# Spec 003: Native Extension Bridge

## Overview
The communication bridge between the native macOS app and the Safari Web Extension. Handles bidirectional message passing via Safari's `SafariWebExtensionHandler` and `browser.runtime.sendNativeMessage()`.

## Architecture

```
Native App (MCPSocketServer → ToolRouter)
    ↕ SafariWebExtensionHandler (NSExtensionRequestHandling)
Safari Extension (background.js)
    ↕ browser.scripting.executeScript / browser.tabs.*
Content Scripts (web pages)
```

## Components

### Swift Side: SafariWebExtensionHandler

```swift
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext)
}
```

**Receives** messages from the extension's `browser.runtime.sendNativeMessage()`.
**Responds** via `context.completeRequest(returningItems:)`.

### Swift Side: ToolRouter

```swift
protocol ToolRouterDelegate: AnyObject {
    func toolRouter(_ router: ToolRouter, didProduceResponse response: Data, for clientId: String)
}

class ToolRouter {
    weak var delegate: ToolRouterDelegate?

    /// Route an incoming tool request. Some tools are handled natively,
    /// others are forwarded to the Safari extension.
    func route(toolRequest: ToolRequest, clientId: String) async -> ToolResponse
}
```

**Native-handled tools** (bypass extension entirely):
- `computer` with `action: "screenshot"` → ScreenshotService
- `resize_window` → AppleScriptBridge
- `file_upload` (file reading part) → FileService

**Extension-handled tools** (forwarded to background.js):
- `read_page`, `find`, `form_input`, `navigate`, `get_page_text`
- `computer` (mouse/keyboard/scroll), `javascript_tool`
- `tabs_context_mcp`, `tabs_create_mcp`
- `read_console_messages`, `read_network_requests`
- `gif_creator`, `upload_image`

### JavaScript Side: background.js

```javascript
// Receive tool request from native app
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "tool_request") {
        executeTool(message.tool, message.args, message.context)
            .then(result => sendResponse({ type: "tool_response", result }))
            .catch(error => sendResponse({ type: "tool_response", error: error.message }));
        return true; // async response
    }
});

// Send request to native app and await response
async function sendToNativeApp(message) {
    return browser.runtime.sendNativeMessage(
        "com.yourdomain.claudeinsafari",
        message
    );
}
```

## Message Protocol

### Tool Request (Native App → Extension)
```json
{
    "type": "tool_request",
    "requestId": "uuid-1234",
    "tool": "read_page",
    "args": {
        "tabId": 42,
        "filter": "all",
        "depth": 15
    },
    "context": {
        "clientId": "mcp-client-5678",
        "tabGroupId": "group_001"
    }
}
```

### Tool Response (Extension → Native App)
```json
{
    "type": "tool_response",
    "requestId": "uuid-1234",
    "result": {
        "content": [{ "type": "text", "text": "... accessibility tree ..." }]
    }
}
```

### Tool Error Response
```json
{
    "type": "tool_response",
    "requestId": "uuid-1234",
    "error": {
        "content": [{ "type": "text", "text": "Tab not found" }]
    }
}
```

## Communication Pattern

The challenge: `SafariWebExtensionHandler.beginRequest()` is initiated BY the extension (not the native app). The native app cannot push messages to the extension.

### Solution: Extension-Initiated Polling via App Group

1. **Native app** writes pending tool requests to App Group shared `UserDefaults`:
   ```swift
   let defaults = UserDefaults(suiteName: "group.com.yourdomain.claudeinsafari")
   defaults?.set(requestJSON, forKey: "pendingToolRequest")
   ```

2. **Extension background.js** polls via `browser.runtime.sendNativeMessage()` every 100ms during active sessions:
   ```javascript
   async function pollForRequests() {
       const response = await browser.runtime.sendNativeMessage(
           "com.yourdomain.claudeinsafari",
           { type: "poll" }
       );
       if (response.type === "tool_request") {
           const result = await executeTool(response.tool, response.args, response.context);
           await browser.runtime.sendNativeMessage(
               "com.yourdomain.claudeinsafari",
               { type: "tool_response", requestId: response.requestId, ...result }
           );
       }
   }
   ```

3. **SafariWebExtensionHandler** reads pending requests from UserDefaults on poll, and writes responses back.

### Alternative: Direct sendNativeMessage for Extension → Native

For tools that the extension handles but needs native support (e.g., file_upload needs file data), the extension can directly call `browser.runtime.sendNativeMessage()` to request data from the native app. This direction (extension → native) works natively without polling.

## Lifecycle

1. Native app starts → MCPSocketServer starts listening
2. CLI client connects to socket → ToolRouter ready
3. CLI sends tool request → ToolRouter determines handler
4. **If native-handled**: Execute immediately, return response
5. **If extension-handled**: Write to App Group → extension polls → extension executes → extension writes response → native reads response → return to CLI
6. CLI disconnects → clean up session state

## Edge Cases
- Extension background script suspended by Safari → poll request reawakens it via `sendNativeMessage()`
- Native app not running when extension polls → `sendNativeMessage()` returns error; extension retries
- Tool execution takes >10 seconds → extension returns partial/timeout response
- Multiple CLI clients sending tool requests → ToolRouter queues by clientId, processes serially per client
- App Group UserDefaults race condition → use `requestId` to correlate requests and responses

## Test Cases

| Test | Input | Expected Output |
|------|-------|-----------------|
| ToolRouter routes screenshot to native | `{tool: "computer", args: {action: "screenshot"}}` | ScreenshotService called, not forwarded to extension |
| ToolRouter routes read_page to extension | `{tool: "read_page", args: {tabId: 1}}` | Request written to App Group for extension pickup |
| Extension polls and receives request | Poll with pending request | Returns tool_request message |
| Extension polls with no pending request | Poll with empty queue | Returns `{type: "no_request"}` |
| Extension returns tool response | Response written to App Group | Native app reads and returns to CLI client |
| Request-response correlation | Multiple concurrent requests | Each response matched to correct requestId |
| Extension background suspended | Native writes request | Next poll (re-awakened by alarm) picks it up |
| Native app not running | Extension polls | sendNativeMessage returns error |
