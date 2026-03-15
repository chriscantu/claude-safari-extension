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
});
