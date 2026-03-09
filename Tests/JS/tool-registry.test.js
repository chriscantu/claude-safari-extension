"use strict";

/**
 * Tests for tools/tool-registry.js
 * Covers Spec 004: registration, dispatch, result shaping, error handling,
 * and classifyExecuteScriptError.
 */

function loadModule() {
    jest.resetModules();
    globalThis.registerTool = undefined;
    globalThis.executeTool = undefined;
    globalThis.classifyExecuteScriptError = undefined;
    require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    return {
        registerTool: globalThis.registerTool,
        executeTool: globalThis.executeTool,
        classifyExecuteScriptError: globalThis.classifyExecuteScriptError,
    };
}

describe("tool-registry", () => {

    // ── Registration ──────────────────────────────────────────────────────────

    test("registerTool exports on globalThis", () => {
        const { registerTool, executeTool } = loadModule();
        expect(typeof registerTool).toBe("function");
        expect(typeof executeTool).toBe("function");
    });

    test("multiple tools can be registered independently", async () => {
        const { registerTool, executeTool } = loadModule();
        registerTool("tool_a", async () => "result_a");
        registerTool("tool_b", async () => "result_b");

        const a = await executeTool("tool_a", {});
        const b = await executeTool("tool_b", {});

        expect(a.result.content[0].text).toBe("result_a");
        expect(b.result.content[0].text).toBe("result_b");
    });

    // ── Unknown tool ──────────────────────────────────────────────────────────

    test("unknown tool returns error shape", async () => {
        const { executeTool } = loadModule();
        const out = await executeTool("no_such_tool", {});
        expect(out.error).toBeDefined();
        expect(out.result).toBeUndefined();
        expect(out.error.content[0].type).toBe("text");
        expect(out.error.content[0].text).toContain("no_such_tool");
    });

    // ── String result ─────────────────────────────────────────────────────────

    test("handler returning a string wraps it in a text content block", async () => {
        const { registerTool, executeTool } = loadModule();
        registerTool("echo", async (args) => args.msg);

        const out = await executeTool("echo", { msg: "hello" });
        expect(out.result).toBeDefined();
        expect(out.result.content).toHaveLength(1);
        expect(out.result.content[0]).toEqual({ type: "text", text: "hello" });
    });

    // ── Object result ─────────────────────────────────────────────────────────

    test("handler returning a plain object JSON-stringifies it into a text block", async () => {
        const { registerTool, executeTool } = loadModule();
        registerTool("info", async () => ({ status: "ok", count: 3 }));

        const out = await executeTool("info", {});
        expect(out.result.content[0].type).toBe("text");
        expect(JSON.parse(out.result.content[0].text)).toEqual({ status: "ok", count: 3 });
    });

    // ── Pre-shaped content array (M8 fix) ─────────────────────────────────────

    test("handler returning {content: [...]} passes it through unchanged", async () => {
        const { registerTool, executeTool } = loadModule();
        const imageBlock = { type: "image", data: "base64data==", mediaType: "image/png" };
        registerTool("screenshot", async () => ({ content: [imageBlock] }));

        const out = await executeTool("screenshot", {});
        expect(out.result.content).toHaveLength(1);
        expect(out.result.content[0]).toEqual(imageBlock);
    });

    test("pre-shaped content array with multiple blocks is preserved", async () => {
        const { registerTool, executeTool } = loadModule();
        const blocks = [
            { type: "text", text: "Caption" },
            { type: "image", data: "abc", mediaType: "image/jpeg" },
        ];
        registerTool("multi", async () => ({ content: blocks }));

        const out = await executeTool("multi", {});
        expect(out.result.content).toEqual(blocks);
    });

    // ── Error handling ────────────────────────────────────────────────────────

    test("handler that throws returns error shape with the message", async () => {
        const { registerTool, executeTool } = loadModule();
        registerTool("boom", async () => { throw new Error("something went wrong"); });

        const out = await executeTool("boom", {});
        expect(out.error).toBeDefined();
        expect(out.result).toBeUndefined();
        expect(out.error.content[0].text).toBe("something went wrong");
    });

    test("handler that throws a non-Error is stringified in the error block", async () => {
        const { registerTool, executeTool } = loadModule();
        registerTool("bad", async () => { throw "raw string error"; });

        const out = await executeTool("bad", {});
        expect(out.error.content[0].text).toBe("raw string error");
    });

    // ── Args and context forwarding ───────────────────────────────────────────

    test("args and context are forwarded to the handler", async () => {
        const { registerTool, executeTool } = loadModule();
        let captured = null;
        registerTool("spy", async (args, ctx) => { captured = { args, ctx }; return "ok"; });

        await executeTool("spy", { x: 1 }, { tabId: 42 });
        expect(captured.args).toEqual({ x: 1 });
        expect(captured.ctx).toEqual({ tabId: 42 });
    });

    // ── Registering over an existing name ─────────────────────────────────────

    test("registering the same name twice uses the latest handler", async () => {
        const { registerTool, executeTool } = loadModule();
        registerTool("dup", async () => "first");
        registerTool("dup", async () => "second");

        const out = await executeTool("dup", {});
        expect(out.result.content[0].text).toBe("second");
    });
});

// ---------------------------------------------------------------------------
// classifyExecuteScriptError
// ---------------------------------------------------------------------------

describe("classifyExecuteScriptError", () => {
    afterEach(() => {
        delete globalThis.classifyExecuteScriptError;
    });

    test("is exported on globalThis after require", () => {
        loadModule();
        expect(typeof globalThis.classifyExecuteScriptError).toBe("function");
    });

    test("restricted URL error returns injection guidance with toolName", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("find", 7, new Error("Cannot access contents of the page"));
        expect(err.message).toMatch(/cannot inject into this page/);
        expect(err.message).toContain("find");
    });

    test("Safari WKWebExtensionError matches restricted-URL pattern", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("find", 1, new Error("WKWebExtensionError error 4."));
        expect(err.message).toMatch(/cannot inject into this page/);
    });

    test("Permission denied matches restricted-URL pattern", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("find", 1, new Error("Permission denied"));
        expect(err.message).toMatch(/cannot inject into this page/);
    });

    test("stale tab error returns tab-gone message with tabId and tabs_context_mcp", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("find", 7, new Error("No tab with id: 7"));
        expect(err.message).toContain("7");
        expect(err.message).toMatch(/tabs_context_mcp/);
    });

    test("extension context invalidated returns context-invalid message", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("find", 1, new Error("Extension context invalidated"));
        expect(err.message).toMatch(/extension context is no longer valid/);
    });

    test("generic error is prefixed with toolName: executeScript failed", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("mytool", 1, new Error("some other failure"));
        expect(err.message).toMatch(/^mytool: executeScript failed/);
    });

    test("null err does not throw", () => {
        loadModule();
        expect(() => globalThis.classifyExecuteScriptError("t", 1, null)).not.toThrow();
    });

    test("string rejection (non-Error) is handled without throwing", () => {
        loadModule();
        const err = globalThis.classifyExecuteScriptError("find", 1, "Permission denied");
        expect(err.message).toMatch(/cannot inject into this page/);
    });
});
