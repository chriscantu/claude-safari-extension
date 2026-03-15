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

    /**
     * @param {string} base64
     * @param {string} filename
     * @param {string} mimeType
     * @returns {File|{_err: string}}
     */
    function makeFile(base64, filename, mimeType) {
      let bytes;
      try {
        bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      } catch (e) {
        return { _err: 'Invalid base64 data: ' + (e && e.message ? e.message : String(e)) };
      }
      const blob = new Blob([bytes], { type: mimeType });
      return new File([blob], filename, { type: mimeType, lastModified: Date.now() });
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
      if (!f || f._err) return err('Failed to decode file data: ' + descriptor.filename + (f && f._err ? ' (' + f._err + ')' : ''));
      fileObjects.push(f);
    }
    if (fileObjects.length === 0) {
      return err('No files were decoded — files array was empty after processing');
    }

    // Inject into input
    let dt;
    try {
      dt = new DataTransfer();
    } catch (e) {
      return err('DataTransfer API unavailable in this page context: ' + (e && e.message ? e.message : String(e)));
    }
    try {
      for (const f of fileObjects) dt.items.add(f);
    } catch (e) {
      return err('Failed to add file to DataTransfer: ' + (e && e.message ? e.message : String(e)));
    }
    el.files = dt.files;
    if (el.files.length !== fileObjects.length) {
      return err(
        'File assignment failed: the page rejected the FileList ' +
        '(this input may be framework-controlled). ' +
        'Try clicking the file input instead.'
      );
    }
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
        const dotIdx = d.filename.lastIndexOf('.');
        const ext = dotIdx > 0 ? d.filename.slice(dotIdx).toLowerCase() : null;
        const mime = d.mimeType.toLowerCase();
        return !acceptList.some(a => (ext && a === ext) || a === mime || a === mime.split('/')[0] + '/*' || a === '*/*');
      });
      if (mismatched.length > 0) {
        const names = mismatched.map(d => d.filename).join(', ');
        text += '\nWarning: file input accepts "' + accept + '" — ' + names + ' may be rejected by the page';
      }
    }

    return { content: [{ type: 'text', text }] };
  }

  globalThis.registerTool('file_upload', async function fileUpload(args) {
    const { files, ref, tabId } = args;

    if (!ref) {
      return { isError: true, content: [{ type: 'text', text: 'ref parameter is required' }] };
    }
    if (!files || !Array.isArray(files)) {
      return { isError: true, content: [{ type: 'text', text: 'files argument was not populated by the native layer — possible routing bug' }] };
    }
    if (files.length === 0) {
      return { isError: true, content: [{ type: 'text', text: 'files array was empty — no files to upload' }] };
    }

    const resolvedTabId = await globalThis.resolveTab(tabId);
    if (resolvedTabId === null || resolvedTabId === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Cannot access tab ' + (tabId !== undefined ? tabId : '(default)') }] };
    }

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
