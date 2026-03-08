/**
 * Console message capture via method override.
 * See Spec 014 (read-console).
 *
 * Injected at document_start to capture all console output before page scripts run.
 */
(function () {
    if (window.__claudeConsoleMonitorInstalled) return;
    window.__claudeConsoleMonitorInstalled = true;

    const MAX_MESSAGES = 1000;
    window.__claudeConsoleMessages = [];

    const originalConsole = {};
    ["log", "info", "warn", "error", "debug"].forEach((level) => {
        originalConsole[level] = console[level].bind(console);
        console[level] = function (...args) {
            window.__claudeConsoleMessages.push({
                level,
                message: args
                    .map((a) => {
                        try {
                            return typeof a === "object" ? JSON.stringify(a) : String(a);
                        } catch {
                            return String(a);
                        }
                    })
                    .join(" "),
                timestamp: Date.now(),
            });
            if (window.__claudeConsoleMessages.length > MAX_MESSAGES) {
                window.__claudeConsoleMessages.shift();
            }
            originalConsole[level].apply(console, args);
        };
    });

    // Capture unhandled errors
    window.addEventListener("error", (e) => {
        window.__claudeConsoleMessages.push({
            level: "error",
            message: `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`,
            timestamp: Date.now(),
        });
    });

    // Capture unhandled promise rejections
    window.addEventListener("unhandledrejection", (e) => {
        window.__claudeConsoleMessages.push({
            level: "error",
            message: `Unhandled rejection: ${e.reason}`,
            timestamp: Date.now(),
        });
    });
})();
