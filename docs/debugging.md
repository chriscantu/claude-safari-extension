# Safari Extension Debugging Guide

Hard-won lessons from debugging the Claude in Safari extension. Read this before spending
more than 5 minutes troubleshooting "why isn't the extension loading?"

---

## Symptom: Extension not in "Web Extension Background Pages"

Work through this checklist in order — each step takes under 30 seconds.

### Step 1 — Check Allow Unsigned Extensions

Safari → Develop → Allow Unsigned Extensions must be **checked**.

**This resets every time Safari quits.** It is not a one-time setting.

### Step 2 — Check extension enabled in Settings

Safari → Settings → Extensions → Claude in Safari must be **checked**.

### Step 3 — Check for zombie Xcode debug processes

This is the most common cause after running the app from Xcode.

```fish
ps aux | grep "Claude in Safari" | grep -v grep
```

Look for processes in `TX` state (Traced/stopped). These are held by Xcode's debugserver
and **cannot be killed with `kill -9`** until the debugserver is killed first.

```fish
# Find and kill the debugserver holding the zombie
ps -eo pid,ppid,state,comm | grep -i "claude\|debug"
kill -9 <debugserver_pid>
sleep 0.5
kill -9 <zombie_pid>
```

`make kill` handles this automatically. Always use `make kill` instead of `pkill` directly.

### Step 4 — Check pluginkit registration

```fish
pluginkit -m -i com.chriscantu.claudeinsafari.extension
```

If our extension is **missing** from the output, the app bundle has a broken signature
(see "Clean Build Signature Bug" below). Fix: run `make build` (not `make clean build`).

If it shows with a `+` prefix (force-enabled), reset it:
```fish
pluginkit -e default -i com.chriscantu.claudeinsafari.extension
```
The `+` state can conflict with Safari's own extension management. Other extensions show
no prefix — ours should too.

### Step 5 — Verify codesign

```fish
APP_PATH=(xcodebuild -project ClaudeInSafari.xcodeproj -scheme ClaudeInSafari \
    -showBuildSettings 2>/dev/null | grep '^\s*BUILT_PRODUCTS_DIR' | head -1 | awk '{print $3}')
codesign --verify --deep "$APP_PATH/Claude in Safari.app"
```

If this prints `"code has no resources but signature indicates they must be present"` — the
app has an invalid signature. Run `make build` to fix (see "Clean Build Signature Bug").

### Step 6 — Restart Safari

If pluginkit shows the extension but it still doesn't appear in Background Pages, Safari
has cached stale extension state. A full Safari restart is required.

```fish
make safari-restart
```

Then repeat steps 1–2 (Allow Unsigned Extensions resets on Safari restart).

---

## Clean Build Signature Bug

**Never run `xcodebuild clean` alone.** The first build after a clean produces a broken
app signature: `"code has no resources but signature indicates they must be present"`.
This causes pluginkit to silently drop the extension registration — the extension
disappears from Safari Settings entirely.

**Wrong:**
```fish
xcodebuild clean
xcodebuild build   # ← broken signature, extension disappears
```

**Correct:**
```fish
xcodebuild clean build   # single invocation — Xcode handles signing correctly
# OR just:
make build               # incremental build, never breaks signing
```

The `make clean` target now runs `xcodebuild clean build` in one shot to avoid this.

---

## pluginkit -e use/ignore Breaks Extension Loading

Using `pluginkit -e use -i <bundle>` (force-enable) or `pluginkit -e ignore -i <bundle>`
(force-disable) **conflicts with Safari's native extension management** and can prevent
the background page from loading entirely.

Other Safari extensions (Dark Reader, Okta) have no pluginkit override — Safari manages
them natively. We must do the same.

**Wrong:** The old `make reload-ext` used `pluginkit -e ignore` then `pluginkit -e use`.
**Fixed:** `make reload-ext` now uses `pluginkit -e default` to reset to native management.

---

## Safari Must Be Frontmost for executeScript Tools

`browser.tabs.executeScript` silently fails if Safari is not the frontmost app. This
affects: `computer`, `javascript_tool`, `read_console_messages`, `read_network_requests`,
`upload_image`, `file_upload`.

`make send` activates Safari via `osascript` before each call. If using `mcp-test.py`
directly, activate Safari first.

---

## Extension Flashes and Disappears

The toolbar icon briefly appears then vanishes when enabling the extension. This means
Safari IS trying to load the extension but it crashes immediately. Common causes:

1. **Zombie Xcode process** — most common. See Step 3 above.
2. **Broken app signature** — see "Clean Build Signature Bug" above.
3. **Stale Safari state** — do a full Safari restart.

Background page crashes do NOT generate crash reports in `~/Library/Logs/DiagnosticReports`
because the background page runs inside Safari's WebContent process.

---

## Standard Recovery Procedure

When the extension stops working after a code change:

```fish
make kill          # kills app + any zombie Xcode debug processes
make build         # incremental build (never breaks signing)
make run           # launches app, creates dev.sock symlink
make health        # verify extension is polling (up to 10s)
```

If `make health` fails:
1. Safari → Develop → Allow Unsigned Extensions ✓
2. Safari → Settings → Extensions → Claude in Safari — toggle off, then on
3. Navigate to any page
4. `make health` again

If still failing: `make safari-restart`, then repeat steps 1–3.
