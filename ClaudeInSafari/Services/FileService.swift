import Foundation
import UniformTypeIdentifiers

/// Reads local files for the file_upload tool.
/// See Spec 019 for full specification.
///
/// Requires `com.apple.security.temporary-exception.files.absolute-path.read-only`
/// entitlement in ClaudeInSafari.entitlements for App Sandbox access. The entitlement
/// grants read access to `/` (the entire filesystem) because the tool accepts arbitrary
/// caller-supplied paths — restricting to a narrower prefix (e.g. `/Users/`) would break
/// legitimate use cases like `/tmp/` or `/var/`. Note: this entitlement is not App Store
/// compatible and must be revisited before Phase 7 distribution.
class FileService {

    enum FileReadError: Error {
        case dotDotComponent(path: String)
        case notAbsolute(path: String)
        case isDirectory(path: String)
        case notFound(path: String)
        case notReadable(path: String)
        case tooLarge(path: String, size: Int)

        var userMessage: String {
            switch self {
            case .dotDotComponent(let p): return "Path must not contain '..' components: \(p)"
            case .notAbsolute(let p):     return "Path must be absolute: \(p)"
            case .isDirectory(let p):     return "Path is a directory, not a file: \(p)"
            case .notFound(let p):        return "File not found: \(p)"
            case .notReadable(let p):     return "Cannot read file: \(p)"
            case .tooLarge(let p, let s): return "File exceeds 100 MB limit (\(s / (1024 * 1024)) MB): \(p)"
            }
        }
    }

    struct FileDescriptor {
        let filename: String
        let mimeType: String
        let data: Data
        let size: Int

        init(filename: String, mimeType: String, data: Data) {
            self.filename = filename
            self.mimeType = mimeType
            self.data = data
            self.size = data.count
        }
    }

    static let maxFileSizeBytes = 100 * 1024 * 1024  // 100 MB

    /// Reads each path in order, fail-fast. Returns an ordered array of FileDescriptor
    /// values — one per input path — or the first error encountered.
    func readFiles(paths: [String]) -> Result<[FileDescriptor], FileReadError> {
        var descriptors: [FileDescriptor] = []
        for path in paths {
            switch readFile(path: path) {
            case .success(let descriptor): descriptors.append(descriptor)
            case .failure(let error):      return .failure(error)
            }
        }
        return .success(descriptors)
    }

    private func readFile(path: String) -> Result<FileDescriptor, FileReadError> {
        // 1. Must be absolute
        guard path.hasPrefix("/") else {
            return .failure(.notAbsolute(path: path))
        }
        // 2. Reject paths with '..' components — URL(fileURLWithPath:) does not normalize '..' at
        //    construction time, so a path like /tmp/../etc/passwd would pass the hasPrefix check
        //    above but could resolve to an unintended location after symlink resolution.
        if URL(fileURLWithPath: path).pathComponents.contains("..") {
            return .failure(.dotDotComponent(path: path))
        }
        // 3. Resolve symlinks transparently
        let resolvedURL = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let resolvedPath = resolvedURL.path

        // 4. Check existence
        let fm = FileManager.default
        guard fm.fileExists(atPath: resolvedPath) else {
            return .failure(.notFound(path: path))
        }
        // Fetch attributes once for both directory check and size check
        let attrs: [FileAttributeKey: Any]
        do {
            attrs = try fm.attributesOfItem(atPath: resolvedPath)
        } catch {
            NSLog("FileService: attributesOfItem failed for '%@' (resolved: '%@'): %@",
                  path, resolvedPath, error.localizedDescription)
            return .failure(.notReadable(path: path))
        }
        // 4a. Reject directories — also reject if type attribute is unreadable (fail safe)
        let fileType = attrs[.type] as? FileAttributeType
        if fileType == nil || fileType == .typeDirectory {
            return .failure(.isDirectory(path: path))
        }
        // 5. Check readability
        guard fm.isReadableFile(atPath: resolvedPath) else {
            NSLog("FileService: isReadableFile returned false for '%@' (resolved: '%@')", path, resolvedPath)
            return .failure(.notReadable(path: path))
        }
        // 6. Check size — NSFileSize is an NSNumber wrapping UInt64; cast via NSNumber
        guard let fileSizeNumber = attrs[.size] as? NSNumber else {
            return .failure(.notReadable(path: path))
        }
        let fileSize = fileSizeNumber.intValue
        guard fileSize <= Self.maxFileSizeBytes else {
            return .failure(.tooLarge(path: path, size: fileSize))
        }
        // 7. Read contents
        guard let data = fm.contents(atPath: resolvedPath) else {
            NSLog("FileService: contents(atPath:) returned nil for '%@' (resolved: '%@')", path, resolvedPath)
            return .failure(.notReadable(path: path))
        }
        // Post-read guard: re-validate size in case the file grew between attribute check and read
        guard data.count <= Self.maxFileSizeBytes else {
            return .failure(.tooLarge(path: path, size: data.count))
        }

        return .success(FileDescriptor(
            filename: resolvedURL.lastPathComponent,
            mimeType: mimeType(for: resolvedPath),
            data: data
        ))
    }

    /// Internal (not private) to allow direct testing in FileServiceTests.
    func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension
        if !ext.isEmpty, let utType = UTType(filenameExtension: ext) {
            return utType.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
    }
}
