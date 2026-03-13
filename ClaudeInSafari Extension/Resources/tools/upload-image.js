/**
 * upload_image tool — injects a previously captured screenshot into a page
 * element via file input assignment (ref) or synthetic drag-drop (coordinate).
 *
 * imageData (base64 PNG) is injected by ToolRouter before forwarding — no
 * native sub-request is required. See Spec 018 and docs/plans/2026-03-12-upload-image.md.
 */
(function () {
  'use strict';

  /**
   * Injected into the page via executeScript.
   * Runs in the page's JavaScript context — no access to browser extension APIs or globalThis.
   * Receives a plain-object args payload — no closures, no external refs.
   * Returns a tool result object: { content } or { isError, content }.
   */
  function injectedUpload({ imageData, ref, coordinate, filename }) {
    // Returns null on invalid base64 or unsupported file construction — caller checks.
    function makeFile(base64, name) {
      try {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'image/png' });
        return new File([blob], name, { type: 'image/png' });
      } catch (e) {
        return null;
      }
    }

    function err(text) {
      return { isError: true, content: [{ type: 'text', text }] };
    }

    if (ref) {
      const el = document.querySelector('[data-claude-ref="' + CSS.escape(ref) + '"]');
      if (!el) return err("Element '" + ref + "' not found");
      if (el.tagName !== 'INPUT' || el.type !== 'file') return err('Element is not a file input');

      const file = makeFile(imageData, filename);
      if (!file) return err('Failed to decode image data');
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { content: [{ type: 'text', text: 'Image uploaded to file input ' + ref }] };
    }

    // coordinate path — caller validates coordinate is a 2-element numeric array
    const [x, y] = coordinate;
    const target = document.elementFromPoint(x, y);
    if (!target) return err('No element at (' + x + ', ' + y + ')');

    const file = makeFile(imageData, filename);
    if (!file) return err('Failed to decode image data');
    const dt = new DataTransfer();
    dt.items.add(file);

    function dragEvent(type) {
      return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    }
    target.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragenter'));
    target.dispatchEvent(dragEvent('dragover'));
    target.dispatchEvent(dragEvent('drop'));
    target.dispatchEvent(dragEvent('dragend'));

    return { content: [{ type: 'text', text: 'Image uploaded via drag-drop at (' + x + ', ' + y + ')' }] };
  }

  globalThis.registerTool('upload_image', async function uploadImage(args) {
    const {
      imageId,
      imageData,
      ref,
      coordinate,
      tabId,
      filename = 'image.png'
    } = args;

    if (!imageId) {
      return { isError: true, content: [{ type: 'text', text: 'imageId parameter is required' }] };
    }
    if (!imageData) {
      return { isError: true, content: [{ type: 'text', text: 'imageData not available for imageId: ' + imageId }] };
    }
    if (ref && coordinate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide either ref or coordinate, not both' }] };
    }
    if (!ref && !coordinate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide ref or coordinate' }] };
    }
    if (coordinate && (!Array.isArray(coordinate) || coordinate.length !== 2 ||
        typeof coordinate[0] !== 'number' || typeof coordinate[1] !== 'number')) {
      return { isError: true, content: [{ type: 'text', text: 'coordinate must be an array of two numbers [x, y]' }] };
    }

    const resolvedTabId = await globalThis.resolveTab(tabId);
    if (resolvedTabId === null || resolvedTabId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Cannot access tab ' + tabId }] };
    }

    // If the tab is removed mid-execution Safari may never settle the executeScript
    // promise, blocking the tool. executeScriptWithTabGuard provides an onRemoved
    // guard, settled-flag race prevention, and a 30s timeout (defined in
    // tool-registry.js executeScriptWithTabGuard).
    // @note MV2 non-persistent risk: see executeScriptWithTabGuard JSDoc in tool-registry.js
    // for background-page suspension caveats.
    let results;
    try {
      results = await globalThis.executeScriptWithTabGuard(
        resolvedTabId,
        '(' + injectedUpload.toString() + ')(' + JSON.stringify({ imageData, ref, coordinate, filename }) + ')',
        'upload_image'
      );
    } catch (err) {
      if (err && /was closed during/.test(err.message)) throw err;
      throw globalThis.classifyExecuteScriptError('upload_image', resolvedTabId, err);
    }

    const result = results && results[0];
    if (!result) {
      return { isError: true, content: [{ type: 'text', text: 'No result from injected script' }] };
    }
    return result;
  });
}());
