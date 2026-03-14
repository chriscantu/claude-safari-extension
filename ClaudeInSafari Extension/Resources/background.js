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
 *   5. tools/read-page.js      — registers read_page
 *   6. tools/find.js           — registers find
 *   7. tools/form-input.js     — registers form_input
 *   8. tools/get-page-text.js  — registers get_page_text
 *   9. tools/computer.js       — registers computer
 *  10. tools/javascript-tool.js — registers javascript_tool
 *  11. tools/read-console.js   — registers read_console_messages
 *  12. tools/read-network.js   — registers read_network_requests
 *  13. tools/upload-image.js   — registers upload_image
 *  14. tools/file-upload.js    — registers file_upload
 *  15. background.js           — this file; starts the poll loop
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
            try {
                await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
                    type: "tool_response",
                    requestId: payload.requestId,
                    error: { content: [{ type: "text", text: `Internal error executing ${payload.tool}: ${error.message || String(error)}` }] },
                });
            } catch (sendErr) {
                console.error("Poll: also failed to send error response:", sendErr);
            }
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
            // No-op body. In Safari MV2, registering an onAlarm listener —
            // not the code inside it — prevents the background page from being suspended.
        }
    });

    // On startup, clean up any stale computer-wait alarm entry left from a prior
    // background page suspension where ToolRouter timed out before we could respond.
    // If the alarm already fired (alarms.get returns undefined), remove the storage
    // entry so the next handleWait call doesn't mistake it for a live resume.
    // Guard browser.storage.session — it may be absent in some Safari builds.
    if (browser.storage?.session) {
        browser.storage.session.get("computer-wait-alarmName").then((stored) => {
            const alarmName = stored["computer-wait-alarmName"];
            if (!alarmName) return;
            return browser.alarms.get(alarmName).then((alarm) => {
                if (!alarm) {
                    return browser.storage.session.remove("computer-wait-alarmName");
                }
            });
        }).catch((err) => {
            console.warn("computer: stale alarm cleanup failed (non-critical):", err);
        });
    }
}

// Start polling when the extension loads
pollForRequests();

console.log("Claude in Safari background script loaded");
