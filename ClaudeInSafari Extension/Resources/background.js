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

// ── Indicator state ───────────────────────────────────────────────────────
var currentRequestId   = null; // requestId of the in-flight extension-forwarded tool call
var currentToolTabId   = null; // tabId of the in-flight tool call
var hideIndicatorTimer = null; // debounce timer handle for post-tool indicator hide

// Screenshot/zoom actions must suppress the glow border so it does not appear
// in ScreenCaptureKit captures.
var SCREENSHOT_ACTIONS = { screenshot: true, zoom: true };

/**
 * Send the show message then re-inject the indicator content script.
 * sendMessage is called first so the "show" action is dispatched synchronously
 * (before the setTimeout(0) that yields to executeTool), satisfying the
 * ordering guarantee tested by T_ind1. Both steps are fire-and-forget:
 * failures are logged as warnings and must never block tool execution.
 */
function showIndicatorOnTab(tabId) {
  browser.tabs.sendMessage(tabId, {
    type: "CLAUDE_AGENT_INDICATOR",
    action: "show",
  }).catch(function (e) {
    console.warn("indicator: show message failed (non-critical):", e && e.message);
  });
  // Re-inject the content script after sending the show message (idempotent via
  // installation guard in the content script itself).
  browser.tabs.executeScript(tabId, {
    file: "content-scripts/agent-visual-indicator.js",
  }).catch(function (e) {
    console.warn("indicator: re-inject failed (non-critical):", e && e.message);
  });
}

/**
 * Send the hide message to a tab. Failure is non-critical.
 */
async function hideIndicatorOnTab(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "CLAUDE_AGENT_INDICATOR",
      action: "hide",
    });
  } catch (e) {
    console.warn("indicator: hide message failed (non-critical):", e && e.message);
  }
}

/**
 * Schedule a hide 500ms from now. Cancels any pending hide so rapid back-to-back
 * tool calls keep the indicator visible throughout the sequence.
 */
function scheduleHideIndicator(tabId) {
  if (hideIndicatorTimer !== null) clearTimeout(hideIndicatorTimer);
  hideIndicatorTimer = setTimeout(function () {
    hideIndicatorTimer = null;
    if (tabId != null) hideIndicatorOnTab(tabId);
  }, 500);
}

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
        // IMPORTANT: Yield to the event loop before executing the tool.
        // Safari MV2 restricts browser.tabs.query (and possibly other tab APIs)
        // when called from within a sendNativeMessage response handler. By
        // dispatching via setTimeout(0), the tool runs in a fresh macrotask
        // (next task queue entry) outside the native-messaging callback's current turn.
        // NOTE: This pattern is safe only because "persistent": true prevents the
        // background page from being torn down between setTimeout scheduling and
        // callback execution.
        const toolTabId = (payload.args && payload.args.tabId != null)
            ? payload.args.tabId
            : null;
        const isScreenshotTool = payload.tool === "computer" &&
            !!(payload.args && SCREENSHOT_ACTIONS[payload.args.action]);

        // Set currentRequestId before showing the indicator so a Stop handler
        // that fires while the indicator is already visible sees the in-flight request.
        currentRequestId = payload.requestId;
        currentToolTabId = toolTabId;

        // Show indicator before the tool runs. showIndicatorOnTab calls sendMessage
        // synchronously (fire-and-forget) so the "show" action is dispatched before
        // the setTimeout(0) that yields to executeTool. Non-blocking — never blocks execution.
        if (toolTabId != null) {
            if (hideIndicatorTimer !== null) {
                clearTimeout(hideIndicatorTimer);
                hideIndicatorTimer = null;
            }
            if (isScreenshotTool) {
                // Suppress glow immediately so ScreenCaptureKit does not capture it.
                browser.tabs.sendMessage(toolTabId, {
                    type: "CLAUDE_AGENT_INDICATOR",
                    action: "hide_for_tool",
                }).catch(function () {});
            } else {
                showIndicatorOnTab(toolTabId);
            }
        }

        let result;
        try {
            result = await new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        resolve(await globalThis.executeTool(payload.tool, payload.args, payload.context));
                    } catch (e) {
                        reject(e);
                    }
                }, 0);
            });

            // Check whether this request was cancelled by the Stop handler while the
            // tool was running. If so, the indicator is already hidden and the error
            // response has already been sent — skip Phase 4.
            if (currentRequestId === null) {
                currentToolTabId = null;
                isActive = false;
                return;
            }
            currentRequestId = null;

            // Post-tool indicator: restore (screenshot) or schedule hide (all others).
            if (toolTabId != null) {
                if (isScreenshotTool) {
                    browser.tabs.sendMessage(toolTabId, {
                        type: "CLAUDE_AGENT_INDICATOR",
                        action: "show_after_tool",
                    }).catch(function () {});
                } else {
                    scheduleHideIndicator(toolTabId);
                }
            }
        } catch (error) {
            console.error("Poll: tool execution error for", payload.tool, ":", error);
            currentRequestId = null;
            scheduleHideIndicator(currentToolTabId);
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

// Handle messages from content scripts (Stop button, heartbeat, dismiss).
// Guard: browser.runtime.onMessage may be absent in test environments that
// use the minimal makeBrowserMock (which only provides sendNativeMessage).
if (typeof browser.runtime !== "undefined" && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === "STATIC_INDICATOR_HEARTBEAT") {
      sendResponse({ success: true });
      return true; // keep channel open for synchronous sendResponse
    }

    if (message.type === "STOP_AGENT") {
      // Cancel the in-flight extension-forwarded tool call by injecting an error
      // tool_response. ToolRouter picks it up via its normal poll loop — no new
      // native message type is required.
      var reqId = currentRequestId;
      if (reqId) {
        currentRequestId = null;
        browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
          type: "tool_response",
          requestId: reqId,
          error: { content: [{ type: "text", text: "Cancelled by user" }] },
        }).catch(function (e) {
          console.warn("indicator: failed to send cancel response:", e && e.message);
        });
      }
      // Hide on the tab that sent Stop, or the current tool's tab
      var senderTabId = sender && sender.tab && sender.tab.id;
      var tabToHide   = (senderTabId != null) ? senderTabId : currentToolTabId;
      if (tabToHide != null) hideIndicatorOnTab(tabToHide);

      sendResponse({ success: true });
      return true;
    }

    if (message.type === "DISMISS_STATIC_INDICATOR_FOR_GROUP") {
      // No-op for PR A — full tab-group iteration deferred to PR B
      sendResponse({ success: true });
      return true;
    }
  });
}

// Start polling when the extension loads
pollForRequests();

console.log("Claude in Safari background script loaded");
