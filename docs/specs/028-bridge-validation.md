# Spec 028 — Bridge Validation

## Overview

Pre-release validation that the safari-mcp-bridge binary works correctly with both Claude Code CLI and Claude Desktop. Today's regression suite tests tools via direct socket connection (`mcp-test.py`), completely bypassing the bridge binary that real clients use. This spec adds automated and manual validation of the full client connection path: binary launch, config writing, stdio relay, and MCP handshake.

## Problem

The v1.2.1 release shipped with a working CLI integration but a broken Desktop integration. The failure was not caught because:

1. All automated tests (`npm test`, `xcodebuild test`) test components in isolation
2. The manual regression suite (`docs/regression-tests.md`) tests tools via direct socket, not through the bridge
3. No validation exists for config file correctness, bridge binary invocation, or stdio relay
4. No pre-release checklist item requires testing with Claude Desktop

## Scope

- New script: `scripts/validate-bridge.py`
- Makefile: two new targets (`validate-bridge`, `pre-release`), added to `.PHONY`
- CI: new step in `.github/workflows/ci.yml`
- Regression: new Section 16 in `docs/regression-tests.md`
- Update: `STRUCTURE.md` — add `validate-bridge.py` to scripts listing

No changes to the bridge binary, native app, or extension code.

## Chrome Parity Notes

N/A — this spec adds validation tooling. No browser-facing tools.

## Design

### 1. `scripts/validate-bridge.py`

Standalone Python script with three validation levels, each usable independently via flags.

#### `--check-binary <path>`

Validates the bridge binary itself:

1. File exists at the given path
2. File is executable (`os.access(path, os.X_OK)`)
3. Runs `<binary> --status` as a subprocess — exits with code 0
4. Stdout contains expected markers: `"Bridge:"`, `"Socket dir:"`

Exit: 0 if all pass, 1 with descriptive error on first failure.

Output:
```
Binary: /Applications/Claude in Safari.app/Contents/MacOS/safari-mcp-bridge
  [ok] exists and executable
  [ok] --status runs cleanly
```

#### `--check-config`

Validates both client config files:

1. For each config path (`~/.claude.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`):
   - File exists (skip with warning if not — client may not be installed)
   - JSON is valid
   - `mcpServers.claude-in-safari` key exists
   - `mcpServers.claude-in-safari.command` is a string pointing to an existing, executable file
2. If both configs exist, verify they point to the same bridge binary (warn if divergent)

Exit: 0 if all present configs are valid, 1 if any present config is malformed.

Output:
```
Config: Claude Code CLI (~/.claude.json)
  [ok] claude-in-safari entry present
  [ok] command path exists and executable

Config: Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json)
  [ok] claude-in-safari entry present
  [ok] command path exists and executable
  [ok] both configs point to same binary
```

#### `--check-relay`

Spawns the bridge binary as a subprocess with stdin/stdout pipes (exactly how Claude Desktop invokes it) and performs a full MCP round-trip.

**Prerequisite:** Safari must be the frontmost app and the Claude in Safari app must be running (socket exists). The script activates Safari via `osascript` before starting the relay check.

Steps:

1. Activate Safari via `osascript -e 'tell application "Safari" to activate'` and wait 2s
2. Resolve bridge path from config (`~/.claude.json` → `mcpServers.claude-in-safari.command`), or accept `--bridge-path <path>` override
3. `subprocess.Popen([bridge_path], stdin=PIPE, stdout=PIPE, stderr=PIPE)`
4. Send MCP `initialize` request (newline-delimited JSON) via stdin
5. Read `initialize` response from stdout — verify `jsonrpc`, `result.protocolVersion`, `result.serverInfo`
6. Send `notifications/initialized`
7. Send `tools/list` request
8. Read response — verify `result.tools` is a non-empty array
9. Kill the subprocess

The relay check validates through `tools/list` (step 8) but does **not** issue a tool call. Tool calls require page state and Safari activation timing that varies across environments. The `tools/list` response proves the full stdio↔socket↔native app↔extension pipeline works end-to-end — if the bridge can list tools, it can execute them.

Timeout: 10 seconds for the entire sequence. If any step hangs, report which step timed out.

Exit: 0 if full round-trip completes, 1 with step-level error on failure.

Output:
```
Relay: spawning bridge as subprocess (simulating Claude Desktop)
  [ok] Safari activated
  [ok] process started
  [ok] MCP initialize handshake
  [ok] tools/list returned 14 tools
```

#### Default (no flags)

Runs all checks that are possible given current state:
- `--check-binary`: uses bridge path from config, or searches the App Group socket dir to infer the app path
- `--check-config`: always runs
- `--check-relay`: runs only if a socket exists in the App Group container (app is running); skips with a message otherwise

Combined output shows all sections, with skipped checks clearly marked:
```
Relay: skipped (no running app — run make validate-bridge with app running)
```

### 2. Makefile Targets

Added to the `.PHONY` declaration alongside existing targets:

```makefile
.PHONY: ... validate-bridge pre-release

validate-bridge: ## Validate bridge binary, configs, and MCP relay
	@python3 scripts/validate-bridge.py

pre-release: test-all validate-bridge ## Full pre-release validation
	@echo ""
	@echo "=== Pre-release validation passed ==="
	@echo "Ready to tag. Run: scripts/bump-version.sh <version>"
```

### 3. CI Integration

New step in `.github/workflows/ci.yml`, after the Swift tests. The existing CI build uses the default DerivedData path (`~/Library/Developer/Xcode/DerivedData/`), so the `find` command searches there.

```yaml
- name: Validate bridge binary
  run: |
    BRIDGE=$(find ~/Library/Developer/Xcode/DerivedData -name safari-mcp-bridge -type f 2>/dev/null | head -1)
    if [ -z "$BRIDGE" ]; then
      echo "::error::safari-mcp-bridge not found in build output"
      exit 1
    fi
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

Note: `--check-relay` is not run in CI (no Safari, no socket). The CI output will include: `"Relay check: skipped (no running app — run make validate-bridge locally)"`.

### 4. Regression Test Suite — Section 16

Added to `docs/regression-tests.md`:

```markdown
## 16  Bridge & Client Integration

### 16.1  Automated validation

\`\`\`fish
make validate-bridge
\`\`\`

- [ ] Binary check passes
- [ ] Config check passes (both CLI and Desktop)
- [ ] Relay check passes (MCP handshake + tools/list through bridge)

### 16.2  Claude Code CLI

Open a new terminal and start Claude Code:

\`\`\`fish
claude
\`\`\`

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

\`\`\`fish
/Applications/Claude\ in\ Safari.app/Contents/MacOS/safari-mcp-bridge --status
\`\`\`

- [ ] Claude Code CLI shows `✓ configured`
- [ ] Claude Desktop shows `✓ configured`
- [ ] Both point to the same bridge binary path
```

PR checklist addition:
```
- [ ] 16. Bridge & client integration: validate-bridge, CLI test, Desktop test
```

## Testing

Per PRINCIPLES.md rule 2 — tests must pass before the feature is considered complete.

Since `validate-bridge.py` is itself a validation tool (not a runtime component), automated tests are verification of the script's own behavior:

| ID | Test | Expected |
|---|---|---|
| T1 | `--check-binary` against built binary | Exit 0, shows `[ok]` for all checks |
| T2 | `--check-binary` against nonexistent path | Exit 1, error: "not found" |
| T3 | `--check-binary` against non-executable file | Exit 1, error: "not executable" |
| T4 | `--check-config` with valid configs installed | Exit 0, both configs show `[ok]` |
| T5 | `--check-config` with no Desktop installed | Exit 0, Desktop skipped with warning |
| T6 | `--check-relay` with app running | Exit 0, handshake + tools/list succeed |
| T7 | `--check-relay` with app not running | Exit 1, error: "not running" |
| T8 | Default (no flags) with app running | All three check sections appear |
| T9 | Default (no flags) with app stopped | Binary + config pass, relay skipped |
| T10 | CI config round-trip | `--install` writes valid JSON, `--uninstall` removes entry |

Verification: T1–T9 are run locally via `make validate-bridge` and manual invocations. T10 runs in CI. `make pre-release` exercises T1, T4, T6 (or T7/T9 depending on app state).

## Files Changed

| File | Change |
|---|---|
| `scripts/validate-bridge.py` | New — bridge validation script |
| `Makefile` | Add `validate-bridge` and `pre-release` targets to targets and `.PHONY` |
| `.github/workflows/ci.yml` | Add bridge binary + config installer validation steps |
| `docs/regression-tests.md` | Add Section 16: Bridge & Client Integration |
| `STRUCTURE.md` | Add `validate-bridge.py` to scripts listing |

## Safari Degradations

None — this spec adds validation tooling only. No changes to runtime behavior.
