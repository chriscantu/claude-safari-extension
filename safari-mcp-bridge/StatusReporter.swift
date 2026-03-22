// safari-mcp-bridge/StatusReporter.swift
import Foundation

enum StatusReporter {

    static func printStatus() {
        let bridgePath = {
            if let realPath = realpath(ProcessInfo.processInfo.arguments[0], nil) {
                defer { free(realPath) }
                return String(cString: realPath)
            }
            return ProcessInfo.processInfo.arguments[0]
        }()

        print("Safari MCP Bridge Status")
        print("========================")
        print("")

        // Bridge binary
        print("Bridge: \(bridgePath)")

        // Socket
        let socketDir = BridgeRelay.socketDirectory
        print("Socket dir: \(socketDir)")
        if let socketPath = BridgeRelay.findNewestSocket(in: socketDir) {
            let pid = (socketPath as NSString).lastPathComponent.replacingOccurrences(of: ".sock", with: "")
            print("Socket: \(socketPath) (PID \(pid))")

            // Test connection
            if let fd = try? BridgeRelay.connectToSocket(at: socketPath) {
                close(fd)
                print("Connection: ✓ reachable")
            } else {
                print("Connection: ✗ exists but unreachable")
            }
        } else {
            print("Socket: ✗ not found (is Claude in Safari running?)")
        }

        print("")

        // Config files
        let configs: [(String, String)] = [
            ("Claude Code CLI", ConfigInstaller.claudeCodeConfigPath),
            ("Claude Desktop", ConfigInstaller.claudeDesktopConfigPath)
        ]

        for (name, path) in configs {
            let fm = FileManager.default
            if fm.fileExists(atPath: path) {
                if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let servers = json["mcpServers"] as? [String: Any],
                   let safari = servers["claude-in-safari"] as? [String: Any],
                   let command = safari["command"] as? String {
                    let pathMatch = command == bridgePath
                    print("\(name): ✓ configured → \(command)")
                    if !pathMatch {
                        print("  ⚠ Path mismatch! Config points to \(command) but this binary is \(bridgePath)")
                        print("  Run --install to update.")
                    }
                } else {
                    print("\(name): ✗ config exists but no claude-in-safari entry")
                }
            } else {
                print("\(name): — config file not found (\(path))")
            }
        }

        print("")

        // Session info
        if let start = BridgeRelay.bridgeSessionStart {
            let uptime = Int(Date().timeIntervalSince(start))
            print("Session uptime: \(uptime)s")
            print("Reconnections: \(BridgeRelay.bridgeReconnectCount)")
        } else {
            print("Session: not active (--status shows runtime metrics only when relaying)")
        }
    }
}
