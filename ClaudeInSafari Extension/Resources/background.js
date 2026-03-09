/**
 * Background script for Claude in Safari extension.
 * Handles tool dispatch, native app communication, and tab group management.
 * See Spec 003 (native-extension-bridge) and Spec 004 (tool-registry).
 *
 * Load order (declared in manifest.json background.scripts):
 *   1. tools/constants.js      — defines NATIVE_APP_ID
 *   2. tools/tool-registry.js  — defines registerTool / executeTool on globalThis
 *   3. tools/tabs-manager.js   — registers tabs_context_mcp, tabs_create_mcp; exports resolveTab
 *   4. tools/navigate.js       — registers navigate
 *   5. tools/read_page.js      — registers read_page
 *   6. background.js           — this file; starts the poll loop
 */

const POLL_INTERVAL_MS = 100;
const POLL_IDLE_INTERVAL_MS = 5000;
let isActive = false;
let pollTimer = null;

/**
 * Poll the native app for pending tool requests.
 * Each phase (poll, parse, execute, respond) has its own try/catch so errors
 * in one phase do not misclassify errors from another.
 */
async function pollForRequests() {
    try {
        // Phase 1: poll native app for a pending request
        let response;
        try {
            response = await browser.runtime.sendNativeMessage(
                NATIVE_APP_ID,
                { type: "poll" }
            );
        } catch (error) {
            const msg = error?.message || String(error);
            if (msg.includes("Could not establish connection") || msg.includes("native host") || msg.includes("No native messaging host")) {
                console.warn("Poll: native app not running or disconnected:", msg);
            } else if (msg.includes("timeout") || msg.includes("timed out")) {
                console.warn("Poll: native message timed out:", msg);
            } else {
                console.error("Poll: native message failed:", error);
            }
            isActive = false;
            return;
        }

        if (!response || response.type !== "tool_request") {
            isActive = false;
            return;
        }

        isActive = true;

        // Phase 2: parse the tool request payload
        let payload;
        try {
            payload = typeof response.payload === "string"
                ? JSON.parse(response.payload)
                : response.payload;
        } catch (error) {
            console.error("Poll: failed to parse tool request payload:", error);
            isActive = false;
            return;
        }

        // Phase 3: execute the tool
        let result;
        try {
            result = await globalThis.executeTool(payload.tool, payload.args, payload.context);
        } catch (error) {
            console.error("Poll: tool execution error for", payload.tool, ":", error);
            isActive = false;
            return;
        }

        // Phase 4: send the response back to the native app
        try {
            await browser.runtime.sendNativeMessage(
                NATIVE_APP_ID,
                {
                    type: "tool_response",
                    requestId: payload.requestId,
                    ...result,
                }
            );
        } catch (error) {
            console.error("Poll: failed to send tool response:", error);
            isActive = false;
        }
    } finally {
        // Schedule next poll (faster when active, slower when idle)
        const interval = isActive ? POLL_INTERVAL_MS : POLL_IDLE_INTERVAL_MS;
        pollTimer = setTimeout(pollForRequests, interval);
    }
}

// Keep the background script alive with periodic alarms (requires alarms permission).
// Guard for Safari versions that may not support browser.alarms in MV2.
if (typeof browser.alarms !== "undefined") {
    browser.alarms.create("keepalive", { periodInMinutes: 0.4 });
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "keepalive") {
            // This listener keeps the background script from being terminated
        }
    });
}

// Start polling when the extension loads
pollForRequests();

console.log("Claude in Safari background script loaded");
