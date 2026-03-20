// safari-mcp-bridge/ConfigInstaller.swift
import Foundation

struct InstallResult {
    let success: Bool
    let message: String
}

/// Reads, merges, and writes MCP server config for Claude Code and Desktop.
enum ConfigInstaller {

    static let serverKey = "claude-in-safari"

    /// Legacy MCP server keys from earlier development iterations.
    /// Removed during --install to prevent conflicts with the current entry.
    static let staleServerKeys = ["claude-safari-mcp"]

    /// Well-known config file paths.
    static var claudeCodeConfigPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.claude.json"
    }

    static var claudeDesktopConfigPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Application Support/Claude/claude_desktop_config.json"
    }

    /// Detects which Claude clients are installed.
    static func detectClients() -> [(name: String, configPath: String)] {
        var clients: [(String, String)] = []
        let home = FileManager.default.homeDirectoryForCurrentUser.path

        // Claude Code: check if ~/.claude/ directory exists
        if FileManager.default.fileExists(atPath: "\(home)/.claude") {
            clients.append(("Claude Code CLI", claudeCodeConfigPath))
        }

        // Claude Desktop: check if ~/Library/Application Support/Claude/ exists
        let desktopDir = "\(home)/Library/Application Support/Claude"
        if FileManager.default.fileExists(atPath: desktopDir) {
            clients.append(("Claude Desktop", claudeDesktopConfigPath))
        }

        return clients
    }

    /// Writes the MCP server config entry for safari-mcp-bridge to the given config file.
    /// Merges with existing config — never overwrites other keys.
    static func installConfig(bridgePath: String, configPath: String) -> InstallResult {
        let fm = FileManager.default

        // Create parent directories if needed
        let parentDir = (configPath as NSString).deletingLastPathComponent
        if !fm.fileExists(atPath: parentDir) {
            do {
                try fm.createDirectory(atPath: parentDir, withIntermediateDirectories: true)
            } catch {
                return InstallResult(success: false, message: "Failed to create directory: \(error.localizedDescription)")
            }
        }

        // Read existing file or start with empty dict
        var root: [String: Any] = [:]
        if fm.fileExists(atPath: configPath) {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
                guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return InstallResult(success: false, message: "Config file contains invalid JSON (not a dictionary): \(configPath)")
                }
                root = parsed
            } catch {
                return InstallResult(success: false, message: "Config file contains invalid JSON: \(configPath) — \(error.localizedDescription)")
            }
        }

        // Get or create mcpServers
        var servers = root["mcpServers"] as? [String: Any] ?? [:]

        // Remove stale entries from earlier development iterations
        var removedStale: [String] = []
        for staleKey in staleServerKeys {
            if servers.removeValue(forKey: staleKey) != nil {
                removedStale.append(staleKey)
            }
        }

        // Set our entry
        servers[serverKey] = [
            "command": bridgePath,
            "args": [String]()
        ] as [String: Any]

        root["mcpServers"] = servers

        // Write back
        do {
            let data = try JSONSerialization.data(
                withJSONObject: root,
                options: [.prettyPrinted, .sortedKeys]
            )
            try data.write(to: URL(fileURLWithPath: configPath), options: .atomic)
            var msg = "Configured: \(configPath)"
            if !removedStale.isEmpty {
                msg += " (removed stale: \(removedStale.joined(separator: ", ")))"
            }
            return InstallResult(success: true, message: msg)
        } catch {
            return InstallResult(success: false, message: "Failed to write config: \(error.localizedDescription)")
        }
    }

    /// Removes the safari-mcp-bridge entry from the given config file.
    static func uninstallConfig(configPath: String) -> InstallResult {
        let fm = FileManager.default
        guard fm.fileExists(atPath: configPath) else {
            return InstallResult(success: true, message: "Config file does not exist, nothing to remove: \(configPath)")
        }

        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
            guard var root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return InstallResult(success: false, message: "Config file contains invalid JSON: \(configPath)")
            }

            var servers = root["mcpServers"] as? [String: Any] ?? [:]
            servers.removeValue(forKey: serverKey)
            for staleKey in staleServerKeys {
                servers.removeValue(forKey: staleKey)
            }
            root["mcpServers"] = servers

            let updated = try JSONSerialization.data(
                withJSONObject: root,
                options: [.prettyPrinted, .sortedKeys]
            )
            try updated.write(to: URL(fileURLWithPath: configPath), options: .atomic)
            return InstallResult(success: true, message: "Removed from: \(configPath)")
        } catch {
            return InstallResult(success: false, message: "Failed to update config: \(error.localizedDescription)")
        }
    }

    /// Default marker file path in the App Group container.
    /// Hardcoded path pattern because the bridge binary lacks the app group entitlement
    /// (same rationale as BridgeRelay.socketDirectory).
    static var defaultMarkerPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Group Containers/\(bridgeAppGroupId)/mcp_config_installed.json"
    }

    /// Writes a marker file so the main app can detect successful installation.
    /// `markerPath` is overridable for testing.
    static func writeMarkerFile(bridgePath: String, clients: [String], markerPath: String? = nil) {
        let path = markerPath ?? defaultMarkerPath

        let formatter = ISO8601DateFormatter()
        let marker: [String: Any] = [
            "installed_at": formatter.string(from: Date()),
            "bridge_path": bridgePath,
            "clients": clients
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: marker, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            fputs("Warning: failed to write marker file at \(path): \(error.localizedDescription)\n", stderr)
        }
    }

    /// Removes the marker file. `markerPath` is overridable for testing.
    static func removeMarkerFile(markerPath: String? = nil) {
        let path = markerPath ?? defaultMarkerPath
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError {
            // File doesn't exist — nothing to remove, not an error
        } catch {
            fputs("Warning: failed to remove marker file at \(path): \(error.localizedDescription)\n", stderr)
        }
    }
}
