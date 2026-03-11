/**
 * @jest-environment jsdom
 *
 * Tests for content-scripts/network-monitor.js
 * See Spec 015 (read_network_requests).
 *
 * WHY jsdom + require(): The IIFE patches window.fetch and XMLHttpRequest.prototype
 * at the window level. Loading via require() in Jest's jsdom environment makes
 * window the global, so the patches apply to the same globals the tests drive.
 *
 * WHY XhrStub: jsdom's XMLHttpRequest makes real HTTP requests and fires events
 * asynchronously. This creates CORS errors on external URLs and makes listener
 * ordering non-deterministic (our test loadend fires BEFORE the monitor's loadend
 * because ours is registered before xhr.send() adds the monitor's listener).
 * XhrStub fires events synchronously and predictably — no network, no races.
 *
 * WHY mockFetch before require(): The IIFE captures window.fetch as originalFetch
 * at install time. We set window.fetch = mockFetch first, so the IIFE wraps our
 * controllable mock and tests configure it with mockResolvedValueOnce / mockRejectedValueOnce.
 *
 * Covers:
 *   T1  — idempotency guard: second load does not re-patch or reset buffer
 *   T2  — fetch success: captures url, method, status, statusText, duration
 *   T3  — fetch error: captures error message, endTime set, entry pushed
 *   T4  — fetch error: patched fetch re-throws so callers still receive the error
 *   T5  — XHR success: open+send captures url, method, type="xhr", status, duration
 *   T6  — XHR error event (status 0): entry has error = "Network request failed"
 *   T7  — XHR abort event: entry has error = "Request aborted"
 *   T8  — MAX_REQUESTS (500): oldest entry evicted when buffer exceeds limit
 *   T9  — buffer initialised as empty array on first load
 *   T10 — fetch type field is "fetch"
 *   T11 — XHR type field is "xhr"
 *   T12 — fetch startTime <= endTime (timing order)
 *   T13 — multiple sequential fetches all captured
 *   T14 — XHR without open() called: send() does not throw or push a malformed entry
 */

"use strict";

const SCRIPT_PATH = require.resolve(
    "../../ClaudeInSafari Extension/Resources/content-scripts/network-monitor.js"
);

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const JSDOM_FETCH   = window.fetch;
const JSDOM_XHR     = window.XMLHttpRequest;
const JSDOM_REQUEST = window.Request;

let mockFetch;
let CurrentXhrStub;

/**
 * Installs the monitor IIFE fresh into the current jsdom window.
 * Must be called AFTER window.fetch and window.XMLHttpRequest are replaced so
 * the IIFE captures our mocks as the originals it wraps/patches.
 */
function installMonitor() {
    delete window.__claudeNetworkMonitorInstalled;
    delete window.__claudeNetworkRequests;
    jest.resetModules();
    require(SCRIPT_PATH);
}

/**
 * Re-runs the script WITHOUT clearing the idempotency guard — used only by T1.
 */
function reinstallMonitor() {
    jest.resetModules();
    require(SCRIPT_PATH);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("network-monitor content script", () => {
    beforeEach(() => {
        // The content script uses `new Request(url, opts)` to normalise args.
        // jsdom does not always expose Request as a global; provide a minimal stub.
        if (!window.Request) {
            window.Request = class {
                constructor(input, init = {}) {
                    this.url    = typeof input === "string" ? input : input.url;
                    this.method = ((init && init.method) || "GET").toUpperCase();
                }
            };
        }

        mockFetch = jest.fn();
        window.fetch = mockFetch; // IIFE captures this as originalFetch

        // Create a FRESH XhrStub class each test so prototype patches do not
        // accumulate across tests (each installMonitor() would otherwise wrap
        // the previously-patched prototype, adding duplicate event listeners).
        CurrentXhrStub = class extends EventTarget {
            constructor() {
                super();
                this.status     = 0;
                this.statusText = "";
            }
            open(method, url) { this._method = method; this._url = url; }
            send() { /* tests control events via simulate*() */ }
            simulateLoad(status = 200, statusText = "OK") {
                this.status     = status;
                this.statusText = statusText;
                this.dispatchEvent(new Event("loadend"));
            }
            simulateError() {
                this.dispatchEvent(new Event("error"));
                this.dispatchEvent(new Event("loadend"));
            }
            simulateAbort() {
                this.dispatchEvent(new Event("abort"));
                this.dispatchEvent(new Event("loadend"));
            }
        };
        window.XMLHttpRequest = CurrentXhrStub; // IIFE patches CurrentXhrStub.prototype

        installMonitor();
        // After install: window.fetch is the monitoring wrapper around mockFetch,
        // CurrentXhrStub.prototype.open/send are the patched versions.
    });

    afterEach(() => {
        window.fetch         = JSDOM_FETCH;
        window.XMLHttpRequest = JSDOM_XHR;
        window.Request       = JSDOM_REQUEST;
        delete window.__claudeNetworkMonitorInstalled;
        delete window.__claudeNetworkRequests;
    });

    // -----------------------------------------------------------------------

    test("T9 — buffer initialised as empty array on first load", () => {
        expect(Array.isArray(window.__claudeNetworkRequests)).toBe(true);
        expect(window.__claudeNetworkRequests).toHaveLength(0);
    });

    test("T1 — idempotency guard: second load does not re-patch or reset buffer", () => {
        window.__claudeNetworkRequests.push({ sentinel: true });

        reinstallMonitor(); // guard still set — IIFE bails out immediately

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        expect(window.__claudeNetworkRequests[0]).toEqual({ sentinel: true });
    });

    test("T2 — fetch success: captures url, method, status, statusText, duration", async () => {
        mockFetch.mockResolvedValueOnce({ status: 201, statusText: "Created" });

        await window.fetch("https://example.com/api", { method: "POST" });

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        const entry = window.__claudeNetworkRequests[0];
        expect(entry.url).toBe("https://example.com/api");
        expect(entry.method).toBe("POST");
        expect(entry.type).toBe("fetch");
        expect(entry.status).toBe(201);
        expect(entry.statusText).toBe("Created");
        expect(typeof entry.startTime).toBe("number");
        expect(typeof entry.endTime).toBe("number");
    });

    test("T10 — fetch type field is \"fetch\"", async () => {
        mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK" });
        await window.fetch("https://example.com/");
        expect(window.__claudeNetworkRequests[0].type).toBe("fetch");
    });

    test("T12 — fetch startTime <= endTime (timing order)", async () => {
        mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK" });
        await window.fetch("https://example.com/");
        const { startTime, endTime } = window.__claudeNetworkRequests[0];
        expect(startTime).toBeLessThanOrEqual(endTime);
    });

    test("T3 — fetch error: captures error message, endTime set, entry pushed", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Failed to fetch"));

        await expect(window.fetch("https://example.com/")).rejects.toThrow("Failed to fetch");

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        const entry = window.__claudeNetworkRequests[0];
        expect(entry.error).toBe("Failed to fetch");
        expect(typeof entry.endTime).toBe("number");
    });

    test("T4 — fetch error: patched fetch re-throws so callers still receive the error", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Network unavailable"));
        await expect(window.fetch("https://example.com/")).rejects.toThrow("Network unavailable");
    });

    test("T13 — multiple sequential fetches all captured", async () => {
        mockFetch
            .mockResolvedValueOnce({ status: 200, statusText: "OK" })
            .mockResolvedValueOnce({ status: 200, statusText: "OK" })
            .mockResolvedValueOnce({ status: 200, statusText: "OK" });

        await window.fetch("https://example.com/a");
        await window.fetch("https://example.com/b");
        await window.fetch("https://example.com/c");

        expect(window.__claudeNetworkRequests).toHaveLength(3);
        const urls = window.__claudeNetworkRequests.map((e) => e.url);
        expect(urls).toContain("https://example.com/a");
        expect(urls).toContain("https://example.com/b");
        expect(urls).toContain("https://example.com/c");
    });

    test("T5 — XHR success: open+send captures url, method, type, status, duration", () => {
        const xhr = new XMLHttpRequest(); // XhrStub instance with patched prototype
        xhr.open("GET", "https://example.com/data");
        xhr.send();
        xhr.simulateLoad(200, "OK"); // fires loadend synchronously — monitor pushes entry

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        const entry = window.__claudeNetworkRequests[0];
        expect(entry.url).toBe("https://example.com/data");
        expect(entry.method).toBe("GET");
        expect(entry.type).toBe("xhr");
        expect(entry.status).toBe(200);
        expect(typeof entry.endTime).toBe("number");
    });

    test("T11 — XHR type field is \"xhr\"", () => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "https://example.com/submit");
        xhr.send();
        xhr.simulateLoad();
        expect(window.__claudeNetworkRequests[0].type).toBe("xhr");
    });

    test("T6 — XHR error event: entry has error = \"Network request failed\"", () => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "https://example.com/will-error");
        xhr.send();
        xhr.simulateError(); // fires error (sets __claudeEntry.error) then loadend (pushes entry)

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        expect(window.__claudeNetworkRequests[0].error).toBe("Network request failed");
    });

    test("T7 — XHR abort event: entry has error = \"Request aborted\"", () => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "https://example.com/will-abort");
        xhr.send();
        xhr.simulateAbort();

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        expect(window.__claudeNetworkRequests[0].error).toBe("Request aborted");
    });

    test("T8 — MAX_REQUESTS (500): oldest entry evicted when buffer exceeds limit", async () => {
        // Fill to exactly 500 by pushing directly (avoids 500 async awaits).
        for (let i = 0; i < 500; i++) {
            window.__claudeNetworkRequests.push({ url: `https://example.com/req${i}`, seq: i });
        }

        // One more real fetch triggers pushRequest → shift() to evict the oldest.
        mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK" });
        await window.fetch("https://example.com/new");

        expect(window.__claudeNetworkRequests).toHaveLength(500);
        expect(window.__claudeNetworkRequests[0].seq).toBe(1);   // seq=0 evicted
        expect(window.__claudeNetworkRequests[499].url).toBe("https://example.com/new");
    });

    test("T14 — XHR without open(): send() does not throw or push a malformed entry", () => {
        const xhr = new XMLHttpRequest();
        // __claudeEntry never set — the `if (this.__claudeEntry)` guard in loadend prevents push.
        expect(() => xhr.send()).not.toThrow();
        xhr.simulateLoad(); // trigger loadend; guard should block the push
        const malformed = window.__claudeNetworkRequests.filter((e) => e.url === undefined);
        expect(malformed).toHaveLength(0);
    });
});
