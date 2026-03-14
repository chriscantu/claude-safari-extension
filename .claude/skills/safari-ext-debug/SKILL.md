---
name: safari-ext-debug
description: Use when the Claude in Safari extension stops working after a code change, build, or Safari restart — specifically when the extension is missing from "Web Extension Background Pages", flashes and disappears, disappears from Safari Settings entirely, or make health fails with timeout.
---

# Safari Extension Debugger

Run the diagnostics below **in order**. Each step takes under 30 seconds. Stop at the first fix that works.

## Step 1 — Run automated diagnostics

```fish
make doctor
```

Read every `[!!]` line. Then continue below based on what you see.

## Step 2 — Check for zombie Xcode debug processes

```fish
ps aux | grep "Claude in Safari" | grep -v grep
```

Look for `TX` in the STAT column. That is a zombie held by Xcode's debugserver.

**If found:**
```fish
make kill   # kills debugserver + zombie automatically
make run
```

Then restart Safari (`make safari-restart`) — pluginkit re-registration alone is NOT enough after a zombie. Restart is required.

## Step 3 — Check codesign validity

```fish
set APP_PATH (xcodebuild -project ClaudeInSafari.xcodeproj -scheme ClaudeInSafari \
    -showBuildSettings 2>/dev/null | grep '^\s*BUILT_PRODUCTS_DIR' | head -1 | awk '{print $3}')
codesign --verify --deep "$APP_PATH/Claude in Safari.app"
```

**If output contains "code has no resources"** — the app has a broken signature from a `clean` build. Fix:
```fish
make build   # incremental build restores valid signature
```
Then relaunch (`make run`). Do NOT run `xcodebuild clean` standalone — always `make clean` or `make build`.

## Step 4 — Check pluginkit registration

```fish
pluginkit -m -i com.chriscantu.claudeinsafari.extension
```

- **Missing entirely** → broken signature (Step 3) or app not launched. Run `make run`.
- **Shows `+` prefix** → force-override is conflicting with Safari. Reset: `pluginkit -e default -i com.chriscantu.claudeinsafari.extension`
- **Shows no prefix (correct)** → registration is fine, continue to Step 5.

## Step 5 — Safari manual checks

These cannot be automated. Both must be true:

1. **Safari → Develop → Allow Unsigned Extensions** ✓ — resets on every Safari restart
2. **Safari → Settings → Extensions → Claude in Safari** ✓ — toggle off then on

After toggling: navigate to any page, then check Develop → Web Extension Background Pages.

## Step 6 — Nuclear restart

If nothing above fixed it:

```fish
make safari-restart
```

Then repeat Step 5 (Allow Unsigned Extensions resets).

---

## Standard Recovery After Any Code Change

**For JavaScript changes** (background.js, tool handlers, content scripts):
```fish
make safari-restart
# Re-enable "Allow Unsigned Extensions" + extension in Settings
make health
```
Safari caches the background page JS — `make kill && make run` is NOT enough for JS changes. A full Safari restart is required.

**For Swift-only changes** (no JS modified):
```fish
make kill && make build && make run && make health
```

If `make health` fails, do Step 5.

---

## Common Wrong Approaches (Baseline Failures)

| Temptation | Why it fails |
|---|---|
| `pluginkit -e use` to force-enable | Conflicts with Safari's native management, prevents background page from loading |
| `kill -9 <zombie_pid>` directly | Zombie is held by debugserver — unkillable until debugserver dies first. Use `make kill`. |
| `xcodebuild clean` then `xcodebuild build` separately | First build after clean produces invalid signature; extension silently disappears |
| pluginkit re-registration after killing zombie | Safari has cached stale state; full Safari restart is required |
| Assuming the JS crashed | If even `console.log("hi")` doesn't load, it's never a JS bug — check Steps 2–5 first |
| `make reload-ext` (pluginkit toggle) as first resort | Only effective for JS changes when extension is already loaded; useless if extension isn't loading at all |
