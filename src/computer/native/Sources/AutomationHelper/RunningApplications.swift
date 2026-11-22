import AppKit
import PeekabooAutomationKit

struct NativeApplication: Codable, Equatable, Sendable {
    let pid: pid_t
    let startedAt: Int64
    let processStart: String
    let bundleId: String
}

struct RunningApplications: Encodable {
    private static let limit = 16
    private static let appBundle = "io.github.3mukon.3mukon-code"

    struct Entry: Encodable {
        let pid: pid_t
        let startedAt: Int64
        let processStart: String
        let bundleId: String
        let name: String
    }

    let applications: [Entry]
    let truncated: Bool

    @MainActor
    static func read() -> RunningApplications {
        let entries = NSWorkspace.shared.runningApplications.compactMap { app -> Entry? in
            guard let application = identity(app) else { return nil }
            return Entry(
                pid: application.pid,
                startedAt: application.startedAt,
                processStart: application.processStart,
                bundleId: application.bundleId,
                name: nativeLabel(app.localizedName) ?? String(application.bundleId.prefix(96))
            )
        }.sorted { a, b in
            if a.bundleId != b.bundleId { return a.bundleId < b.bundleId }
            return a.pid < b.pid
        }
        return RunningApplications(applications: Array(entries.prefix(limit)), truncated: entries.count > limit)
    }

    @MainActor
    static func resolve(_ expected: NativeApplication) -> NSRunningApplication? {
        guard let app = NSRunningApplication(processIdentifier: expected.pid),
              identity(app) == expected else { return nil }
        return app
    }

    @MainActor
    private static func identity(_ app: NSRunningApplication) -> NativeApplication? {
        let hostPID = getppid()
        let hostBundle = NSRunningApplication(processIdentifier: hostPID)?.bundleIdentifier
        let excluded = [appBundle, hostBundle].compactMap { $0 }
        let pid = app.processIdentifier
        guard pid > 0, pid != hostPID, pid != getpid(), !app.isTerminated,
              app.activationPolicy == .regular,
              let bundleId = app.bundleIdentifier,
              !bundleId.isEmpty, bundleId.utf8.count <= 160,
              bundleId.utf8.allSatisfy(isBundleByte),
              !excluded.contains(where: { bundleId == $0 || bundleId.hasPrefix($0 + ".") }),
              let launch = app.launchDate, launch.timeIntervalSince1970 > 0,
              let processStart = SystemIdentityResolver.processStartIdentity(pid), processStart > 0 else {
            return nil
        }
        return NativeApplication(pid: pid, startedAt: Int64(launch.timeIntervalSince1970 * 1000),
                                 processStart: String(processStart), bundleId: bundleId)
    }

    private static func isBundleByte(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
            || byte == 45 || byte == 46
    }
}

func nativeLabel(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let text = String(decoding: raw.utf8.prefix(120), as: UTF8.self)
        .components(separatedBy: .controlCharacters).joined()
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
}
