/**
 * file_upload tool — injects local files into a <input type="file"> element.
 *
 * The native app (FileService + ToolRouter) reads files from disk, base64-encodes
 * them, and injects them as args.files = [{base64, filename, mimeType, size}, ...].
 * This handler validates args, resolves the tab, and runs the injected IIFE.
 * See Spec 019 and docs/plans/2026-03-13-file-upload.md.
 */
(function () {
  'use strict';

  /**
   * Injected into the page via executeScript. Self-contained — no closure refs,
   * no extension APIs. Receives { files, ref } via JSON.stringify serialization.
   * @param {{ files: Array<{base64: string, filename: string, mimeType: string, size: number}>, ref: string }} param0
   */
  function injectedFileUpload({ files, ref }) {
    function err(text) {
      return { isError: true, content: [{ type: 'text', text }] };
    }

    function humanReadableSize(bytes) {
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
      return bytes + ' B';
    }

    function makeFile(base64, filename, mimeType) {
      try {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: mimeType });
        return new File([blob], filename, { type: mimeType, lastModified: Date.now() });
      } catch (e) {
        return null;
      }
    }

    // Resolve element
    const el = document.querySelector('[data-claude-ref="' + CSS.escape(ref) + '"]');
    if (!el) return err("Element '" + ref + "' not found");
    if (el.tagName !== 'INPUT' || el.type !== 'file') return err('Element is not a file input');

    // Multiple-file guard
    if (files.length > 1 && !el.multiple) {
      return err('File input does not support multiple files');
    }

    // Decode all files
    const fileObjects = [];
    for (const descriptor of files) {
      const f = makeFile(descriptor.base64, descriptor.filename, descriptor.mimeType);
      if (!f) return err('Failed to decode file data: ' + descriptor.filename);
      fileObjects.push(f);
    }

    // Inject into input
    const dt = new DataTransfer();
    for (const f of fileObjects) dt.items.add(f);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Build success text
    let text;
    if (files.length === 1) {
      text = 'Uploaded ' + files[0].filename + ' (' + humanReadableSize(files[0].size) + ') to file input ' + ref;
    } else {
      const lines = files.map(d => '  - ' + d.filename + ' (' + humanReadableSize(d.size) + ')');
      text = 'Uploaded ' + files.length + ' files to file input ' + ref + ':\n' + lines.join('\n');
    }

    // Accept attribute validation — warning only, not an error
    const accept = el.accept;
    if (accept) {
      const acceptList = accept.split(',').map(s => s.trim().toLowerCase());
      const mismatched = files.filter(d => {
        const ext = '.' + d.filename.split('.').pop().toLowerCase();
        const mime = d.mimeType.toLowerCase();
        return !acceptList.some(a => a === ext || a === mime || a === mime.split('/')[0] + '/*');
      });
      if (mismatched.length > 0) {
        text += '\nWarning: file input accepts "' + accept + '" — ' + mismatched[0].filename + ' may be rejected by the page';
      }
    }

    return { content: [{ type: 'text', text }] };
  }

  globalThis.registerTool('file_upload', async function fileUpload(args) {
    const { files, ref, tabId } = args;

    if (!ref) {
      return { isError: true, content: [{ type: 'text', text: 'ref parameter is required' }] };
    }
    if (!files || !Array.isArray(files) || files.length === 0) {
      return { isError: true, content: [{ type: 'text', text: 'files not available — native injection failed' }] };
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
        '(' + injectedFileUpload.toString() + ')(' + JSON.stringify({ files, ref }) + ')',
        'file_upload'
      );
    } catch (err) {
      if (err && /was closed during/.test(err.message)) throw err;
      throw globalThis.classifyExecuteScriptError('file_upload', resolvedTabId, err);
    }

    const result = results && results[0];
    if (!result) {
      return { isError: true, content: [{ type: 'text', text: 'No result from injected script' }] };
    }
    return result;
  });
}());
