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
