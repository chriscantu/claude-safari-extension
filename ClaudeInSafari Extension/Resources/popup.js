/**
 * Popup UI logic — checks MCP connection status via native messaging.
 */
document.addEventListener("DOMContentLoaded", async () => {
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");

    try {
        const response = await browser.runtime.sendNativeMessage(
            NATIVE_APP_ID,
            { type: "status" }
        );

        if (response && response.mcpConnected) {
            dot.classList.add("connected");
            text.textContent = "Connected to Claude Code";
        } else {
            dot.classList.add("disconnected");
            text.textContent = "Not connected";
        }
    } catch (error) {
        dot.classList.add("disconnected");
        text.textContent = "Native app not running";
    }
});
