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

}());
