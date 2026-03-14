/**
 * Tool: javascript_tool
 *
 * Executes arbitrary JavaScript in the active tab's page main world.
 *
 * Architecture: executeScript injects a bridge IIFE into the isolated world.
 * The bridge creates a <script> element whose content evals the user code (wrapped
 * in an async IIFE) in the main world. The async IIFE always returns a Promise, so
 * the result is always written by the .then() callback after appendChild returns.
 * js-bridge-relay.js (persistent content script) polls for the DOM attribute and
 * relays the result to the background via sendMessage (async path).
 *
 * The async IIFE wrapper enables `await` syntax at the top level of user code.
 *
 * See Spec 012 (javascript-tool).
 */

"use strict";

const RESULT_FLAG = "__claudejstoolresult";
const MAX_OUTPUT  = 100000;
const TIMEOUT_MS  = 30000;

// ---------------------------------------------------------------------------
// Bridge builder
// ---------------------------------------------------------------------------

function buildBridge(text, correlationId) {
    const attr = "data-claude-js-result-" + correlationId;

    // Main-world script: eval user code inside an async IIFE, write result to DOM attribute.
    // Wrapping in async IIFE allows `await` syntax at the top level of user code (e.g.
    // `await fetch(...).then(r => r.json())`). The result is always a Promise, so results
    // are always delivered via the .then() relay path through js-bridge-relay.js.
    // Built here as a plain string, then JSON.stringify'd for embedding.
    const mainWorld =
        "(function(){" +
        "var a=" + JSON.stringify(attr) + ";" +
        "function wr(d){document.documentElement.setAttribute(a,JSON.stringify(d))}" +
        "try{" +
        "var r=(async function(){return eval(" + JSON.stringify(text) + ")})();" +
        "r.then(function(v){var s=(v===undefined)?'undefined':(typeof v==='string'?v:JSON.stringify(v,null,2)||'[circular]');if(s.length>" + MAX_OUTPUT + ")s=s.slice(0," + MAX_OUTPUT + ")+'\\n[truncated]';wr({value:s})},function(e){wr({error:String(e)})})" +
        "}catch(e){wr({error:'JavaScript error: '+e.message+'\\n'+(e.stack||'')})}" +
        "})()";

    // Bridge IIFE: runs in isolated world via executeScript.
    // The main-world script always resolves asynchronously (async IIFE), so the attribute
    // is never set before appendChild returns. The bridge always returns null and the
    // async relay (js-bridge-relay.js) picks up the result via DOM attribute polling.
    return (
        "(function(){" +
        "var s=document.createElement('script');" +
        "s.textContent=" + JSON.stringify(mainWorld) + ";" +
        "try{(document.head||document.documentElement).appendChild(s)}catch(e){return JSON.stringify({error:'Script injection failed: '+e.message})}" +
        "var a=" + JSON.stringify(attr) + ";" +
        "var r=document.documentElement.getAttribute(a);" +
        "if(r){document.documentElement.removeAttribute(a);s.remove();return r}" +
        "s.remove();return null" +
        "})()"
    );
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleJavaScriptTool(args) {
    const { action, text, tabId: virtualTabId = null } = args || {};

    if (!action || action !== "javascript_exec") {
        throw new Error("'javascript_exec' is the only supported action");
    }
    if (!text || typeof text !== "string" || text.trim() === "") {
        throw new Error("Code parameter is required");
    }

    const realTabId = await globalThis.resolveTab(virtualTabId);
    const correlationId = RESULT_FLAG + "_" + Math.random().toString(36).slice(2);

    const execResults = await browser.tabs.executeScript(realTabId, {
        code: buildBridge(text, correlationId),
        runAt: "document_idle",
    }).catch((err) => {
        const classified = typeof globalThis.classifyExecuteScriptError === "function"
            ? globalThis.classifyExecuteScriptError("javascript_tool", realTabId, err)
            : err;
        throw classified instanceof Error ? classified : new Error(classified);
    });

    // Sync path: bridge returned result directly
    const raw = execResults && execResults[0];
    if (raw) {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return String(raw); }
        if (parsed.error) throw new Error(parsed.error);
        return parsed.value !== undefined ? String(parsed.value) : "undefined";
    }

    // Async fallback: wait for relay
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;

        function settle(value, isError) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            browser.runtime.onMessage.removeListener(onMessage);
            browser.tabs.onRemoved.removeListener(onTabRemoved);
            isError ? reject(value instanceof Error ? value : new Error(value)) : resolve(value);
        }

        function onMessage(message) {
            if (!message || !message[correlationId]) return;
            message.error ? settle(message.error, true) : settle(message.value !== undefined ? String(message.value) : "undefined", false);
        }

        function onTabRemoved(id) {
            if (id === realTabId) settle("Tab closed during javascript_tool", true);
        }

        browser.runtime.onMessage.addListener(onMessage);
        browser.tabs.onRemoved.addListener(onTabRemoved);
        timer = setTimeout(() => settle("Script execution timed out after 30 seconds", true), TIMEOUT_MS);
    });
}

globalThis.registerTool("javascript_tool", handleJavaScriptTool);
