# Agent Visual Indicator (Spec 020, PR A) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the pulsing orange glow border, Stop Claude button, and static "Claude is active" pill bar as a Safari content script, with background.js hooks to show/hide around tool calls and handle the Stop action.

**Architecture:** A single content script (`agent-visual-indicator.js`) renders a Shadow DOM overlay (open mode for testability) containing the glow border, stop button, and static pill. The background script's `pollForRequests` loop shows the indicator before each `executeTool` call and hides it with a 500ms debounce after. A `STOP_AGENT` message handler sends an error `tool_response` for the in-flight `requestId` via existing IPC — no new native message type required.

**Tech Stack:** JavaScript (ES5-compatible), Jest + jsdom, Shadow DOM (`mode: 'open'`), CSS keyframe animation. All DOM construction uses `createElement`/`appendChild` (no `innerHTML`).

**Spec:** `Specs/020-agent-visual-indicator.md`
**PR scope:** PR A — JS only. No Swift changes. PR B (native notifications + full cancel) is deferred.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js` | Replace | Full overlay: Shadow DOM, glow border, stop button, static pill, message listener |
| `ClaudeInSafari Extension/Resources/background.js` | Modify | `currentRequestId` tracking, `showIndicatorOnTab`/`scheduleHideIndicator` helpers, Phase 3 show/hide hooks, `onMessage` listener |
| `Tests/JS/agent-visual-indicator.test.js` | Create | Content script tests (T1-T15) |
| `Tests/JS/background.test.js` | Modify | Add indicator + STOP_AGENT tests (T_ind1-T_ind5, T_stop1-T_stop2, T_heartbeat1) |

---

## Chunk 1: Content Script

### Task 1: Create feature branch

- [ ] **Create branch and verify clean state**
  ```bash
  git checkout -b feature/020-agent-visual-indicator
  git status
  ```
  Expected: `On branch feature/020-agent-visual-indicator`, clean working tree.

---

### Task 2: Content script — DOM skeleton (TDD)

**Files:**
- Create: `Tests/JS/agent-visual-indicator.test.js`
- Modify: `ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js`

- [ ] **Write failing tests for DOM skeleton**

  Create `Tests/JS/agent-visual-indicator.test.js`:

  ```js
  /**
   * @jest-environment jsdom
   *
   * Tests for content-scripts/agent-visual-indicator.js
   * See Spec 020 (agent-visual-indicator).
   *
   * T1  - DOM: shadow host added to body on load
   * T2  - DOM: installation guard prevents double injection
   * T3  - agent show: host gains 'agent-active' class
   * T4  - agent hide: host loses 'agent-active' class
   * T5  - hide_for_tool: agent-active removed, no-transition class set
   * T6  - show_after_tool: agent-active added, no-transition class set
   * T7  - static show: host gains 'static-active' class
   * T8  - static hide: host loses 'static-active' class
   * T9  - stop button click: browser.runtime.sendMessage called with STOP_AGENT
   * T10 - stop button click: agent-active class removed
   * T11 - chat button click: browser.tabs.create called with claude.ai URL
   * T12 - dismiss button click: sendMessage called with DISMISS_STATIC_INDICATOR_FOR_GROUP
   * T13 - heartbeat: response.success=false hides static indicator
   * T14 - heartbeat: rejected promise hides static indicator
   * T15 - stop click while background suspended: indicator hidden locally despite rejection
   */

  'use strict';

  const path = require('path');
  const SCRIPT_PATH = path.resolve(
    __dirname,
    '../../ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js'
  );

  let messageHandler = null;

  /**
   * Loads the content script with a fresh browser mock.
   * Returns the shadow host element plus mocked browser functions for assertions.
   */
  function loadIndicator(opts) {
    var sendMessageImpl = (opts && opts.sendMessageImpl) || function () { return Promise.resolve({ success: true }); };
    messageHandler = null;

    var sendMessage = jest.fn(sendMessageImpl);
    var tabsCreate  = jest.fn();

    globalThis.browser = {
      runtime: {
        onMessage: { addListener: jest.fn(function (fn) { messageHandler = fn; }) },
        sendMessage: sendMessage,
      },
      tabs: { create: tabsCreate },
    };

    jest.isolateModules(function () { require(SCRIPT_PATH); });

    var host = document.getElementById('claude-agent-indicator-host');
    return { host: host, sendMessage: sendMessage, tabsCreate: tabsCreate };
  }

  describe('agent-visual-indicator content script', function () {
    afterEach(function () {
      jest.resetModules();
      jest.clearAllMocks();
      delete globalThis.browser;
      delete window.__claudeVisualIndicatorInstalled;
      var host = document.getElementById('claude-agent-indicator-host');
      if (host) host.remove();
    });

    // T1 - shadow host in body
    test('T1: shadow host added to document.body on load', function () {
      var result = loadIndicator();
      expect(result.host).not.toBeNull();
      expect(document.body.contains(result.host)).toBe(true);
    });

    // T2 - installation guard
    test('T2: double load does not create a second host', function () {
      loadIndicator();
      loadIndicator(); // second require - guard fires, exits early
      var hosts = document.querySelectorAll('#claude-agent-indicator-host');
      expect(hosts.length).toBe(1);
    });
  });
  ```

- [ ] **Run tests to confirm they fail**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```
  Expected: FAIL — host element is null (placeholder script does nothing after the guard).

- [ ] **Implement DOM skeleton in agent-visual-indicator.js**

  Replace the entire file content:

  ```js
  /**
   * Agent visual indicator overlay.
   * See Spec 020 (agent-visual-indicator).
   *
   * Shows a pulsing orange border and "Stop Claude" button during agent activity.
   * Also shows a persistent "Claude is active" pill bar between tool calls.
   *
   * Uses open-mode Shadow DOM for style isolation. Content scripts run in Safari's
   * isolated world so page JS cannot access extension globals; open mode does not
   * weaken security while allowing Jest test access via host.shadowRoot.
   *
   * Activation messages (from background.js):
   *   CLAUDE_AGENT_INDICATOR  action: show | hide | hide_for_tool | show_after_tool
   *   CLAUDE_STATIC_INDICATOR action: show | hide
   *
   * Outbound messages (to background.js):
   *   STOP_AGENT
   *   DISMISS_STATIC_INDICATOR_FOR_GROUP
   *   STATIC_INDICATOR_HEARTBEAT  (heartbeat, expects { success: true } response)
   *
   * All DOM construction uses createElement/appendChild - no innerHTML.
   */
  (function () {
    'use strict';

    if (window.__claudeVisualIndicatorInstalled) return;
    window.__claudeVisualIndicatorInstalled = true;

    // ── Shadow DOM setup ──────────────────────────────────────────────────────

    var host = document.createElement('div');
    host.id = 'claude-agent-indicator-host';

    // Open mode: allows test access via host.shadowRoot.
    var shadow = host.attachShadow({ mode: 'open' });

    var styleEl = document.createElement('style');
    styleEl.id = 'claude-agent-animation-styles';
    styleEl.textContent = ''; // filled in Task 3
    shadow.appendChild(styleEl);

    // Glow border
    var glowBorder = document.createElement('div');
    glowBorder.id = 'claude-agent-glow-border';
    shadow.appendChild(glowBorder);

    // Stop button container
    var stopContainer = document.createElement('div');
    stopContainer.id = 'claude-agent-stop-container';

    var stopSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stopSvg.setAttribute('width', '14');
    stopSvg.setAttribute('height', '14');
    stopSvg.setAttribute('viewBox', '0 0 14 14');
    stopSvg.setAttribute('fill', 'none');
    stopSvg.setAttribute('aria-hidden', 'true');
    var stopPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    stopPoly.setAttribute('points', '4,1 10,1 13,4 13,10 10,13 4,13 1,10 1,4');
    stopPoly.setAttribute('fill', 'white');
    stopSvg.appendChild(stopPoly);

    var stopLabel = document.createTextNode('Stop Claude');

    var stopBtn = document.createElement('button');
    stopBtn.id = 'claude-agent-stop-button';
    stopBtn.type = 'button';
    stopBtn.appendChild(stopSvg);
    stopBtn.appendChild(stopLabel);
    stopContainer.appendChild(stopBtn);
    shadow.appendChild(stopContainer);

    // Static indicator pill
    var staticIndicator = document.createElement('div');
    staticIndicator.id = 'claude-static-indicator';

    var staticText = document.createElement('span');
    staticText.id = 'claude-static-text';
    staticText.textContent = 'Claude is active in this tab group';

    var chatBtn = document.createElement('button');
    chatBtn.id = 'claude-static-chat-button';
    chatBtn.type = 'button';
    chatBtn.className = 'claude-indicator-btn';
    chatBtn.textContent = 'Chat';

    var dismissBtn = document.createElement('button');
    dismissBtn.id = 'claude-static-dismiss-button';
    dismissBtn.type = 'button';
    dismissBtn.className = 'claude-indicator-btn';
    dismissBtn.textContent = 'Dismiss';

    staticIndicator.appendChild(staticText);
    staticIndicator.appendChild(chatBtn);
    staticIndicator.appendChild(dismissBtn);
    shadow.appendChild(staticIndicator);

    document.body.appendChild(host);

    // ── State ─────────────────────────────────────────────────────────────────

    var heartbeatInterval = null;

    // ── Show/hide helpers, button handlers, and message listener added in Tasks 3-5 ──

  }());
  ```

- [ ] **Run tests — T1 and T2 pass**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```
  Expected: T1, T2 PASS.

- [ ] **Commit**
  ```bash
  git add "ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js" \
          "Tests/JS/agent-visual-indicator.test.js"
  git commit -m "test(indicator): T1-T2 DOM skeleton tests + shadow host structure"
  ```

---

### Task 3: Content script — CSS + agent indicator show/hide (TDD)

**Files:**
- Modify: `Tests/JS/agent-visual-indicator.test.js` — add T3-T6
- Modify: `ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js` — add CSS + show/hide logic

- [ ] **Add T3-T6 inside the existing `describe` block, after T2**

  ```js
  // T3 - show: host gains 'agent-active'
  test('T3: CLAUDE_AGENT_INDICATOR show adds agent-active class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'show' });
    expect(result.host.classList.contains('agent-active')).toBe(true);
  });

  // T4 - hide: host loses 'agent-active'
  test('T4: CLAUDE_AGENT_INDICATOR hide removes agent-active class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'show' });
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'hide' });
    expect(result.host.classList.contains('agent-active')).toBe(false);
  });

  // T5 - hide_for_tool: agent-active removed, no-transition applied synchronously
  test('T5: hide_for_tool removes agent-active and sets no-transition class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'show' });
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'hide_for_tool' });
    expect(result.host.classList.contains('agent-active')).toBe(false);
    expect(result.host.classList.contains('no-transition')).toBe(true);
  });

  // T6 - show_after_tool: agent-active added, no-transition applied
  test('T6: show_after_tool adds agent-active and sets no-transition class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'show_after_tool' });
    expect(result.host.classList.contains('agent-active')).toBe(true);
    expect(result.host.classList.contains('no-transition')).toBe(true);
  });
  ```

- [ ] **Run tests — expect T3-T6 to fail**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```
  Expected: T3-T6 FAIL (no message listener registered yet).

- [ ] **Replace `styleEl.textContent = '';` with the full CSS string**

  Replace the single line `styleEl.textContent = '';` with:

  ```js
  styleEl.textContent = [
    '@keyframes claude-pulse {',
    '  0%, 100% { box-shadow:',
    '    inset 0 0 10px rgba(217,119,87,.5),',
    '    inset 0 0 20px rgba(217,119,87,.3),',
    '    inset 0 0 30px rgba(217,119,87,.1); }',
    '  50% { box-shadow:',
    '    inset 0 0 15px rgba(217,119,87,.7),',
    '    inset 0 0 25px rgba(217,119,87,.5),',
    '    inset 0 0 35px rgba(217,119,87,.2); }',
    '}',
    '#claude-agent-glow-border {',
    '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    '  pointer-events: none; z-index: 2147483646;',
    '  opacity: 0; transition: opacity 300ms ease;',
    '  animation: claude-pulse 2s ease-in-out infinite;',
    '}',
    '#claude-agent-stop-container {',
    '  position: fixed; bottom: 20px; left: 50%;',
    '  transform: translate(-50%, 100px); opacity: 0;',
    '  transition: transform 300ms ease, opacity 300ms ease;',
    '  z-index: 2147483647; pointer-events: auto;',
    '}',
    '#claude-agent-stop-button {',
    '  display: flex; align-items: center; gap: 8px;',
    '  padding: 10px 20px; background: #1a1a1a; color: #fff;',
    '  border: 1px solid rgba(255,255,255,.15); border-radius: 100px;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap;',
    '}',
    '#claude-agent-stop-button:hover { background: #2a2a2a; }',
    '#claude-static-indicator {',
    '  position: fixed; bottom: 16px; left: 50%;',
    '  transform: translate(-50%, 100px); opacity: 0;',
    '  transition: transform 300ms ease, opacity 300ms ease;',
    '  z-index: 2147483644; pointer-events: auto;',
    '  display: flex; align-items: center; gap: 10px; padding: 8px 16px;',
    '  background: rgba(26,26,26,.9);',
    '  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);',
    '  border: 1px solid rgba(255,255,255,.1); border-radius: 100px;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  font-size: 13px; color: #fff; white-space: nowrap;',
    '}',
    '.claude-indicator-btn {',
    '  background: transparent; border: 1px solid rgba(255,255,255,.2);',
    '  border-radius: 6px; color: #fff; font-family: inherit;',
    '  font-size: 12px; padding: 3px 10px; cursor: pointer;',
    '}',
    '.claude-indicator-btn:hover { background: rgba(255,255,255,.1); }',
    ':host(.agent-active) #claude-agent-glow-border { opacity: 1; }',
    ':host(.agent-active) #claude-agent-stop-container {',
    '  transform: translate(-50%, 0); opacity: 1; }',
    ':host(.static-active) #claude-static-indicator {',
    '  transform: translate(-50%, 0); opacity: 1; }',
    ':host(.no-transition) #claude-agent-glow-border,',
    ':host(.no-transition) #claude-agent-stop-container { transition: none !important; }',
  ].join('\n');
  ```

- [ ] **Add show/hide helpers and message listener after `document.body.appendChild(host)`**

  Replace the comment `// ── Show/hide helpers ... added in Tasks 3-5 ──` with:

  ```js
  // ── Show/hide helpers ─────────────────────────────────────────────────────

  function showAgentIndicator() {
    host.classList.add('agent-active');
  }

  function hideAgentIndicator() {
    host.classList.remove('agent-active');
  }

  // hide_for_tool / show_after_tool suppress CSS transitions so the glow border
  // does not appear in ScreenCaptureKit screenshots. The no-transition class is
  // removed on the next animation frame so subsequent animated transitions work.
  function hideAgentIndicatorImmediate() {
    host.classList.add('no-transition');
    host.classList.remove('agent-active');
    requestAnimationFrame(function () { host.classList.remove('no-transition'); });
  }

  function showAgentIndicatorImmediate() {
    host.classList.add('no-transition');
    host.classList.add('agent-active');
    requestAnimationFrame(function () { host.classList.remove('no-transition'); });
  }

  // Stub implementations replaced in Task 4
  function showStaticIndicator() {}
  function hideStaticIndicator() {}

  // ── Message listener ──────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener(function (message) {
    if (message.type === 'CLAUDE_AGENT_INDICATOR') {
      if      (message.action === 'show')           showAgentIndicator();
      else if (message.action === 'hide')            hideAgentIndicator();
      else if (message.action === 'hide_for_tool')   hideAgentIndicatorImmediate();
      else if (message.action === 'show_after_tool') showAgentIndicatorImmediate();
    } else if (message.type === 'CLAUDE_STATIC_INDICATOR') {
      if      (message.action === 'show') showStaticIndicator();
      else if (message.action === 'hide') hideStaticIndicator();
    }
  });
  ```

- [ ] **Run tests — T1-T6 pass**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```

- [ ] **Commit**
  ```bash
  git add "ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js" \
          "Tests/JS/agent-visual-indicator.test.js"
  git commit -m "feat(indicator): CSS + agent glow show/hide with T3-T6 tests"
  ```

---

### Task 4: Content script — Static indicator + heartbeat (TDD)

**Files:**
- Modify: `Tests/JS/agent-visual-indicator.test.js` — add T7-T8, T13-T14
- Modify: `ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js` — replace stubs with full static indicator + heartbeat

- [ ] **Add T7, T8, T13, T14 inside the existing `describe` block**

  ```js
  // T7 - static show: host gains 'static-active'
  test('T7: CLAUDE_STATIC_INDICATOR show adds static-active class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_STATIC_INDICATOR', action: 'show' });
    expect(result.host.classList.contains('static-active')).toBe(true);
  });

  // T8 - static hide: host loses 'static-active'
  test('T8: CLAUDE_STATIC_INDICATOR hide removes static-active class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_STATIC_INDICATOR', action: 'show' });
    messageHandler({ type: 'CLAUDE_STATIC_INDICATOR', action: 'hide' });
    expect(result.host.classList.contains('static-active')).toBe(false);
  });

  // T13 - heartbeat: success=false hides static indicator
  test('T13: heartbeat response success=false hides static indicator', async function () {
    jest.useFakeTimers();
    var result = loadIndicator({ sendMessageImpl: function () { return Promise.resolve({ success: false }); } });
    messageHandler({ type: 'CLAUDE_STATIC_INDICATOR', action: 'show' });
    expect(result.host.classList.contains('static-active')).toBe(true);

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(result.host.classList.contains('static-active')).toBe(false);
    jest.useRealTimers();
  });

  // T14 - heartbeat: catch (suspended background) hides static indicator
  test('T14: heartbeat sendMessage rejection hides static indicator', async function () {
    jest.useFakeTimers();
    var result = loadIndicator({
      sendMessageImpl: function () { return Promise.reject(new Error('Background suspended')); },
    });
    messageHandler({ type: 'CLAUDE_STATIC_INDICATOR', action: 'show' });

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(result.host.classList.contains('static-active')).toBe(false);
    jest.useRealTimers();
  });
  ```

- [ ] **Run tests — expect T7-T8 and T13-T14 to fail**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```

- [ ] **Replace the stub `showStaticIndicator`/`hideStaticIndicator` with full implementations** (find and replace just those two function declarations):

  ```js
  function showStaticIndicator() {
    host.classList.add('static-active');
    startHeartbeat();
  }

  function hideStaticIndicator() {
    host.classList.remove('static-active');
    stopHeartbeat();
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(function () {
      browser.runtime.sendMessage({ type: 'STATIC_INDICATOR_HEARTBEAT' })
        .then(function (response) {
          if (!response || !response.success) hideStaticIndicator();
        })
        .catch(function () {
          // Background page suspended — hide immediately
          hideStaticIndicator();
        });
    }, 5000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval !== null) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }
  ```

- [ ] **Run tests — T1-T8 and T13-T14 pass**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```

- [ ] **Commit**
  ```bash
  git add "ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js" \
          "Tests/JS/agent-visual-indicator.test.js"
  git commit -m "feat(indicator): static indicator + heartbeat with T7-T8 T13-T14 tests"
  ```

---

### Task 5: Content script — Stop, Chat, Dismiss buttons (TDD)

**Files:**
- Modify: `Tests/JS/agent-visual-indicator.test.js` — add T9-T12, T15
- Modify: `ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js` — wire button click handlers

- [ ] **Add T9-T12, T15 inside the existing `describe` block**

  ```js
  // T9 - stop button click: sendMessage({ type: 'STOP_AGENT' })
  test('T9: stop button click sends STOP_AGENT message', function () {
    var result = loadIndicator();
    var stopButton = result.host.shadowRoot.querySelector('#claude-agent-stop-button');
    stopButton.click();
    expect(result.sendMessage).toHaveBeenCalledWith({ type: 'STOP_AGENT' });
  });

  // T10 - stop button click: agent-active class removed
  test('T10: stop button click removes agent-active class', function () {
    var result = loadIndicator();
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'show' });
    var stopButton = result.host.shadowRoot.querySelector('#claude-agent-stop-button');
    stopButton.click();
    expect(result.host.classList.contains('agent-active')).toBe(false);
  });

  // T11 - chat button: browser.tabs.create({ url: 'https://claude.ai' })
  test('T11: chat button click opens claude.ai in a new tab', function () {
    var result = loadIndicator();
    var chatButton = result.host.shadowRoot.querySelector('#claude-static-chat-button');
    chatButton.click();
    expect(result.tabsCreate).toHaveBeenCalledWith({ url: 'https://claude.ai' });
  });

  // T12 - dismiss button: sendMessage({ type: 'DISMISS_STATIC_INDICATOR_FOR_GROUP' })
  test('T12: dismiss button sends DISMISS_STATIC_INDICATOR_FOR_GROUP', function () {
    var result = loadIndicator();
    var dismissButton = result.host.shadowRoot.querySelector('#claude-static-dismiss-button');
    dismissButton.click();
    expect(result.sendMessage).toHaveBeenCalledWith({ type: 'DISMISS_STATIC_INDICATOR_FOR_GROUP' });
  });

  // T15 - stop click while background suspended: indicator hidden locally
  test('T15: stop click when sendMessage rejects still removes agent-active', async function () {
    var result = loadIndicator({
      sendMessageImpl: function () { return Promise.reject(new Error('Extension context invalid')); },
    });
    messageHandler({ type: 'CLAUDE_AGENT_INDICATOR', action: 'show' });
    var stopButton = result.host.shadowRoot.querySelector('#claude-agent-stop-button');
    stopButton.click();
    // Local hide is synchronous — class removed before the rejection propagates
    expect(result.host.classList.contains('agent-active')).toBe(false);
    await Promise.resolve(); // drain rejection microtask (prevent unhandled rejection warning)
  });
  ```

- [ ] **Run tests — expect T9-T12, T15 to fail**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```

- [ ] **Add button click handlers below `stopHeartbeat`** (before the message listener):

  ```js
  // ── Button click handlers ─────────────────────────────────────────────────

  stopBtn.addEventListener('click', function () {
    hideAgentIndicator();
    browser.runtime.sendMessage({ type: 'STOP_AGENT' }).catch(function () {
      // Background page suspended — indicator already hidden locally above
    });
  });

  chatBtn.addEventListener('click', function () {
    browser.tabs.create({ url: 'https://claude.ai' });
  });

  dismissBtn.addEventListener('click', function () {
    hideStaticIndicator();
    browser.runtime.sendMessage({ type: 'DISMISS_STATIC_INDICATOR_FOR_GROUP' }).catch(function () {});
  });
  ```

- [ ] **Run full content script suite — all T1-T15 pass**
  ```bash
  npx jest Tests/JS/agent-visual-indicator.test.js --no-coverage
  ```
  Expected: all 14 tests PASS.

- [ ] **Commit**
  ```bash
  git add "ClaudeInSafari Extension/Resources/content-scripts/agent-visual-indicator.js" \
          "Tests/JS/agent-visual-indicator.test.js"
  git commit -m "feat(indicator): stop/chat/dismiss button handlers with T9-T12 T15 tests"
  ```

---

## Chunk 2: background.js Indicator Hooks + STOP_AGENT

### Task 6: background.js — currentRequestId, indicator hooks, screenshot suppression (TDD)

**Files:**
- Modify: `Tests/JS/background.test.js` — add new describe block + helpers
- Modify: `ClaudeInSafari Extension/Resources/background.js` — add state vars, helpers, Phase 3 hooks

- [ ] **Append the following to the END of `Tests/JS/background.test.js`** (after the closing `});` of the existing describe block):

  ```js
  // ---------------------------------------------------------------------------
  // Extended mock — adds tabs.sendMessage, tabs.executeScript, onMessage capture
  // Used by indicator and STOP_AGENT tests only; does not affect T1-T12.
  // ---------------------------------------------------------------------------

  function makeBrowserMockWithMessaging(opts) {
    var base = makeBrowserMock(opts);
    var onMessageHandler = null;
    base.tabs.sendMessage   = jest.fn(async () => {});
    base.tabs.executeScript = jest.fn(async () => {});
    base.runtime.onMessage  = {
      addListener: jest.fn(function (fn) { onMessageHandler = fn; }),
    };
    base._getOnMessageHandler = function () { return onMessageHandler; };
    return base;
  }

  function loadBackgroundWithMessaging(opts) {
    var browser     = opts.browser;
    var executeTool = opts.executeTool;
    loadBackground({ browser: browser, executeTool: executeTool });
    return browser._getOnMessageHandler();
  }

  describe("background.js — indicator hooks and STOP_AGENT", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(console, "warn").mockImplementation(() => {});
      jest.spyOn(console, "error").mockImplementation(() => {});
      jest.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      jest.resetModules();
      delete globalThis.browser;
      delete globalThis.NATIVE_APP_ID;
      delete globalThis.executeTool;
    });

    // T_ind1 — show called before executeTool
    test("T_ind1: tabs.sendMessage show sent before executeTool is called", async () => {
      const calls = [];
      const payload = {
        tool: "navigate",
        args: { url: "https://example.com", tabId: 42 },
        requestId: "r1",
      };
      const browser = makeBrowserMockWithMessaging({
        nativeResponses: [
          { type: "tool_request", payload: JSON.stringify(payload) },
          { type: "idle" },
        ],
      });
      const executeTool = jest.fn(async () => {
        calls.push("executeTool");
        return { result: { content: [{ type: "text", text: "done" }] } };
      });
      browser.tabs.sendMessage = jest.fn(async (_tabId, msg) => {
        if (msg && msg.action) calls.push("sendMessage:" + msg.action);
      });

      loadBackground({ browser, executeTool });

      // One await drains all microtasks from the first poll cycle including
      // showIndicatorOnTab's two internal awaits (executeScript + sendMessage).
      await Promise.resolve();
      jest.runAllTimers(); // setTimeout(0) fires -> executeTool runs
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const showIdx    = calls.indexOf("sendMessage:show");
      const executeIdx = calls.indexOf("executeTool");
      expect(showIdx).toBeGreaterThanOrEqual(0);
      expect(executeIdx).toBeGreaterThan(showIdx);
    });

    // T_ind2 — hide debounced 500ms after tool completes
    test("T_ind2: tabs.sendMessage hide sent 500ms after tool completes (not immediately)", async () => {
      const payload = {
        tool: "navigate",
        args: { url: "https://example.com", tabId: 42 },
        requestId: "r2",
      };
      const browser = makeBrowserMockWithMessaging({
        nativeResponses: [
          { type: "tool_request", payload: JSON.stringify(payload) },
          { type: "idle" },
        ],
      });

      loadBackground({ browser });

      await Promise.resolve();
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Hide not yet sent
      const hideBefore = browser.tabs.sendMessage.mock.calls
        .filter(([, msg]) => msg && msg.action === "hide").length;
      expect(hideBefore).toBe(0);

      // Advance past debounce window
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      const hideAfter = browser.tabs.sendMessage.mock.calls
        .filter(([, msg]) => msg && msg.action === "hide").length;
      expect(hideAfter).toBeGreaterThan(0);
    });

    // T_ind3 — rapid tool calls: debounce reset keeps indicator showing
    test("T_ind3: second tool call cancels pending hide — no hide sent between calls", async () => {
      const p1 = { tool: "navigate", args: { url: "https://a.com", tabId: 7 }, requestId: "r3" };
      const p2 = { tool: "navigate", args: { url: "https://b.com", tabId: 7 }, requestId: "r4" };
      const browser = makeBrowserMockWithMessaging({
        nativeResponses: [
          { type: "tool_request", payload: JSON.stringify(p1) },
          { type: "tool_request", payload: JSON.stringify(p2) },
          { type: "idle" },
        ],
      });

      loadBackground({ browser });

      // First cycle
      await Promise.resolve();
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Advance only 100ms (< 500ms debounce) — second poll starts
      jest.advanceTimersByTime(100);

      // Second cycle
      await Promise.resolve();
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // No hide should have fired yet
      const hideCalls = browser.tabs.sendMessage.mock.calls
        .filter(([, msg]) => msg && msg.action === "hide");
      expect(hideCalls.length).toBe(0);
    });

    // T_ind4 — no tabId: no indicator sendMessage
    test("T_ind4: tool with no tabId — indicator sendMessage not called", async () => {
      const payload = {
        tool: "navigate",
        args: { url: "https://example.com" }, // no tabId
        requestId: "r5",
      };
      const browser = makeBrowserMockWithMessaging({
        nativeResponses: [
          { type: "tool_request", payload: JSON.stringify(payload) },
          { type: "idle" },
        ],
      });

      loadBackground({ browser });

      await Promise.resolve();
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      const indicatorCalls = browser.tabs.sendMessage.mock.calls
        .filter(([, msg]) => msg && msg.type === "CLAUDE_AGENT_INDICATOR");
      expect(indicatorCalls.length).toBe(0);
    });

    // T_ind5 — screenshot: hide_for_tool before executeTool, show_after_tool after
    test("T_ind5: screenshot action sends hide_for_tool before and show_after_tool after executeTool", async () => {
      const calls = [];
      const payload = {
        tool: "computer",
        args: { action: "screenshot", tabId: 5 },
        requestId: "r6",
      };
      const browser = makeBrowserMockWithMessaging({
        nativeResponses: [
          { type: "tool_request", payload: JSON.stringify(payload) },
          { type: "idle" },
        ],
      });
      const executeTool = jest.fn(async () => {
        calls.push("executeTool");
        return { result: { content: [{ type: "text", text: "screenshot done" }] } };
      });
      browser.tabs.sendMessage = jest.fn(async (_tabId, msg) => {
        if (msg && msg.action) calls.push("sendMessage:" + msg.action);
      });

      loadBackground({ browser, executeTool });

      await Promise.resolve();
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const hideForTool   = calls.indexOf("sendMessage:hide_for_tool");
      const executeIdx    = calls.indexOf("executeTool");
      const showAfterTool = calls.indexOf("sendMessage:show_after_tool");

      expect(hideForTool).toBeGreaterThanOrEqual(0);
      expect(executeIdx).toBeGreaterThan(hideForTool);
      expect(showAfterTool).toBeGreaterThan(executeIdx);
    });
  });
  ```

- [ ] **Run new tests to confirm they fail; existing T1-T12 still pass**
  ```bash
  npx jest Tests/JS/background.test.js --no-coverage
  ```
  Expected: T1-T12 PASS, T_ind1-T_ind5 FAIL.

- [ ] **Add module-level state variables to `background.js`** (after `let pollTimer = null;`):

  ```js
  // ── Indicator state ───────────────────────────────────────────────────────
  var currentRequestId   = null; // requestId of the in-flight extension-forwarded tool call
  var currentToolTabId   = null; // tabId of the in-flight tool call
  var hideIndicatorTimer = null; // debounce timer handle for post-tool indicator hide
  ```

- [ ] **Add helper functions to `background.js`** (add directly before `function pollForRequests()`):

  ```js
  // Screenshot/zoom actions must suppress the glow border so it does not appear
  // in ScreenCaptureKit captures.
  var SCREENSHOT_ACTIONS = { screenshot: true, zoom: true };

  /**
   * Re-inject the indicator content script (idempotent via installation guard),
   * then send the show message. Both steps are fire-and-forget: failures are
   * logged as warnings and must never block tool execution.
   */
  async function showIndicatorOnTab(tabId) {
    try {
      await browser.tabs.executeScript(tabId, {
        file: "content-scripts/agent-visual-indicator.js",
      });
    } catch (e) {
      console.warn("indicator: re-inject failed (non-critical):", e && e.message);
    }
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "CLAUDE_AGENT_INDICATOR",
        action: "show",
      });
    } catch (e) {
      console.warn("indicator: show message failed (non-critical):", e && e.message);
    }
  }

  /**
   * Send the hide message to a tab. Failure is non-critical.
   */
  async function hideIndicatorOnTab(tabId) {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "CLAUDE_AGENT_INDICATOR",
        action: "hide",
      });
    } catch (e) {
      console.warn("indicator: hide message failed (non-critical):", e && e.message);
    }
  }

  /**
   * Schedule a hide 500ms from now. Cancels any pending hide so rapid back-to-back
   * tool calls keep the indicator visible throughout the sequence.
   */
  function scheduleHideIndicator(tabId) {
    if (hideIndicatorTimer !== null) clearTimeout(hideIndicatorTimer);
    hideIndicatorTimer = setTimeout(function () {
      hideIndicatorTimer = null;
      if (tabId != null) hideIndicatorOnTab(tabId);
    }, 500);
  }
  ```

- [ ] **Replace Phase 3 in `pollForRequests`**

  Find the existing Phase 3 comment and the `let result;` declaration that follows it. Replace the entire Phase 3 block (from the comment to and including the `catch (error) { ... return; }` block) with:

  ```js
  // Phase 3: execute the tool
  // IMPORTANT: Yield to the event loop before executing the tool.
  // Safari MV2 restricts browser.tabs.query (and possibly other tab APIs)
  // when called from within a sendNativeMessage response handler. By
  // dispatching via setTimeout(0), the tool runs in a fresh macrotask
  // (next task queue entry) outside the native-messaging callback's current turn.
  // NOTE: This pattern is safe only because "persistent": true prevents the
  // background page from being torn down between setTimeout scheduling and
  // callback execution.
  const toolTabId = (payload.args && payload.args.tabId != null)
    ? payload.args.tabId
    : null;
  const isScreenshotTool = payload.tool === "computer" &&
    !!(payload.args && SCREENSHOT_ACTIONS[payload.args.action]);

  // Show indicator before the tool runs (fire-and-forget; never blocks execution).
  if (toolTabId != null) {
    if (hideIndicatorTimer !== null) {
      clearTimeout(hideIndicatorTimer);
      hideIndicatorTimer = null;
    }
    if (isScreenshotTool) {
      // Suppress glow immediately so ScreenCaptureKit does not capture it.
      browser.tabs.sendMessage(toolTabId, {
        type: "CLAUDE_AGENT_INDICATOR",
        action: "hide_for_tool",
      }).catch(function () {});
    } else {
      showIndicatorOnTab(toolTabId);
    }
  }

  currentRequestId = payload.requestId;
  currentToolTabId = toolTabId;

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve(await globalThis.executeTool(payload.tool, payload.args, payload.context));
        } catch (e) {
          reject(e);
        }
      }, 0);
    });

    // Check whether this request was cancelled by the Stop handler while the
    // tool was running. If so, the indicator is already hidden and the error
    // response has already been sent — skip Phase 4.
    if (currentRequestId === null) {
      currentToolTabId = null;
      isActive = false;
      return;
    }
    currentRequestId = null;

    // Post-tool indicator: restore (screenshot) or schedule hide (all others).
    if (toolTabId != null) {
      if (isScreenshotTool) {
        browser.tabs.sendMessage(toolTabId, {
          type: "CLAUDE_AGENT_INDICATOR",
          action: "show_after_tool",
        }).catch(function () {});
      } else {
        scheduleHideIndicator(toolTabId);
      }
    }
  } catch (error) {
    console.error("Poll: tool execution error for", payload.tool, ":", error);
    currentRequestId = null;
    scheduleHideIndicator(currentToolTabId);
    try {
      await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
        type: "tool_response",
        requestId: payload.requestId,
        error: { content: [{ type: "text", text: `Internal error executing ${payload.tool}: ${error.message || String(error)}` }] },
      });
    } catch (sendErr) {
      console.error("Poll: also failed to send error response:", sendErr);
    }
    isActive = false;
    return;
  }
  ```

- [ ] **Run background.js tests — T1-T12 and T_ind1-T_ind5 all pass**
  ```bash
  npx jest Tests/JS/background.test.js --no-coverage
  ```

- [ ] **Commit**
  ```bash
  git add "ClaudeInSafari Extension/Resources/background.js" \
          "Tests/JS/background.test.js"
  git commit -m "feat(indicator): background.js show/hide hooks + screenshot suppression with T_ind1-T_ind5 tests"
  ```

---

### Task 7: background.js — STOP_AGENT + heartbeat handler (TDD)

**Files:**
- Modify: `Tests/JS/background.test.js` — add T_stop1, T_stop2, T_heartbeat1
- Modify: `ClaudeInSafari Extension/Resources/background.js` — add `browser.runtime.onMessage` listener

- [ ] **Add T_stop1, T_stop2, T_heartbeat1 inside the indicator describe block** (append before its closing `});`):

  ```js
  // T_stop1 — STOP_AGENT while in-flight: error tool_response sent
  test("T_stop1: STOP_AGENT while currentRequestId set sends error tool_response with Cancelled by user", async () => {
    const payload = {
      tool: "navigate",
      args: { url: "https://slow.example.com", tabId: 9 },
      requestId: "req-stop-1",
    };
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [
        { type: "tool_request", payload: JSON.stringify(payload) },
        { type: "idle" },
      ],
    });

    // executeTool hangs until explicitly resolved by the test
    let resolveExec;
    const execPromise = new Promise(function (res) { resolveExec = res; });
    const executeTool = jest.fn(() => execPromise);

    const onMessage = loadBackgroundWithMessaging({ browser, executeTool });

    await Promise.resolve(); // Phase 1 poll resolves, Phase 3 setup runs
    jest.runAllTimers();     // setTimeout(0) fires -> executeTool called (hangs)
    await Promise.resolve(); // setTimeout(0) callback started; currentRequestId is now set

    // Simulate Stop button click from content script
    onMessage({ type: "STOP_AGENT" }, { tab: { id: 9 } }, jest.fn());
    await Promise.resolve();
    await Promise.resolve();

    const cancelCalls = browser.runtime.sendNativeMessage.mock.calls
      .filter(([, msg]) => msg.type === "tool_response" && msg.error);
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(cancelCalls[0][1].requestId).toBe("req-stop-1");
    expect(cancelCalls[0][1].error.content[0].text).toContain("Cancelled by user");

    // Clean up the hanging promise so Jest does not leak
    resolveExec({ result: { content: [{ type: "text", text: "late result" }] } });
    await execPromise;
  });

  // T_stop2 — STOP_AGENT with no in-flight request: no extra tool_response sent
  test("T_stop2: STOP_AGENT with no in-flight request sends no tool_response", async () => {
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [{ type: "idle" }],
    });
    const onMessage = loadBackgroundWithMessaging({ browser });

    await Promise.resolve(); // idle poll

    const beforeCount = browser.runtime.sendNativeMessage.mock.calls
      .filter(([, msg]) => msg.type === "tool_response").length;

    onMessage({ type: "STOP_AGENT" }, { tab: { id: 1 } }, jest.fn());
    await Promise.resolve();

    const afterCount = browser.runtime.sendNativeMessage.mock.calls
      .filter(([, msg]) => msg.type === "tool_response").length;
    expect(afterCount).toBe(beforeCount);
  });

  // T_heartbeat1 — STATIC_INDICATOR_HEARTBEAT: sendResponse({ success: true })
  test("T_heartbeat1: STATIC_INDICATOR_HEARTBEAT calls sendResponse with success: true", async () => {
    const browser = makeBrowserMockWithMessaging({
      nativeResponses: [{ type: "idle" }],
    });
    const onMessage = loadBackgroundWithMessaging({ browser });

    await Promise.resolve();

    const sendResponse = jest.fn();
    onMessage({ type: "STATIC_INDICATOR_HEARTBEAT" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });
  ```

- [ ] **Run tests — expect T_stop1, T_stop2, T_heartbeat1 to fail**
  ```bash
  npx jest Tests/JS/background.test.js --no-coverage -t "STOP_AGENT|heartbeat"
  ```

- [ ] **Add `browser.runtime.onMessage.addListener` to `background.js`**

  Insert this block after the `if (typeof browser.alarms !== "undefined") { ... }` block, before the `pollForRequests()` call at the bottom:

  ```js
  // Handle messages from content scripts (Stop button, heartbeat, dismiss).
  // Guard: browser.runtime.onMessage may be absent in test environments that
  // use the minimal makeBrowserMock (which only provides sendNativeMessage).
  if (typeof browser.runtime !== "undefined" && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message.type === "STATIC_INDICATOR_HEARTBEAT") {
        sendResponse({ success: true });
        return true; // keep channel open for synchronous sendResponse
      }

      if (message.type === "STOP_AGENT") {
        // Cancel the in-flight extension-forwarded tool call by injecting an error
        // tool_response. ToolRouter picks it up via its normal poll loop — no new
        // native message type is required.
        var reqId = currentRequestId;
        if (reqId) {
          currentRequestId = null;
          browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
            type: "tool_response",
            requestId: reqId,
            error: { content: [{ type: "text", text: "Cancelled by user" }] },
          }).catch(function (e) {
            console.warn("indicator: failed to send cancel response:", e && e.message);
          });
        }
        // Hide on the tab that sent Stop, or the current tool's tab
        var senderTabId = sender && sender.tab && sender.tab.id;
        var tabToHide   = (senderTabId != null) ? senderTabId : currentToolTabId;
        if (tabToHide != null) hideIndicatorOnTab(tabToHide);

        sendResponse({ success: true });
        return true;
      }

      if (message.type === "DISMISS_STATIC_INDICATOR_FOR_GROUP") {
        // No-op for PR A — full tab-group iteration deferred to PR B
        sendResponse({ success: true });
        return true;
      }
    });
  }
  ```

- [ ] **Run all background.js tests — all pass**
  ```bash
  npx jest Tests/JS/background.test.js --no-coverage
  ```
  Expected: T1-T12 (existing) + T_ind1-T_ind5 + T_stop1-T_stop2 + T_heartbeat1 all PASS.

- [ ] **Commit**
  ```bash
  git add "ClaudeInSafari Extension/Resources/background.js" \
          "Tests/JS/background.test.js"
  git commit -m "feat(indicator): STOP_AGENT handler + heartbeat response with T_stop1-T_stop2 T_heartbeat1 tests"
  ```

---

### Task 8: Full verification + PR

- [ ] **Run the complete JS test suite — no regressions**
  ```bash
  npx jest --no-coverage
  ```
  Expected: all tests pass. Count should be the prior total (134) plus the ~22 new tests added here.

- [ ] **Build to verify JS-only changes compile cleanly**
  ```bash
  make build
  ```
  Expected: `BUILD SUCCEEDED`.

- [ ] **Run Xcode test suite**
  ```bash
  xcodebuild test -scheme ClaudeInSafari -destination "platform=macOS" 2>&1 | tail -20
  ```
  Expected: all Swift tests PASS (no Swift files changed).

- [ ] **Verify load-order comment in background.js is still accurate** — no new background scripts were added, so the comment should be unchanged. Confirm by comparing the comment at the top of `background.js` against `manifest.json` background.scripts.

- [ ] **Create PR**
  ```bash
  git push -u origin feature/020-agent-visual-indicator
  ```
  Then open the PR via `gh pr create` with title:
  `feat(indicator): agent visual indicator overlay (Spec 020, PR A)`

  Body summary:
  - Implements pulsing orange glow border and Stop Claude button (Spec 020)
  - Implements static "Claude is active" pill bar with Chat and Dismiss buttons
  - background.js shows indicator before each tool call, hides with 500ms debounce
  - Stop button cancels in-flight tool via existing tool_response IPC (no new message type)
  - Screenshot/zoom suppression: hide_for_tool before, show_after_tool after
  - Shadow DOM (open mode) isolates indicator CSS from page styles
  - 22 new JS tests; all 134 prior tests continue to pass

  Test plan checklist:
  - Run `npx jest --no-coverage` — all tests pass
  - Run `make build` — BUILD SUCCEEDED
  - Run `make dev`, navigate to any page — no glow border visible at rest
  - Run `make send TOOL=navigate ARGS='{"url":"https://example.com"}'` — glow border appears briefly then fades
  - Click Stop Claude button — border disappears, automation halts
  - Confirm glow absent in screenshots: `make send TOOL=computer ARGS='{"action":"screenshot"}'`
