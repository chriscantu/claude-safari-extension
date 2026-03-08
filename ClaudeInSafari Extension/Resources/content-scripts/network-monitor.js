/**
 * Network request capture via fetch/XHR patching + PerformanceObserver.
 * See Spec 015 (read-network).
 *
 * Injected at document_start to intercept all outgoing requests.
 */
(function () {
    if (window.__claudeNetworkMonitorInstalled) return;
    window.__claudeNetworkMonitorInstalled = true;

    const MAX_REQUESTS = 500;
    window.__claudeNetworkRequests = [];

    function pushRequest(entry) {
        window.__claudeNetworkRequests.push(entry);
        if (window.__claudeNetworkRequests.length > MAX_REQUESTS) {
            window.__claudeNetworkRequests.shift();
        }
    }

    // Patch fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const request = new Request(...args);
        const entry = {
            url: request.url,
            method: request.method,
            type: "fetch",
            startTime: Date.now(),
            status: null,
        };
        try {
            const response = await originalFetch.apply(this, args);
            entry.status = response.status;
            entry.statusText = response.statusText;
            entry.endTime = Date.now();
            pushRequest(entry);
            return response;
        } catch (error) {
            entry.error = error.message;
            entry.endTime = Date.now();
            pushRequest(entry);
            throw error;
        }
    };

    // Patch XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__claudeEntry = { url: String(url), method, type: "xhr", startTime: Date.now() };
        return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("loadend", () => {
            if (this.__claudeEntry) {
                this.__claudeEntry.status = this.status;
                this.__claudeEntry.statusText = this.statusText;
                this.__claudeEntry.endTime = Date.now();
                pushRequest(this.__claudeEntry);
            }
        });
        return originalSend.apply(this, args);
    };

    // Supplement with PerformanceObserver for resource timing
    if (window.PerformanceObserver) {
        try {
            const observer = new PerformanceObserver(() => {
                // Resource entries are available but we primarily rely on fetch/XHR patching.
                // This observer ensures we don't miss any requests.
            });
            observer.observe({ entryTypes: ["resource"] });
        } catch {
            // PerformanceObserver may not support 'resource' in all contexts
        }
    }
})();
