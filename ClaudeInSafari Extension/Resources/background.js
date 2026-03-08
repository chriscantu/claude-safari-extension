/**
 * Background script for Claude in Safari extension.
 * Handles tool dispatch, native app communication, and tab group management.
 * See Spec 003 (native-extension-bridge) and Spec 004 (tool-registry).
 *
 * Load order (declared in manifest.json background.scripts):
 *   1. tools/tool-registry.js  — defines registerTool / executeTool on globalThis
 *   2. tools/tabs-manager.js   — registers tabs_context_mcp, tabs_create_mcp
 *   3. background.js           — this file; starts the poll loop
 */

const POLL_INTERVAL_MS = 100;
const POLL_IDLE_INTERVAL_MS = 5000;
let isActive = false;
let pollTimer = null;

/**
 * Poll the native app for pending tool requests.
 */
async function pollForRequests() {
    try {
        const response = await browser.runtime.sendNativeMessage(
            "com.chriscantu.claudeinsafari",
            { type: "poll" }
        );

        if (response && response.type === "tool_request") {
            isActive = true;
            const payload = typeof response.payload === "string"
                ? JSON.parse(response.payload)
                : response.payload;

            // Delegate to the tool registry (tool-registry.js sets globalThis.executeTool)
            const result = await globalThis.executeTool(payload.tool, payload.args, payload.context);

            await browser.runtime.sendNativeMessage(
                "com.chriscantu.claudeinsafari",
                {
                    type: "tool_response",
                    requestId: payload.requestId,
                    ...result,
                }
            );
        } else {
            isActive = false;
        }
    } catch (error) {
        console.error("Poll error:", error);
        isActive = false;
    }

    // Schedule next poll (faster when active, slower when idle)
    const interval = isActive ? POLL_INTERVAL_MS : POLL_IDLE_INTERVAL_MS;
    pollTimer = setTimeout(pollForRequests, interval);
}

// Keep the background script alive with periodic alarms
browser.alarms.create("keepalive", { periodInMinutes: 0.4 });
browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
        // This listener keeps the background script from being terminated
    }
});

// Start polling when the extension loads
pollForRequests();

console.log("Claude in Safari background script loaded");
