/**
 * @jest-environment jsdom
 *
 * Tests for content-scripts/network-monitor.js
 * See Spec 015 (read_network_requests).
 *
 * WHY two-phase setup:
 *   network-monitor.js is split into two parts:
 *   1. Content-script side (isolated world): registers a "__claudeNetworkRequest"
 *      CustomEvent listener that stores entries in window.__claudeNetworkRequests.
 *   2. Main-world patch (injected via <script> tag): patches window.fetch and
 *      XMLHttpRequest.prototype, dispatching CustomEvents for each request.
 *
 *   jsdom does not execute <script> tags added via appendChild(). We extract
 *   the patch IIFE from the source file with a regex and run it to simulate
 *   main-world execution. Both halves then run in the same jsdom context.
 *
 * WHY XhrStub (still needed):
 *   jsdom's XMLHttpRequest fires events asynchronously and makes real HTTP
 *   requests. XhrStub fires events synchronously — no network, no races.
 *
 * Covers:
 *   T1  — idempotency: second content-script load does not re-patch or reset buffer
 *   T2  — fetch success: captures url, method, status, statusText, duration
 *   T3  — fetch error: captures error message and endTime
 *   T4  — fetch error: re-throws so callers receive the error
 *   T5  — XHR success: open+send captures url, method, type="xhr", status, duration
 *   T6  — XHR error event: entry has error = "Network request failed"
 *   T7  — XHR abort event: entry has error = "Request aborted"
 *   T8  — MAX_REQUESTS (500): oldest entry evicted when buffer exceeds limit
 *   T9  — buffer initialised as empty array on first load
 *   T10 — fetch type field is "fetch"
 *   T11 — XHR type field is "xhr"
 *   T12 — fetch startTime <= endTime (timing order)
 *   T13 — multiple sequential fetches all captured
 *   T14 — XHR without open(): send() does not throw or push a malformed entry
 *   T15 — invalid CustomEvent (non-object detail) is ignored by listener
 *   T16 — main-world patch guard: second eval does not re-wrap fetch
 */

"use strict";

const fs = require("fs");

const SCRIPT_PATH = require.resolve(
    "../../ClaudeInSafari Extension/Resources/content-scripts/network-monitor.js"
);

// ---------------------------------------------------------------------------
// Extract the embedded patch IIFE from the source file.
// This simulates what Safari does when it executes the injected <script> tag
// in the main world — here we run it directly in the jsdom context instead.
// ---------------------------------------------------------------------------

const MONITOR_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

function extractPatchScript() {
    const match = MONITOR_SOURCE.match(/patchScript\.textContent\s*=\s*`([\s\S]*?)`;/);
    if (!match) throw new Error("Could not extract patchScript.textContent from network-monitor.js");
    return match[1];
}

const PATCH_SOURCE = extractPatchScript();

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const JSDOM_FETCH   = window.fetch;
const JSDOM_XHR     = window.XMLHttpRequest;
const JSDOM_REQUEST = window.Request;

let mockFetch;
let CurrentXhrStub;
let capturedNetworkListeners = [];

/**
 * Loads the content-script IIFE fresh (sets up the CustomEvent listener).
 * Does NOT run the main-world patch — call installPatch() separately.
 *
 * Wraps window.addEventListener to capture the "__claudeNetworkRequest"
 * listener so it can be removed in afterEach — preventing accumulation
 * across tests (each installMonitor() call adds a new listener).
 */
function installMonitor() {
    delete window.__claudeNetworkMonitorInstalled;
    delete window.__claudeNetworkRequests;

    const origAdd = window.addEventListener.bind(window);
    window.addEventListener = function (type, listener, ...rest) {
        if (type === "__claudeNetworkRequest") capturedNetworkListeners.push(listener);
        return origAdd(type, listener, ...rest);
    };

    jest.resetModules();
    require(SCRIPT_PATH);

    window.addEventListener = origAdd; // restore immediately after install
}

/**
 * Re-runs the content script WITHOUT clearing the idempotency guard — T1 only.
 */
function reinstallMonitor() {
    jest.resetModules();
    require(SCRIPT_PATH);
}

/**
 * Ensures the main-world patch is installed by running the extracted patch IIFE.
 * Uses indirect eval to run in global scope.
 *
 * NOTE: jest-environment-jsdom executes <script> tags appended via appendChild
 * (runScripts: "dangerously" is the default). installMonitor()'s require() call
 * triggers the content script IIFE, which injects a <script> tag that jsdom
 * executes synchronously — setting __claudeNetworkPatchInstalled and wrapping
 * fetch. This function therefore runs the IIFE without clearing the guard first:
 * if the script tag already ran, this is a no-op (guard prevents re-wrap);
 * if jsdom did not execute the script tag, this installs the patch as a fallback.
 */
function installPatch() {
    // Do NOT delete __claudeNetworkPatchInstalled here — the <script> tag injected
    // by installMonitor() already ran and set the guard. Deleting it would cause
    // fetch to be wrapped a second time, producing double entries per request.
    (0, eval)(PATCH_SOURCE); // eslint-disable-line no-eval
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("network-monitor content script", () => {
    beforeEach(() => {
        if (!window.Request) {
            window.Request = class {
                constructor(input, init = {}) {
                    this.url    = typeof input === "string" ? input : input.url;
                    this.method = ((init && init.method) || "GET").toUpperCase();
                }
            };
        }

        mockFetch = jest.fn();
        window.fetch = mockFetch;

        // Fresh XhrStub per test — prevents prototype patch accumulation.
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
        window.XMLHttpRequest = CurrentXhrStub;

        capturedNetworkListeners = [];

        // Phase 1: content-script event listener
        installMonitor();
        // Phase 2: main-world fetch/XHR patch (captures mockFetch + CurrentXhrStub.prototype)
        installPatch();
    });

    afterEach(() => {
        // Remove all captured "__claudeNetworkRequest" listeners to prevent accumulation
        // across tests — each installMonitor() call adds a new listener.
        capturedNetworkListeners.forEach((l) =>
            window.removeEventListener("__claudeNetworkRequest", l)
        );
        capturedNetworkListeners = [];

        window.fetch          = JSDOM_FETCH;
        window.XMLHttpRequest = JSDOM_XHR;
        window.Request        = JSDOM_REQUEST;
        delete window.__claudeNetworkMonitorInstalled;
        delete window.__claudeNetworkPatchInstalled;
        delete window.__claudeNetworkRequests;
    });

    // -----------------------------------------------------------------------

    test("T9 — buffer initialised as empty array on first load", () => {
        expect(Array.isArray(window.__claudeNetworkRequests)).toBe(true);
        expect(window.__claudeNetworkRequests).toHaveLength(0);
    });

    test("T1 — idempotency: second content-script load does not re-patch or reset buffer", () => {
        window.__claudeNetworkRequests.push({ sentinel: true });

        reinstallMonitor(); // guard still set — IIFE bails immediately

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

    test("T3 — fetch error: captures error message and endTime", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Failed to fetch"));

        await expect(window.fetch("https://example.com/")).rejects.toThrow("Failed to fetch");

        expect(window.__claudeNetworkRequests).toHaveLength(1);
        const entry = window.__claudeNetworkRequests[0];
        expect(entry.error).toBe("Failed to fetch");
        expect(typeof entry.endTime).toBe("number");
    });

    test("T4 — fetch error: re-throws so callers still receive the error", async () => {
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
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "https://example.com/data");
        xhr.send();
        xhr.simulateLoad(200, "OK");

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
        xhr.simulateError();

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

        // One more fetch fires a CustomEvent → listener pushes + evicts oldest.
        mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK" });
        await window.fetch("https://example.com/new");

        expect(window.__claudeNetworkRequests).toHaveLength(500);
        expect(window.__claudeNetworkRequests[0].seq).toBe(1);   // seq=0 evicted
        expect(window.__claudeNetworkRequests[499].url).toBe("https://example.com/new");
    });

    test("T14 — XHR without open(): send() does not throw or push a malformed entry", () => {
        const xhr = new XMLHttpRequest();
        expect(() => xhr.send()).not.toThrow();
        xhr.simulateLoad();
        const malformed = window.__claudeNetworkRequests.filter((e) => e.url === undefined);
        expect(malformed).toHaveLength(0);
    });

    test("T15 — invalid CustomEvent (non-object detail) is ignored by listener", () => {
        window.dispatchEvent(new CustomEvent("__claudeNetworkRequest", { detail: null }));
        window.dispatchEvent(new CustomEvent("__claudeNetworkRequest", { detail: "string" }));
        window.dispatchEvent(new CustomEvent("__claudeNetworkRequest", { detail: 42 }));

        expect(window.__claudeNetworkRequests).toHaveLength(0);
    });

    test("T16 — main-world patch guard: second eval does not re-wrap fetch", async () => {
        const patchedFetch = window.fetch;

        // Call eval directly WITHOUT resetting the guard — installPatch() would
        // delete __claudeNetworkPatchInstalled first, defeating the purpose of
        // the test. This verifies the guard prevents re-wrapping on a second eval.
        (0, eval)(PATCH_SOURCE); // eslint-disable-line no-eval

        expect(window.fetch).toBe(patchedFetch);

        mockFetch.mockResolvedValueOnce({ status: 200, statusText: "OK" });
        await window.fetch("https://example.com/");
        expect(window.__claudeNetworkRequests).toHaveLength(1);
    });
});
