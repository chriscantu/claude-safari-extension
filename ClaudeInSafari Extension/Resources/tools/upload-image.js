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
   * Receives a plain-object args payload — no closures, no external refs.
   * Returns a tool result object: { content } or { isError, content }.
   */
  function injectedUpload({ imageData, ref, coordinate, filename }) {
    function makeFile(base64, name) {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      return new File([blob], name, { type: 'image/png' });
    }

    function err(text) {
      return { isError: true, content: [{ type: 'text', text }] };
    }

    if (ref) {
      const el = document.querySelector('[data-claude-ref="' + ref + '"]');
      if (!el) return err("Element '" + ref + "' not found");
      if (el.tagName !== 'INPUT' || el.type !== 'file') return err('Element is not a file input');

      const file = makeFile(imageData, filename);
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { content: [{ type: 'text', text: 'Image uploaded to file input ' + ref }] };
    }

    // coordinate path
    const [x, y] = coordinate;
    const target = document.elementFromPoint(x, y);
    if (!target) return err('No element at (' + x + ', ' + y + ')');

    const file = makeFile(imageData, filename);
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
      return { isError: true, content: [{ type: 'text', text: 'Failed to retrieve image from native app' }] };
    }
    if (ref && coordinate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide either ref or coordinate, not both' }] };
    }
    if (!ref && !coordinate) {
      return { isError: true, content: [{ type: 'text', text: 'Provide ref or coordinate' }] };
    }

    const resolvedTabId = await globalThis.resolveTab(tabId);
    if (resolvedTabId === null || resolvedTabId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Cannot access tab ' + tabId }] };
    }

    let result;
    try {
      const results = await browser.tabs.executeScript(resolvedTabId, {
        code: '(' + injectedUpload.toString() + ')(' + JSON.stringify({ imageData, ref, coordinate, filename }) + ')'
      });
      result = results && results[0];
    } catch (e) {
      const classified = globalThis.classifyExecuteScriptError('upload_image', resolvedTabId, e);
      return { isError: true, content: [{ type: 'text', text: classified.message }] };
    }

    if (!result) {
      return { isError: true, content: [{ type: 'text', text: 'No result from injected script' }] };
    }
    return result;
  });
}());
