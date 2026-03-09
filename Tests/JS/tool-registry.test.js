"use strict";

/**
 * Tests for tools/tool-registry.js
 * Covers Spec 004: registration, dispatch, result shaping, and error handling.
 */

function loadModule() {
    jest.resetModules();
    const registrations = {};
    globalThis.registerTool = undefined;
    globalThis.executeTool = undefined;
    require("../../ClaudeInSafari Extension/Resources/tools/tool-registry.js");
    return {
        registerTool: globalThis.registerTool,
        executeTool: globalThis.executeTool,
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
