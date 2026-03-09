#!/usr/bin/env node
/**
 * Validates that IIFE code strings built by tool handlers are syntactically
 * valid JavaScript. These strings are injected into page context via
 * browser.tabs.executeScript and never run through Node, so a syntax error
 * would only surface at runtime in Safari.
 *
 * The script scans all .js files in tools/ for template literals that return
 * code strings (pattern: "return `(function("), extracts them, replaces
 * template interpolations with safe placeholders, and attempts to parse
 * them with `new Function()`.
 *
 * NOTE: `new Function()` is used intentionally here for static syntax
 * validation of code strings — no user input flows into it. The input is
 * always source code from our own repository files.
 *
 * Exit code 0 if all scripts parse; 1 if any have syntax errors.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const toolsDir = path.join(
    __dirname,
    "..",
    "ClaudeInSafari Extension",
    "Resources",
    "tools"
);

const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".js"));
let total = 0;
let errors = 0;

for (const file of files) {
    const src = fs.readFileSync(path.join(toolsDir, file), "utf8");

    // Match template literals that look like executeScript code payloads.
    // Pattern: return `(function( ... )`  (backtick-delimited IIFE builders)
    const iifes = src.match(/return `\(function\([^]*?`/g) || [];

    for (const raw of iifes) {
        total++;
        // Strip the "return `" prefix and trailing backtick
        const code = raw
            .slice(8, -1)
            // Replace ${...} template interpolations with a safe string literal
            .replace(/\$\{[^}]+\}/g, '"__placeholder__"');

        try {
            // Intentional use of Function constructor for static syntax validation
            // of our own source files — no user input involved.
            new Function(code); // eslint-disable-line no-new-func
            console.log(`  OK: ${file} (${code.length} chars)`);
        } catch (e) {
            console.error(`  FAIL: ${file}: ${e.message}`);
            errors++;
        }
    }
}

if (total === 0) {
    console.log("No injected scripts found to validate.");
} else if (errors > 0) {
    console.error(`\n${errors} syntax error(s) in ${total} injected script(s)`);
    process.exit(1);
} else {
    console.log(`\nAll ${total} injected script(s) parse successfully`);
}
