# Bridge Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pre-release validation that the safari-mcp-bridge works correctly with both Claude Code CLI and Claude Desktop, catching the class of bug that shipped in v1.2.1.

**Architecture:** A standalone Python script (`scripts/validate-bridge.py`) with three validation levels (`--check-binary`, `--check-config`, `--check-relay`) that simulate how real MCP clients invoke the bridge. Integrated into local dev via Makefile targets and into CI for automated checks.

**Tech Stack:** Python 3 (matches existing `mcp-test.py`), Makefile, GitHub Actions YAML

**Spec:** `docs/specs/028-bridge-validation.md`

---

### Task 1: Create `scripts/validate-bridge.py` — argument parsing and helpers

**Files:**
- Create: `scripts/validate-bridge.py`

- [ ] **Step 1: Create the script with argument parsing and shared helpers**

```python
#!/usr/bin/env python3
"""
Bridge validation for Claude in Safari.

Validates that the safari-mcp-bridge binary works correctly with both
Claude Code CLI and Claude Desktop by checking the binary, config files,
and performing a full MCP relay test.

Usage:
    ./scripts/validate-bridge.py                     # Run all possible checks
    ./scripts/validate-bridge.py --check-binary PATH # Validate bridge binary
    ./scripts/validate-bridge.py --check-config      # Validate client configs
    ./scripts/validate-bridge.py --check-relay       # Test MCP relay via stdio
"""

import argparse
import glob
import json
import os
import select
import subprocess
import sys
import time

# --- Config paths ---

HOME = os.path.expanduser("~")
APP_GROUP_ID = "group.com.chriscantu.claudeinsafari"
SOCKET_DIR = os.path.join(HOME, "Library", "Group Containers", APP_GROUP_ID, "sockets")

CONFIG_PATHS = [
    ("Claude Code CLI", os.path.join(HOME, ".claude.json")),
    ("Claude Desktop", os.path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")),
]

MCP_SERVER_KEY = "claude-in-safari"


# --- Output helpers ---

def ok(msg):
    print(f"  [ok] {msg}")

def fail(msg):
    print(f"  [!!] {msg}")

def warn(msg):
    print(f"  [--] {msg}")

def header(title):
    print(f"\n{title}")


def find_newest_socket():
    """Find the newest .sock file in the App Group socket directory."""
    if not os.path.isdir(SOCKET_DIR):
        return None
    socks = glob.glob(os.path.join(SOCKET_DIR, "*.sock"))
    if not socks:
        return None
    return max(socks, key=os.path.getmtime)


def read_bridge_path_from_config():
    """Read the bridge binary path from the first available config file."""
    for name, path in CONFIG_PATHS:
        if not os.path.isfile(path):
            continue
        try:
            with open(path) as f:
                config = json.load(f)
            cmd = config.get("mcpServers", {}).get(MCP_SERVER_KEY, {}).get("command")
            if cmd:
                return cmd
        except (json.JSONDecodeError, KeyError):
            continue
    return None
```

- [ ] **Step 2: Verify the script is syntactically valid**

Run: `python3 -c "import py_compile; py_compile.compile('scripts/validate-bridge.py', doraise=True)"`
Expected: No output (clean compile)

- [ ] **Step 3: Commit**

```
git add scripts/validate-bridge.py
git commit -m "feat(028): scaffold validate-bridge.py with arg parsing and helpers"
```

---

### Task 2: Implement `--check-binary`

**Files:**
- Modify: `scripts/validate-bridge.py`

- [ ] **Step 1: Add the `check_binary` function**

Append after the helpers:

```python
# --- Check: Binary ---

def check_binary(binary_path):
    """Validate the bridge binary exists, is executable, and runs --status."""
    header(f"Binary: {binary_path}")
    errors = 0

    # Exists?
    if not os.path.isfile(binary_path):
        fail(f"not found at {binary_path}")
        return 1

    # Executable?
    if not os.access(binary_path, os.X_OK):
        fail("file exists but is not executable")
        return 1
    ok("exists and executable")

    # Runs --status?
    try:
        result = subprocess.run(
            [binary_path, "--status"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            fail(f"--status exited with code {result.returncode}")
            if result.stderr:
                fail(f"  stderr: {result.stderr.strip()}")
            return 1

        # Check expected output markers
        output = result.stdout
        for marker in ["Bridge:", "Socket dir:"]:
            if marker not in output:
                fail(f"--status output missing expected marker: '{marker}'")
                errors += 1

        if errors == 0:
            ok("--status runs cleanly")
    except subprocess.TimeoutExpired:
        fail("--status timed out after 5s")
        return 1
    except OSError as e:
        fail(f"failed to execute: {e}")
        return 1

    return errors
```

- [ ] **Step 2: Test against the installed binary**

Run: `python3 scripts/validate-bridge.py --check-binary "/Applications/Claude in Safari.app/Contents/MacOS/safari-mcp-bridge"`
Expected: Shows `[ok] exists and executable` and `[ok] --status runs cleanly`

- [ ] **Step 3: Test against a nonexistent path**

Run: `python3 scripts/validate-bridge.py --check-binary /tmp/nonexistent-binary`
Expected: Shows `[!!] not found` and exits 1

- [ ] **Step 4: Test against a non-executable file**

Run: `touch /tmp/not-executable && chmod -x /tmp/not-executable && python3 scripts/validate-bridge.py --check-binary /tmp/not-executable; rm /tmp/not-executable`
Expected: Shows `[!!] file exists but is not executable` and exits 1

- [ ] **Step 5: Commit**

```
git add scripts/validate-bridge.py
git commit -m "feat(028): add --check-binary validation"
```

---

### Task 3: Implement `--check-config`

**Files:**
- Modify: `scripts/validate-bridge.py`

- [ ] **Step 1: Add the `check_config` function**

Append after `check_binary`:

```python
# --- Check: Config ---

def check_config():
    """Validate MCP config files for both Claude Code CLI and Desktop."""
    errors = 0
    command_paths = []

    for name, path in CONFIG_PATHS:
        header(f"Config: {name} ({path})")

        if not os.path.isfile(path):
            warn(f"config file not found (client may not be installed)")
            continue

        # Valid JSON?
        try:
            with open(path) as f:
                config = json.load(f)
        except json.JSONDecodeError as e:
            fail(f"invalid JSON: {e}")
            errors += 1
            continue

        # Has mcpServers.claude-in-safari?
        servers = config.get("mcpServers", {})
        entry = servers.get(MCP_SERVER_KEY)
        if not entry:
            fail(f"no '{MCP_SERVER_KEY}' entry in mcpServers")
            errors += 1
            continue
        ok(f"{MCP_SERVER_KEY} entry present")

        # Command path valid?
        cmd = entry.get("command", "")
        if not cmd:
            fail("command field is empty")
            errors += 1
            continue
        if not os.path.isfile(cmd):
            fail(f"command path does not exist: {cmd}")
            errors += 1
            continue
        if not os.access(cmd, os.X_OK):
            fail(f"command path is not executable: {cmd}")
            errors += 1
            continue
        ok("command path exists and executable")
        command_paths.append(cmd)

    # Cross-check: both configs should point to same binary
    if len(command_paths) == 2:
        if command_paths[0] == command_paths[1]:
            ok("both configs point to same binary")
        else:
            warn(f"configs point to different binaries:")
            warn(f"  CLI:     {command_paths[0]}")
            warn(f"  Desktop: {command_paths[1]}")

    return errors
```

- [ ] **Step 2: Test with installed configs**

Run: `python3 scripts/validate-bridge.py --check-config`
Expected: Both configs show `[ok]` entries

- [ ] **Step 3: Commit**

```
git add scripts/validate-bridge.py
git commit -m "feat(028): add --check-config validation"
```

---

### Task 4: Implement `--check-relay`

**Files:**
- Modify: `scripts/validate-bridge.py`

- [ ] **Step 1: Add the `check_relay` function**

Append after `check_config`:

```python
# --- Check: Relay ---

def check_relay(bridge_path=None):
    """Spawn the bridge as a subprocess and perform MCP handshake over stdio."""
    header("Relay: spawning bridge as subprocess (simulating Claude Desktop)")

    # Resolve bridge path
    if not bridge_path:
        bridge_path = read_bridge_path_from_config()
    if not bridge_path:
        fail("cannot determine bridge path (no config found and no --bridge-path given)")
        return 1
    if not os.path.isfile(bridge_path):
        fail(f"bridge binary not found: {bridge_path}")
        return 1

    # Check socket exists (app must be running)
    if not find_newest_socket():
        fail(f"no socket in {SOCKET_DIR} — is Claude in Safari running?")
        return 1

    # Activate Safari (required for extension to be responsive)
    try:
        subprocess.run(
            ["osascript", "-e", 'tell application "Safari" to activate'],
            capture_output=True, timeout=5
        )
        time.sleep(2)
        ok("Safari activated")
    except (subprocess.TimeoutExpired, OSError):
        warn("could not activate Safari — relay may fail if Safari is not frontmost")

    # Spawn bridge subprocess
    try:
        proc = subprocess.Popen(
            [bridge_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as e:
        fail(f"failed to launch bridge: {e}")
        return 1
    ok("process started")

    errors = 0
    # Shared buffer across recv() calls — prevents data loss when the bridge
    # sends multiple newline-delimited messages in one TCP segment.
    leftover = b""

    try:
        # Helper: send newline-delimited JSON
        def send(msg):
            data = (json.dumps(msg) + "\n").encode("utf-8")
            proc.stdin.write(data)
            proc.stdin.flush()

        # Helper: read one newline-delimited JSON response (with timeout)
        def recv(timeout_sec=10):
            nonlocal leftover
            # Check leftover from previous read first
            if b"\n" in leftover:
                line, leftover = leftover.split(b"\n", 1)
                return json.loads(line.decode("utf-8"))
            deadline = time.time() + timeout_sec
            while time.time() < deadline:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                ready, _, _ = select.select([proc.stdout], [], [], min(remaining, 0.5))
                if ready:
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        return None  # EOF
                    leftover += chunk
                    if b"\n" in leftover:
                        line, leftover = leftover.split(b"\n", 1)
                        return json.loads(line.decode("utf-8"))
            return None

        # Step 1: MCP initialize
        send({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "validate-bridge", "version": "1.0.0"},
            },
        })
        resp = recv()
        if not resp or "result" not in resp:
            fail("MCP initialize failed — no response from bridge")
            return 1

        result = resp.get("result", {})
        server_info = result.get("serverInfo", {})
        proto = result.get("protocolVersion", "?")
        if not server_info.get("name"):
            fail("MCP initialize response missing serverInfo")
            errors += 1
        else:
            ok(f"MCP initialize handshake (server: {server_info['name']} v{server_info.get('version', '?')}, protocol: {proto})")

        # Step 2: notifications/initialized
        send({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })
        time.sleep(0.1)

        # Step 3: tools/list
        send({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {},
        })
        resp = recv()
        if not resp or "result" not in resp:
            fail("tools/list failed — no response from bridge")
            return 1

        tools = resp.get("result", {}).get("tools", [])
        if not tools:
            fail("tools/list returned empty tool list")
            errors += 1
        else:
            ok(f"tools/list returned {len(tools)} tools")

    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    return errors
```

- [ ] **Step 2: Start the app and test relay**

Run: `make dev` (if not already running)
Run: `python3 scripts/validate-bridge.py --check-relay`
Expected: All relay steps show `[ok]`

- [ ] **Step 3: Stop the app and test relay failure**

Run: `make kill`
Run: `python3 scripts/validate-bridge.py --check-relay`
Expected: Shows `[!!] no socket` and exits 1

- [ ] **Step 4: Commit**

```
git add scripts/validate-bridge.py
git commit -m "feat(028): add --check-relay MCP handshake validation"
```

---

### Task 5: Add `main()` and default mode

**Files:**
- Modify: `scripts/validate-bridge.py`

- [ ] **Step 1: Add the main function with argument parsing and default mode**

Append at the end of the file:

```python
# --- Main ---

def main():
    parser = argparse.ArgumentParser(
        description="Validate safari-mcp-bridge binary, config, and MCP relay"
    )
    parser.add_argument("--check-binary", metavar="PATH",
                        help="Validate bridge binary at PATH")
    parser.add_argument("--check-config", action="store_true",
                        help="Validate Claude Code and Desktop config files")
    parser.add_argument("--check-relay", action="store_true",
                        help="Spawn bridge and perform MCP handshake over stdio")
    parser.add_argument("--bridge-path", metavar="PATH",
                        help="Override bridge binary path for --check-relay")

    args = parser.parse_args()
    explicit_mode = args.check_binary or args.check_config or args.check_relay

    print("Bridge Validation")
    print("=================")

    total_errors = 0

    # Inferred bridge path for default mode (shared across checks)
    inferred_bridge = None

    # --check-binary
    if args.check_binary:
        total_errors += check_binary(args.check_binary)
    elif not explicit_mode:
        inferred_bridge = read_bridge_path_from_config()
        if inferred_bridge:
            total_errors += check_binary(inferred_bridge)
        else:
            header("Binary: (skipped — no config found to infer path)")
            warn("run with --check-binary PATH to validate a specific binary")

    # --check-config
    if args.check_config or not explicit_mode:
        total_errors += check_config()

    # --check-relay
    if args.check_relay:
        total_errors += check_relay(bridge_path=args.bridge_path)
    elif not explicit_mode:
        if find_newest_socket():
            total_errors += check_relay(bridge_path=args.bridge_path or inferred_bridge)
        else:
            header("Relay: skipped (no running app — run make validate-bridge with app running)")

    # Summary
    print()
    if total_errors == 0:
        print("All checks passed.")
    else:
        print(f"{total_errors} check(s) failed.")
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x scripts/validate-bridge.py`

- [ ] **Step 3: Test default mode with app running**

Run: `make dev` (if not running)
Run: `python3 scripts/validate-bridge.py`
Expected: All three sections appear with `[ok]` results

- [ ] **Step 4: Test default mode with app stopped**

Run: `make kill`
Run: `python3 scripts/validate-bridge.py`
Expected: Binary + config pass, relay shows "skipped"

- [ ] **Step 5: Commit**

```
git add scripts/validate-bridge.py
git commit -m "feat(028): add default mode and main() entry point"
```

---

### Task 6: Add Makefile targets

**Files:**
- Modify: `Makefile:1-2` (usage header)
- Modify: `Makefile:48-50` (`.PHONY`)
- Modify: `Makefile` (new targets section)

- [ ] **Step 1: Add `validate-bridge` and `pre-release` to the usage header**

In `Makefile`, after line 19 (`#   make kill ...`), add:

```
#   make validate-bridge Validate bridge binary, configs, and relay
#   make pre-release     Full pre-release check (tests + bridge validation)
```

- [ ] **Step 2: Add to `.PHONY`**

In `Makefile` line 48-50, append `validate-bridge pre-release` to the `.PHONY` list:

```makefile
.PHONY: dev build run kill test test-swift test-all send list-tools status clean help \
        health doctor queue-clean safari-quit safari-open safari-restart reload-ext functional-check dmg \
        bridge bridge-install bridge-status validate-bridge pre-release
```

- [ ] **Step 3: Add the target definitions**

After the `bridge-status` target (line 182), add:

```makefile
# ---------------------------------------------------------------------------
# Bridge validation
# ---------------------------------------------------------------------------

validate-bridge: ## Validate bridge binary, configs, and MCP relay
	@python3 scripts/validate-bridge.py

pre-release: test-all validate-bridge ## Full pre-release validation (tests + bridge)
	@echo ""
	@echo "=== Pre-release validation passed ==="
	@echo "Ready to tag. Run: scripts/bump-version.sh <version>"
```

- [ ] **Step 4: Test the target**

Run: `make validate-bridge`
Expected: Runs the validation script, shows results

- [ ] **Step 5: Commit**

```
git add Makefile
git commit -m "feat(028): add validate-bridge and pre-release Makefile targets"
```

---

### Task 7: Add CI steps

**Files:**
- Modify: `.github/workflows/ci.yml:155` (after Swift tests)

- [ ] **Step 1: Add bridge validation steps after the Swift test step**

In `.github/workflows/ci.yml`, after the "Run Swift tests" step (line 155), add:

```yaml

      - name: Validate bridge binary
        run: |
          BRIDGE=$(find ~/Library/Developer/Xcode/DerivedData -name safari-mcp-bridge -type f 2>/dev/null | head -1)
          if [ -z "$BRIDGE" ]; then
            echo "::error::safari-mcp-bridge not found in build output"
            exit 1
          fi
          echo "Found bridge: $BRIDGE"
          python3 scripts/validate-bridge.py --check-binary "$BRIDGE"

      - name: Validate config installer round-trip
        run: |
          BRIDGE=$(find ~/Library/Developer/Xcode/DerivedData -name safari-mcp-bridge -type f 2>/dev/null | head -1)
          FAKE_HOME=$(mktemp -d)
          mkdir -p "$FAKE_HOME/.claude"
          mkdir -p "$FAKE_HOME/Library/Application Support/Claude"
          # Run --install with a fake HOME so it writes to temp configs
          HOME="$FAKE_HOME" "$BRIDGE" --install
          # Verify Claude Code config was written correctly
          python3 -c "
          import json, sys
          config = json.load(open('$FAKE_HOME/.claude.json'))
          servers = config.get('mcpServers', {})
          entry = servers.get('claude-in-safari', {})
          cmd = entry.get('command', '')
          if not cmd:
              print('FAIL: no claude-in-safari entry in config')
              sys.exit(1)
          print(f'OK: claude-in-safari configured → {cmd}')
          "
          # Verify Claude Desktop config was written correctly
          python3 -c "
          import json, sys
          config = json.load(open('$FAKE_HOME/Library/Application Support/Claude/claude_desktop_config.json'))
          servers = config.get('mcpServers', {})
          entry = servers.get('claude-in-safari', {})
          cmd = entry.get('command', '')
          if not cmd:
              print('FAIL: no claude-in-safari entry in Desktop config')
              sys.exit(1)
          print(f'OK: Desktop claude-in-safari configured → {cmd}')
          "
          # Verify --uninstall removes the entry
          HOME="$FAKE_HOME" "$BRIDGE" --uninstall
          python3 -c "
          import json, sys
          config = json.load(open('$FAKE_HOME/.claude.json'))
          servers = config.get('mcpServers', {})
          if 'claude-in-safari' in servers:
              print('FAIL: claude-in-safari entry still present after --uninstall')
              sys.exit(1)
          print('OK: --uninstall removed entry')
          "
          rm -rf "$FAKE_HOME"
```

- [ ] **Step 2: Commit**

```
git add .github/workflows/ci.yml
git commit -m "feat(028): add bridge validation CI steps"
```

---

### Task 8: Add regression test Section 16

**Files:**
- Modify: `docs/regression-tests.md:579-605` (before Checklist Summary, add Section 16)

- [ ] **Step 1: Add Section 16 before the Checklist Summary**

In `docs/regression-tests.md`, before line 583 (`## Checklist Summary`), add:

```markdown
## 16  Bridge & Client Integration

### 16.1  Automated validation

```fish
make validate-bridge
```

- [ ] Binary check passes
- [ ] Config check passes (both CLI and Desktop)
- [ ] Relay check passes (MCP handshake + tools/list through bridge)

### 16.2  Claude Code CLI

Open a new terminal and start Claude Code:

```fish
claude
```

Ask: "Use the navigate tool to open https://example.com in Safari"

- [ ] Claude Code invokes the tool successfully
- [ ] Safari navigates to example.com

### 16.3  Claude Desktop

Open Claude Desktop and start a new conversation.

Ask: "Use the navigate tool to open https://example.com in Safari"

- [ ] Claude in Safari appears in Desktop's MCP server list
- [ ] Desktop invokes the tool successfully
- [ ] Safari navigates to example.com

### 16.4  Config consistency

```fish
/Applications/Claude\ in\ Safari.app/Contents/MacOS/safari-mcp-bridge --status
```

- [ ] Claude Code CLI shows `✓ configured`
- [ ] Claude Desktop shows `✓ configured`
- [ ] Both point to the same bridge binary path

---

```

- [ ] **Step 2: Add line 16 to the Checklist Summary**

In the checklist block, after `- [ ] 15. File upload: ...`, add:

```
- [ ] 16. Bridge & client integration: validate-bridge, CLI test, Desktop test
```

- [ ] **Step 3: Commit**

```
git add docs/regression-tests.md
git commit -m "feat(028): add bridge validation to regression test suite"
```

---

### Task 9: Update STRUCTURE.md

**Files:**
- Modify: `STRUCTURE.md:131` (scripts listing)

- [ ] **Step 1: Add `validate-bridge.py` to the scripts listing**

In `STRUCTURE.md`, after line 131 (`│   ├── create-dmg.sh`), add:

```
│   ├── validate-bridge.py              # Bridge binary, config, and MCP relay validation
```

- [ ] **Step 2: Commit**

```
git add STRUCTURE.md
git commit -m "docs(028): add validate-bridge.py to STRUCTURE.md"
```

---

### Task 10: Final integration test

**Files:** (no changes — verification only)

- [ ] **Step 1: Run the full pre-release check**

Run: `make dev` (start app if not running)
Run: `make pre-release`
Expected: JS tests pass, Swift tests pass, bridge validation passes

- [ ] **Step 2: Test individual modes**

Run: `python3 scripts/validate-bridge.py --check-binary "/Applications/Claude in Safari.app/Contents/MacOS/safari-mcp-bridge"`
Expected: Exit 0

Run: `python3 scripts/validate-bridge.py --check-config`
Expected: Exit 0

Run: `python3 scripts/validate-bridge.py --check-relay`
Expected: Exit 0

- [ ] **Step 3: Test failure modes**

Run: `python3 scripts/validate-bridge.py --check-binary /tmp/nonexistent`
Expected: Exit 1

Run: `make kill`
Run: `python3 scripts/validate-bridge.py --check-relay`
Expected: Exit 1 with "no socket" message

- [ ] **Step 4: Verify default mode handles all states**

Run: `python3 scripts/validate-bridge.py` (with app stopped)
Expected: Binary + config pass, relay skipped

Run: `make dev`
Run: `python3 scripts/validate-bridge.py` (with app running)
Expected: All three sections pass
