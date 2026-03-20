import XCTest
@testable import ClaudeInSafari

final class ConfigInstallerTests: XCTestCase {

    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("config-test-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    // T1: creates config from scratch when file doesn't exist
    func testInstall_createsNewFile() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        let result = ConfigInstaller.installConfig(
            bridgePath: "/Applications/Claude in Safari.app/Contents/MacOS/safari-mcp-bridge",
            configPath: configPath
        )
        XCTAssertTrue(result.success)

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let servers = json["mcpServers"] as! [String: Any]
        let safari = servers["claude-in-safari"] as! [String: Any]
        XCTAssertEqual(safari["command"] as? String, "/Applications/Claude in Safari.app/Contents/MacOS/safari-mcp-bridge")
    }

    // T2: merges into existing config without clobbering other servers
    func testInstall_mergesWithExisting() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        let existing = """
        {
          "mcpServers": {
            "other-server": {
              "command": "other-binary",
              "args": ["--flag"]
            }
          },
          "otherKey": true
        }
        """
        try existing.write(toFile: configPath, atomically: true, encoding: .utf8)

        let result = ConfigInstaller.installConfig(
            bridgePath: "/test/bridge",
            configPath: configPath
        )
        XCTAssertTrue(result.success)

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        // Other server preserved
        let servers = json["mcpServers"] as! [String: Any]
        XCTAssertNotNil(servers["other-server"])
        XCTAssertNotNil(servers["claude-in-safari"])
        // Other top-level key preserved
        XCTAssertEqual(json["otherKey"] as? Bool, true)
    }

    // T3: skips file with invalid JSON
    func testInstall_skipsInvalidJSON() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        try "not valid json {{{".write(toFile: configPath, atomically: true, encoding: .utf8)

        let result = ConfigInstaller.installConfig(
            bridgePath: "/test/bridge",
            configPath: configPath
        )
        XCTAssertFalse(result.success)
        XCTAssertTrue(result.message.contains("invalid JSON"))
    }

    // T4: uninstall removes the key
    func testUninstall_removesKey() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        // First install
        _ = ConfigInstaller.installConfig(bridgePath: "/test/bridge", configPath: configPath)
        // Then uninstall
        let result = ConfigInstaller.uninstallConfig(configPath: configPath)
        XCTAssertTrue(result.success)

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let servers = json["mcpServers"] as? [String: Any] ?? [:]
        XCTAssertNil(servers["claude-in-safari"])
    }

    // T5: uninstall preserves other servers
    func testUninstall_preservesOtherServers() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        let existing = """
        {
          "mcpServers": {
            "other-server": {"command": "other"},
            "claude-in-safari": {"command": "/old/path"}
          }
        }
        """
        try existing.write(toFile: configPath, atomically: true, encoding: .utf8)

        _ = ConfigInstaller.uninstallConfig(configPath: configPath)

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let servers = json["mcpServers"] as! [String: Any]
        XCTAssertNotNil(servers["other-server"])
        XCTAssertNil(servers["claude-in-safari"])
    }

    // T5b: uninstall also removes stale keys
    func testUninstall_removesStaleKeys() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        let existing = """
        {
          "mcpServers": {
            "claude-safari-mcp": {"command": "/old/wrapper"},
            "claude-in-safari": {"command": "/current/bridge"},
            "other-server": {"command": "other"}
          }
        }
        """
        try existing.write(toFile: configPath, atomically: true, encoding: .utf8)

        let result = ConfigInstaller.uninstallConfig(configPath: configPath)
        XCTAssertTrue(result.success)

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let servers = json["mcpServers"] as! [String: Any]
        XCTAssertNil(servers["claude-in-safari"], "Current key must be removed")
        XCTAssertNil(servers["claude-safari-mcp"], "Stale key must also be removed")
        XCTAssertNotNil(servers["other-server"], "Unrelated servers must be preserved")
    }

    // T6: creates parent directories if needed
    func testInstall_createsParentDirectories() throws {
        let configPath = tmpDir
            .appendingPathComponent("nested/dir/claude.json").path

        let result = ConfigInstaller.installConfig(
            bridgePath: "/test/bridge",
            configPath: configPath
        )
        XCTAssertTrue(result.success)
        XCTAssertTrue(FileManager.default.fileExists(atPath: configPath))
    }

    // T7: marker file is written with correct contents
    func testWriteMarkerFile_writesJSON() throws {
        // Use a temp App Group path for testing (override in test)
        let markerPath = tmpDir.appendingPathComponent("mcp_config_installed.json").path
        ConfigInstaller.writeMarkerFile(bridgePath: "/test/bridge", clients: ["Claude Code CLI"], markerPath: markerPath)

        let data = try Data(contentsOf: URL(fileURLWithPath: markerPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["bridge_path"] as? String, "/test/bridge")
        XCTAssertEqual(json["clients"] as? [String], ["Claude Code CLI"])
        XCTAssertNotNil(json["installed_at"] as? String)
    }

    // T8: install removes stale MCP server keys
    func testInstall_removesStaleKeys() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        let existing = """
        {
          "mcpServers": {
            "claude-safari-mcp": {
              "command": "/old/wrapper",
              "args": []
            },
            "other-server": {
              "command": "other-binary"
            }
          }
        }
        """
        try existing.write(toFile: configPath, atomically: true, encoding: .utf8)

        let result = ConfigInstaller.installConfig(
            bridgePath: "/test/bridge",
            configPath: configPath
        )
        XCTAssertTrue(result.success)
        XCTAssertTrue(result.message.contains("removed stale"))

        let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let servers = json["mcpServers"] as! [String: Any]
        XCTAssertNil(servers["claude-safari-mcp"], "Stale key must be removed")
        XCTAssertNotNil(servers["claude-in-safari"], "Current key must be present")
        XCTAssertNotNil(servers["other-server"], "Unrelated servers must be preserved")
    }

    // T9: install without stale keys does not mention removal
    func testInstall_noStaleKeys_noRemovalMessage() throws {
        let configPath = tmpDir.appendingPathComponent("claude.json").path
        let result = ConfigInstaller.installConfig(
            bridgePath: "/test/bridge",
            configPath: configPath
        )
        XCTAssertTrue(result.success)
        XCTAssertFalse(result.message.contains("removed stale"))
    }

    // T10: removeMarkerFile deletes the file
    func testRemoveMarkerFile_deletesFile() throws {
        let markerPath = tmpDir.appendingPathComponent("mcp_config_installed.json").path
        ConfigInstaller.writeMarkerFile(bridgePath: "/test/bridge", clients: [], markerPath: markerPath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: markerPath))

        ConfigInstaller.removeMarkerFile(markerPath: markerPath)
        XCTAssertFalse(FileManager.default.fileExists(atPath: markerPath))
    }
}
