/**
 * Network request capture via main-world script injection.
 * See Spec 015 (read-network).
 *
 * Content scripts run in an isolated world and cannot patch the page's
 * window.fetch or XMLHttpRequest.prototype — those live in the main world.
 * This script:
 *   1. Registers a CustomEvent listener (content-script world) to collect
 *      request entries into window.__claudeNetworkRequests.
 *   2. Injects a <script> tag (main world) that patches fetch/XHR and
 *      relays each request via CustomEvent back to the listener above.
 *
 * Injected at document_start so the patch is in place before page scripts run.
 */
(function () {
    if (window.__claudeNetworkMonitorInstalled) return;
    window.__claudeNetworkMonitorInstalled = true;

    const MAX_REQUESTS = 500;
    window.__claudeNetworkRequests = [];

    // Receive relay events from the main-world patch and store in buffer.
    // CustomEvents dispatched on window from the main world ARE received by
    // content-script addEventListener — the standard MV2 cross-world channel.
    window.addEventListener("__claudeNetworkRequest", function (event) {
        if (!event.detail || typeof event.detail !== "object") return;
        window.__claudeNetworkRequests.push(event.detail);
        if (window.__claudeNetworkRequests.length > MAX_REQUESTS) {
            window.__claudeNetworkRequests.shift();
        }
    });

    // Inject fetch/XHR patching into the main world via <script> tag.
    // Script tags execute synchronously on appendChild, ensuring the patch is
    // in place before any page JavaScript runs.
    const patchScript = document.createElement("script");
    patchScript.textContent = `(function () {
    if (window.__claudeNetworkPatchInstalled) return;
    window.__claudeNetworkPatchInstalled = true;

    function relay(entry) {
        window.dispatchEvent(new CustomEvent("__claudeNetworkRequest", { detail: entry }));
    }

    if (typeof window.fetch === "function") {
        var _fetch = window.fetch;
        window.fetch = async function () {
            var req = new Request(...arguments);
            var entry = { type: "fetch", method: req.method, url: req.url, startTime: Date.now(), status: null };
            try {
                var res = await _fetch.apply(this, arguments);
                entry.status = res.status;
                entry.statusText = res.statusText;
                entry.endTime = Date.now();
                relay(entry);
                return res;
            } catch (err) {
                entry.error = err.message;
                entry.endTime = Date.now();
                relay(entry);
                throw err;
            }
        };
    }

    if (typeof XMLHttpRequest !== "undefined") {
        var _open = XMLHttpRequest.prototype.open;
        var _send = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this.__claudeEntry = { type: "xhr", method: String(method), url: String(url), startTime: Date.now() };
            return _open.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            var self = this;
            var entry = self.__claudeEntry;
            if (entry) {
                self.addEventListener("error", function () { entry.error = "Network request failed"; });
                self.addEventListener("abort", function () { entry.error = "Request aborted"; });
                self.addEventListener("loadend", function () {
                    entry.status = self.status;
                    entry.statusText = self.statusText;
                    entry.endTime = Date.now();
                    relay(entry);
                });
            }
            return _send.apply(this, arguments);
        };
    }
})();`;

    try {
        (document.head || document.documentElement).appendChild(patchScript);
        patchScript.remove();
    } catch (_) {
        // Document may not yet have injectable elements; requests will not be captured.
    }
})();
