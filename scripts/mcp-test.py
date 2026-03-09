#!/usr/bin/env python3
"""
MCP socket test client for Claude in Safari.

Connects to the Unix domain socket, performs the MCP handshake,
then sends a tools/call or tools/list request and prints the response.

Usage:
    # List all registered tools
    ./scripts/mcp-test.py list

    # Call a tool
    ./scripts/mcp-test.py call find '{"query": "Submit"}'
    ./scripts/mcp-test.py call read_page '{}'
    ./scripts/mcp-test.py call navigate '{"url": "https://example.com"}'

    # Use a specific socket path (instead of auto-discovery)
    ./scripts/mcp-test.py --socket /tmp/claude-mcp-browser-bridge-chris/12345.sock call find '{"query":"test"}'
"""

import argparse
import glob
import json
import os
import socket
import sys
import time


def find_socket():
    """Auto-discover the MCP socket in the well-known directory."""
    username = os.environ.get("USER") or os.getlogin()
    sock_dir = f"/tmp/claude-mcp-browser-bridge-{username}"

    # Prefer dev.sock symlink (created by Makefile)
    dev_sock = os.path.join(sock_dir, "dev.sock")
    if os.path.exists(dev_sock):
        return dev_sock

    # Fall back to any *.sock file
    socks = glob.glob(os.path.join(sock_dir, "*.sock"))
    if not socks:
        print(f"No socket found in {sock_dir}", file=sys.stderr)
        print("Is the Claude in Safari app running? Try: make dev", file=sys.stderr)
        sys.exit(1)

    if len(socks) > 1:
        print(f"Multiple sockets found: {socks}", file=sys.stderr)
        print("Using the newest one. Pass --socket to specify.", file=sys.stderr)
        socks.sort(key=os.path.getmtime, reverse=True)

    return socks[0]


def send_message(sock, msg):
    """Send a newline-delimited JSON message."""
    payload = json.dumps(msg).encode("utf-8") + b"\n"
    sock.sendall(payload)


def recv_message(sock, timeout=30):
    """Receive a newline-delimited JSON response."""
    sock.settimeout(timeout)
    buf = b""
    while True:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            print("Timed out waiting for response", file=sys.stderr)
            sys.exit(1)
        if not chunk:
            print("Connection closed by server", file=sys.stderr)
            sys.exit(1)
        buf += chunk
        if b"\n" in buf:
            line, _ = buf.split(b"\n", 1)
            return json.loads(line.decode("utf-8"))


def handshake(sock):
    """Perform the MCP initialize handshake."""
    # Step 1: initialize
    send_message(sock, {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "mcp-test", "version": "1.0.0"},
        },
    })
    resp = recv_message(sock)
    server_info = resp.get("result", {}).get("serverInfo", {})
    print(f"Connected to {server_info.get('name', '?')} v{server_info.get('version', '?')}", file=sys.stderr)

    # Step 2: initialized notification (no id, no response expected)
    send_message(sock, {
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    })
    # Brief pause to let the server process the notification
    time.sleep(0.05)


def cmd_list(sock):
    """Send tools/list and print the result."""
    send_message(sock, {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
    })
    resp = recv_message(sock)

    if "error" in resp:
        print(f"Error: {resp['error']}", file=sys.stderr)
        sys.exit(1)

    tools = resp.get("result", {}).get("tools", [])
    print(f"\n{len(tools)} tools registered:\n")
    for t in tools:
        name = t.get("name", "?")
        desc = t.get("description", "")
        print(f"  {name:30s} {desc[:60]}")
    print()


def cmd_call(sock, tool_name, args_json):
    """Send tools/call and print the result."""
    try:
        args = json.loads(args_json)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON args: {e}", file=sys.stderr)
        sys.exit(1)

    send_message(sock, {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args,
        },
    })
    resp = recv_message(sock, timeout=35)

    if "error" in resp:
        err = resp["error"]
        if isinstance(err, dict):
            print(f"\nError ({err.get('code', '?')}): {err.get('message', err)}\n", file=sys.stderr)
        else:
            print(f"\nError: {err}\n", file=sys.stderr)
        sys.exit(1)

    result = resp.get("result", {})
    content = result.get("content", [])
    for item in content:
        if item.get("type") == "text":
            print(item.get("text", ""))
        elif item.get("type") == "image":
            print(f"[image: {item.get('mimeType', '?')}, {len(item.get('data', ''))} bytes base64]")
        else:
            print(json.dumps(item, indent=2))


def main():
    parser = argparse.ArgumentParser(description="MCP socket test client")
    parser.add_argument("--socket", "-s", help="Socket path (default: auto-discover)")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("list", help="List registered tools")

    call_parser = sub.add_parser("call", help="Call a tool")
    call_parser.add_argument("tool", help="Tool name (e.g. find, read_page)")
    call_parser.add_argument("args", nargs="?", default="{}", help="Tool arguments as JSON")

    parsed = parser.parse_args()
    if not parsed.command:
        parser.print_help()
        sys.exit(1)

    sock_path = parsed.socket or find_socket()
    print(f"Socket: {sock_path}", file=sys.stderr)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(sock_path)
    except (FileNotFoundError, ConnectionRefusedError) as e:
        print(f"Cannot connect to {sock_path}: {e}", file=sys.stderr)
        print("Is the Claude in Safari app running? Try: make dev", file=sys.stderr)
        sys.exit(1)

    try:
        handshake(sock)
        if parsed.command == "list":
            cmd_list(sock)
        elif parsed.command == "call":
            cmd_call(sock, parsed.tool, parsed.args)
    finally:
        sock.close()


if __name__ == "__main__":
    main()
