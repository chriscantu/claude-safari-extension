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
        except json.JSONDecodeError:
            continue
    return None


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


class _BridgeDied(Exception):
    """Raised when the bridge process dies or sends invalid data."""
    pass


# --- Check: Relay ---

def check_relay(bridge_path=None):
    """Spawn the bridge as a subprocess and perform MCP handshake over stdio."""
    header("Relay: spawning bridge as subprocess (simulating MCP client)")

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
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        fail(f"failed to launch bridge: {e}")
        return 1
    ok("process started")

    errors = 0
    # Shared buffer across recv() calls — prevents data loss when the bridge
    # sends multiple newline-delimited messages in a single read.
    leftover = b""

    try:
        # Helper: send newline-delimited JSON
        def send(msg):
            try:
                data = (json.dumps(msg) + "\n").encode("utf-8")
                proc.stdin.write(data)
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                raise _BridgeDied(f"bridge process died or closed stdin: {e}")

        # Helper: read one newline-delimited JSON response (with timeout)
        def recv(timeout_sec=10):
            nonlocal leftover
            # Check leftover from previous read first
            if b"\n" in leftover:
                line, leftover = leftover.split(b"\n", 1)
                try:
                    return json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    raise _BridgeDied(f"bridge sent invalid response: {e}")
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
                        try:
                            return json.loads(line.decode("utf-8"))
                        except (json.JSONDecodeError, UnicodeDecodeError) as e:
                            raise _BridgeDied(f"bridge sent invalid response: {e}")
            return None

        try:
            errors = _run_protocol_exchange(send, recv)
        except _BridgeDied as e:
            fail(str(e))
            return 1

    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    return errors


def _run_protocol_exchange(send, recv):
    """Execute the MCP handshake and tools/list. Raises _BridgeDied on bridge failures."""
    errors = 0

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

    return errors


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
