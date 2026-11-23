import Darwin
import Foundation

// macOS counts what a process does as the work of the app that started it, and asks for that app's
// permissions. The helper's are its own: they stay with its signature when an update replaces the
// app, and System Settings lists it by its name. So it starts itself again in place, as the same
// process on the same pipes, and macOS holds it responsible for itself.
enum OwnPermissions {
    private typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    private typealias ResponsibleProcess = @convention(c) (pid_t) -> pid_t
    private static let mark = "--responsible"

    // The arguments once the process is responsible for itself, or nil where it cannot be.
    static func take(_ arguments: [String]) -> [String]? {
        // macOS has no public call for either.
        guard let responsibleProcess = system("responsibility_get_pid_responsible_for_pid", ResponsibleProcess.self),
              let disclaim = system("responsibility_spawnattrs_setdisclaim", Disclaim.self) else { return nil }
        let started = arguments.last == mark
        if responsibleProcess(getpid()) == getpid() { return started ? arguments.dropLast() : arguments }
        guard !started, let path = Bundle.main.executablePath else { return nil }

        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0,
              posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETEXEC)) == 0,
              disclaim(&attributes, 1) == 0 else { return nil }
        var strings = (arguments + [mark]).map { strdup($0) }
        strings.append(nil)
        // This returns only where it fails.
        _ = posix_spawn(nil, path, nil, &attributes, strings, environ)
        return nil
    }

    private static func system<T>(_ name: String, _ type: T.Type) -> T? {
        // Every image the process has loaded.
        dlsym(UnsafeMutableRawPointer(bitPattern: -2), name).map { unsafeBitCast($0, to: type) }
    }
}
