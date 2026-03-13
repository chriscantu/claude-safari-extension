import Foundation
import UniformTypeIdentifiers

/// Reads local files for the file_upload tool.
/// See Spec 019 for full specification.
///
/// Requires `com.apple.security.temporary-exception.files.absolute-path.read-only`
/// entitlement in ClaudeInSafari.entitlements for App Sandbox access.
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
            case .tooLarge(let p, _):     return "File exceeds 100 MB limit: \(p)"
            }
        }
    }

    struct FileDescriptor {
        let filename: String
        let mimeType: String
        let data: Data
        let size: Int
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
        // 2. Reject .. components (path is absolute, so URL won't resolve against cwd)
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
            return .failure(.notReadable(path: path))
        }
        // 4a. Reject directories
        if let type = attrs[.type] as? FileAttributeType, type == .typeDirectory {
            return .failure(.isDirectory(path: path))
        }
        // 5. Check readability
        guard fm.isReadableFile(atPath: resolvedPath) else {
            return .failure(.notReadable(path: path))
        }
        // 6. Check size
        let fileSize = (attrs[.size] as? Int) ?? 0
        guard fileSize <= Self.maxFileSizeBytes else {
            return .failure(.tooLarge(path: path, size: fileSize))
        }
        // 7. Read contents
        guard let data = fm.contents(atPath: resolvedPath) else {
            return .failure(.notReadable(path: path))
        }
        // Post-read guard: re-validate size in case the file grew between attribute check and read
        guard data.count <= Self.maxFileSizeBytes else {
            return .failure(.tooLarge(path: path, size: data.count))
        }

        return .success(FileDescriptor(
            filename: resolvedURL.lastPathComponent,
            mimeType: mimeType(for: resolvedPath),
            data: data,
            size: data.count
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
