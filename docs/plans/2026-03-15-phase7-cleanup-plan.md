# Phase 7 Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four deferred code quality items from the original REVIEW.md (M5, M6, L3, L5) in a single `chore/phase7-cleanup` PR.

**Architecture:** Four independent, non-interacting changes — dead code deletion (L5), test coverage addition (L3), test hook removal (M6), and SRP refactor (M5). Each has its own commit.

**Tech Stack:** Swift / XCTest (L3, L5), JavaScript / Jest (M5, M6)

---

## Chunk 1: Swift changes (L5, L3)

### Task 1: L5 — Delete dead structs from `MCPMessage.swift`

**Files:**
- Modify: `ClaudeInSafari/Models/MCPMessage.swift:3-19`

- [ ] **Step 1: Delete `ToolRequest` and `ToolRequestParams`**

  In `MCPMessage.swift`, delete lines 3–20 (the comment, both structs, the blank line between them, and the trailing blank line after `ToolRequestParams`). After deletion the file should start with:

  ```swift
  import Foundation

  /// Represents an outgoing MCP tool response to the CLI client.
  struct ToolResponse: Codable {
  ```

- [ ] **Step 2: Run Swift tests to verify nothing broke**

  ```fish
  make test-swift
  ```

  Expected: all tests pass. If any test references `ToolRequest` or `ToolRequestParams`, it will fail here — that would mean the structs were not actually dead. (They should not, based on the audit.)

- [ ] **Step 3: Commit**

  ```fish
  echo "chore(models): delete dead ToolRequest and ToolRequestParams structs

  These structs were never decoded from live data — ToolRouter uses
  JSONSerialization directly. Dead code from an earlier design.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari/Models/MCPMessage.swift"
  git commit -F /tmp/commitmsg
  ```

---

### Task 2: L3 — Add `AnyCodable` edge case tests to `MCPMessageTests.swift`

**Files:**
- Modify: `Tests/Swift/MCPMessageTests.swift` (add before final `}`)

The existing tests cover Bool/Int coercion, NSNumber/CFBoolean distinction, Double, and raw JSON round-trip. The four missing cases are: `null`, `String`, nested `Array`, and nested `Dict`.

- [ ] **Step 1: Add the four missing tests**

  Insert the following four test methods in `MCPMessageTests.swift` immediately before the final closing `}` of the test class (currently line 299):

  ```swift
  // MARK: - AnyCodable edge case coverage

  func testAnyCodableNullRoundTrip() throws {
      let json = "null".data(using: .utf8)!
      let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
      XCTAssertTrue(decoded.value is NSNull)
      let reencoded = try JSONEncoder().encode(decoded)
      XCTAssertEqual(String(data: reencoded, encoding: .utf8), "null")
  }

  func testAnyCodableStringRoundTrip() throws {
      let json = #""hello world""#.data(using: .utf8)!
      let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
      XCTAssertEqual(decoded.value as? String, "hello world")
      let reencoded = try JSONEncoder().encode(decoded)
      XCTAssertEqual(String(data: reencoded, encoding: .utf8), #""hello world""#)
  }

  func testAnyCodableNestedArrayRoundTrip() throws {
      let json = #"[1,"two",true,null]"#.data(using: .utf8)!
      let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
      let arr = decoded.value as? [Any]
      XCTAssertEqual(arr?.count, 4)
      let reencoded = try JSONEncoder().encode(decoded)
      let result = try JSONSerialization.jsonObject(with: reencoded) as? [Any]
      XCTAssertNotNil(result)
      XCTAssertEqual((result?[0] as? NSNumber)?.intValue, 1)
      XCTAssertEqual(result?[1] as? String, "two")
      XCTAssertEqual((result?[2] as? NSNumber)?.boolValue, true)
      XCTAssertTrue(result?[3] is NSNull)
  }

  func testAnyCodableNestedDictRoundTrip() throws {
      let json = #"{"a":1,"b":"two","c":null}"#.data(using: .utf8)!
      let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
      let dict = decoded.value as? [String: Any]
      XCTAssertEqual(dict?.count, 3)
      let reencoded = try JSONEncoder().encode(decoded)
      let result = try JSONSerialization.jsonObject(with: reencoded) as? [String: Any]
      XCTAssertNotNil(result)
      XCTAssertEqual(result?["a"] as? Int, 1)
      XCTAssertEqual(result?["b"] as? String, "two")
      XCTAssertTrue(result?["c"] is NSNull)
  }
  ```

- [ ] **Step 2: Run tests — all four should pass immediately**

  These are coverage tests for existing behavior, not new behavior. They should pass on first run.

  ```fish
  make test-swift
  ```

  Expected: all tests pass including the four new ones.

- [ ] **Step 3: Commit**

  ```fish
  echo "test(models): add AnyCodable edge case coverage (null, String, Array, Dict)

  Fills the four test gaps identified in REVIEW.md L3. Bool, Int, Double,
  and NSNumber/CFBoolean coercion were already covered.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "Tests/Swift/MCPMessageTests.swift"
  git commit -F /tmp/commitmsg
  ```

---

## Chunk 2: JavaScript changes (M6, M5)

### Task 3: M6 — Remove `__captureResolveTab` test hook from `tabs-manager.js`

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/tools/tabs-manager.js:226-229`
- Modify: `Tests/JS/tabs-manager.test.js` (T5, T6, T9)

- [ ] **Step 1: Remove the hook from `tabs-manager.js`**

  Delete lines 226–229 from `tabs-manager.js`. The block to delete is:

  ```js
      // Test hook: allows tests to capture the resolveTab function directly
      if (typeof globalThis.__captureResolveTab === "function") {
          globalThis.__captureResolveTab(resolveTab);
      }
  ```

  After deletion, the bottom of the file should read:

  ```js
  registerTool("tabs_context_mcp", handleTabsContextMcp);
  registerTool("tabs_create_mcp", handleTabsCreateMcp);

  // Expose resolveTab globally so other tool modules can use it
  if (typeof globalThis !== "undefined") {
      globalThis.resolveTab = resolveTab;
  }
  ```

- [ ] **Step 2: Update T5 in `tabs-manager.test.js`**

  Find the T5 block (around line 136–146). Replace the hook pattern:

  ```js
  // BEFORE
  let resolveTabFn;
  globalThis.__captureResolveTab = (fn) => { resolveTabFn = fn; };
  require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
  ```

  With the direct read:

  ```js
  // AFTER
  require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
  const resolveTabFn = globalThis.resolveTab;
  ```

- [ ] **Step 3: Update T6 in `tabs-manager.test.js`**

  Find the T6 block (around line 152–158). Apply the same replacement:

  ```js
  // BEFORE
  let resolveTabFn;
  globalThis.__captureResolveTab = (fn) => { resolveTabFn = fn; };
  require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
  ```

  ```js
  // AFTER
  require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
  const resolveTabFn = globalThis.resolveTab;
  ```

- [ ] **Step 4: Update T9 in `tabs-manager.test.js`**

  Find the T9 block (around line 200–206). Apply the same replacement:

  ```js
  // BEFORE
  let resolveTabFn;
  globalThis.__captureResolveTab = (fn) => { resolveTabFn = fn; };
  require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
  ```

  ```js
  // AFTER
  require("../../ClaudeInSafari Extension/Resources/tools/tabs-manager.js");
  const resolveTabFn = globalThis.resolveTab;
  ```

- [ ] **Step 5: Run JS tests**

  ```fish
  npm test
  ```

  Expected: all tests pass. T5, T6, T9 should still exercise the same `resolveTab` logic — `globalThis.resolveTab` is the identical function object that the hook was previously capturing.

- [ ] **Step 6: Commit**

  ```fish
  echo "chore(tabs-manager): remove __captureResolveTab test hook from production code

  The hook leaked test infrastructure into the background page. Tests now
  read globalThis.resolveTab directly after require(), which is the same
  function object — no behavior change.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari Extension/Resources/tools/tabs-manager.js" "Tests/JS/tabs-manager.test.js"
  git commit -F /tmp/commitmsg
  ```

---

### Task 4: M5 — Extract `normalizePayload()` from `background.js`

**Files:**
- Modify: `ClaudeInSafari Extension/Resources/background.js`

- [ ] **Step 1: Add `normalizePayload` above `pollForRequests`**

  Insert the following function immediately before the `/**` JSDoc comment that precedes `pollForRequests` (currently line 100):

  ```js
  /**
   * Parse the raw poll response payload into an object.
   * Accepts either a JSON string or a pre-parsed object.
   * Throws SyntaxError on malformed JSON.
   */
  function normalizePayload(response) {
      const raw = response.payload;
      if (typeof raw === "string") {
          return JSON.parse(raw);
      }
      return raw;
  }
  ```

- [ ] **Step 2: Replace the inline payload parsing in `pollForRequests`**

  In `pollForRequests`, replace the Phase 2 block (lines 134–144):

  ```js
  // BEFORE
          // Phase 2: parse the tool request payload
          let payload;
          try {
              payload = typeof response.payload === "string"
                  ? JSON.parse(response.payload)
                  : response.payload;
          } catch (error) {
              console.error("Poll: failed to parse tool request payload:", error);
              isActive = false;
              return;
          }
  ```

  With:

  ```js
  // AFTER
          // Phase 2: parse the tool request payload
          let payload;
          try {
              payload = normalizePayload(response);
          } catch (error) {
              console.error("Poll: failed to parse tool request payload:", error);
              isActive = false;
              return;
          }
  ```

- [ ] **Step 3: Run JS tests**

  ```fish
  npm test
  ```

  Expected: all tests pass. No behavior change — same logic, just extracted.

- [ ] **Step 4: Commit**

  ```fish
  echo "refactor(background): extract normalizePayload() from poll loop

  Moves inline payload parsing out of pollForRequests into a named helper,
  keeping the poll loop focused on dispatch logic (SRP). No behavior change.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" > /tmp/commitmsg
  git add "ClaudeInSafari Extension/Resources/background.js"
  git commit -F /tmp/commitmsg
  ```

---

## Final Verification

- [ ] **Run both test suites clean**

  ```fish
  npm test && make test-swift
  ```

  Expected: all tests pass.

- [ ] **Open the PR**

  ```fish
  git push -u origin chore/phase7-cleanup
  ```

  Use the `/commit-push-pr` skill or open manually. PR title: `chore: phase 7 cleanup — M5 M6 L3 L5`.
