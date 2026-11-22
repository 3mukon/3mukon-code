import AppKit
import ApplicationServices
import CoreFoundation
import Darwin
import Foundation
import PeekabooAutomationKit

private let wireVersion = 6
private let requestLimit = 16 * 1024
private let controlRequestLimit = 544 * 1024
private let imageReplyLimit = 1024 * 1024 + 32 * 1024

private struct Request: Decodable, Sendable {
    enum Kind: String, Decodable, Sendable { case hello, permissions, applications, application, windows, observe, preview, reveal, action, cancel, control }
    let kind: Kind
    let version: Int
    let generation: UUID
    let id: Int
    let application: NativeApplication?
    let window: UUID?
    let scope: UUID?
    let operation: UUID?
    let deadline: Int64?
    let observation: UUID?
    let image: Bool?
    let action: NativeInput?
    let frame: NativeControlFrame?
    let controlRevision: Int?
}

private struct Permissions: Encodable {
    let accessibility = AXIsProcessTrusted()
    let screenRecording = CGPreflightScreenCaptureAccess()
    let inputMonitoring = CGPreflightListenEventAccess()
}

private struct Reply<T: Encodable>: Encodable {
    let kind: String
    let version = wireVersion
    let generation: UUID
    let id: Int
    var pid: pid_t? = nil
    var permissions: Permissions? = nil
    var inventory: RunningApplications? = nil
    var result: T? = nil
    var event: String? = nil
}

private enum WireError: Error { case argument, frame, handshake }

private struct Frames {
    private var pending = Data()
    private var chunk = [UInt8](repeating: 0, count: 4096)

    mutating func next() throws -> Data? {
        while true {
            if let end = pending.firstIndex(of: 10) {
                guard pending.distance(from: pending.startIndex, to: end) <= controlRequestLimit else { throw WireError.frame }
                let frame = Data(pending[..<end])
                pending.removeSubrange(...end)
                return frame
            }
            guard pending.count <= controlRequestLimit else { throw WireError.frame }
            // Read the bytes already in the pipe. The sender waits for a reply after each frame
            // and keeps the pipe open for cancellation and later requests.
            let count = chunk.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw WireError.frame
            }
            if count == 0 {
                guard pending.isEmpty else { throw WireError.frame }
                return nil
            }
            pending.append(contentsOf: chunk.prefix(count))
        }
    }
}

// Keep reading the private pipe while a native request waits on a lock, capture or held input.
private func input() -> AsyncThrowingStream<Request, Error> {
    AsyncThrowingStream(bufferingPolicy: .bufferingOldest(4)) { stream in
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                var frames = Frames()
                let decoder = JSONDecoder()
                while let frame = try frames.next() {
                    let request = try decoder.decode(Request.self, from: frame)
                    guard frame.count <= requestLimit || request.kind == .control else { throw WireError.frame }
                    guard case .enqueued = stream.yield(request) else { throw WireError.frame }
                }
                stream.finish()
            } catch {
                stream.finish(throwing: error)
            }
        }
    }
}

@MainActor
private final class Connection {
    let lanes: DesktopOperationLaneCoordinator
    let catalog: NativeWindowCatalog
    let observations: NativeObservations
    let actions: NativeActions
    let controlPanel: ForegroundPanel
    private let encoder = JSONEncoder()
    private var generation: UUID?
    private var lastID = 0
    private var controlRevision = 0
    private var active: Task<Void, Never>?

    init(root: URL) {
        lanes = DesktopOperationLaneCoordinator(appOwnedCoordinationRootURL: root)
        catalog = NativeWindowCatalog()
        observations = NativeObservations(catalog: catalog)
        controlPanel = ForegroundPanel()
        actions = NativeActions(catalog: catalog, observations: observations, lanes: lanes, controlPanel: controlPanel)
        encoder.outputFormatting = .withoutEscapingSlashes
    }

    func receive(_ request: Request) throws {
        guard request.version == wireVersion, request.id > 0 else { throw WireError.handshake }
        if request.kind == .control {
            guard request.generation == generation, request.id > controlRevision else { throw WireError.handshake }
            controlRevision = request.id
            controlPanel.show(request.frame, revision: request.id) { [weak self] revision, command in
                let message = Reply<NativeNull>(kind: "control-command", generation: request.generation,
                                               id: revision, event: command)
                do { try self?.write(message, limit: 32 * 1024) }
                catch { self?.active?.cancel() }
            }
            return
        }
        if request.kind == .cancel {
            guard request.generation == generation, request.id <= lastID else { throw WireError.handshake }
            if request.id == lastID { active?.cancel() }
            return
        }
        guard active == nil, request.id > lastID else { throw WireError.handshake }
        lastID = request.id
        if generation == nil && request.kind == .hello {
            generation = request.generation
        } else if generation != request.generation || request.kind == .hello {
            throw WireError.handshake
        }
        active = Task { @MainActor in
            defer { active = nil }
            do {
                try await execute(request)
            } catch {
                // A malformed host request or a lost output pipe renders this generation unusable.
                // At this point any action body has already settled and released its held inputs.
                exit(EXIT_FAILURE)
            }
        }
    }

    func close() async {
        active?.cancel()
        await active?.value
    }

    private func execute(_ request: Request) async throws {
        var metadata = Reply<NativeNull>(kind: request.kind.rawValue, generation: request.generation, id: request.id)
        switch request.kind {
        case .hello:
            metadata.pid = getpid()
        case .permissions:
            metadata.permissions = Permissions()
        case .applications:
            metadata.inventory = RunningApplications.read()
        case .application:
            guard let application = request.application else { throw WireError.frame }
            let result: NativeReply<NativeNull> = RunningApplications.resolve(application) == nil ? .refused(.stale) : .verified(NativeNull())
            try send(request, result: result)
            return
        case .windows:
            guard let application = request.application else { throw WireError.frame }
            let operation = try operation(request)
            let result = await read {
                try await self.withReadLease(application, operation: operation) { @Sendable in
                    try await self.catalog.list(application, operation: operation)
                }
            }
            try send(request, result: result)
            return
        case .observe:
            guard let window = request.window, let scope = request.scope, let image = request.image else { throw WireError.frame }
            let operation = try operation(request)
            let result = await read {
                try operation.check()
                let live = try self.catalog.current(window)
                return try await self.withReadLease(live.window.application, operation: operation) { @Sendable in
                    try await self.observations.read(window: window, scope: scope, image: image, operation: operation)
                }
            }
            try send(request, result: result)
            return
        case .preview:
            guard let application = request.application, let window = request.window else { throw WireError.frame }
            let operation = try operation(request)
            let result = await read {
                try await self.withReadLease(application, operation: operation) { @Sendable in
                    try await self.observations.preview(window: window, application: application, operation: operation)
                }
            }
            try send(request, result: result)
            return
        case .reveal:
            guard let window = request.window else { throw WireError.frame }
            let result = await actions.reveal(window: window, operation: try operation(request))
            try send(request, result: result)
            return
        case .action:
            guard let window = request.window, let scope = request.scope,
                  let observation = request.observation, let action = request.action else { throw WireError.frame }
            let result = await actions.run(window: window, scope: scope, observation: observation, input: action,
                                           controlRevision: request.controlRevision, operation: try operation(request))
            try send(request, result: result)
            return
        case .cancel, .control:
            throw WireError.handshake
        }
        try write(metadata, limit: 32 * 1024)
    }

    private func operation(_ request: Request) throws -> NativeOperation {
        guard request.operation != nil, let deadline = request.deadline, deadline >= 0 else { throw WireError.frame }
        let remaining = min(8000, deadline - Int64(Date().timeIntervalSince1970 * 1000))
        return NativeOperation(deadline: ContinuousClock.now.advanced(by: .milliseconds(max(0, remaining)))) { [weak self] event in
            guard let self else { return }
            let message = Reply<NativeNull>(kind: "event", generation: request.generation, id: request.id, event: event)
            do { try self.write(message, limit: 32 * 1024) }
            catch { self.active?.cancel() }
        }
    }

    private func withReadLease<T: Sendable>(
        _ application: NativeApplication, operation: NativeOperation, run: @Sendable () async throws -> T
    ) async throws -> T {
        try operation.check()
        guard let start = UInt64(application.processStart) else { throw NativeFailure.stale }
        let identity = ApplicationProcessIdentity(processIdentifier: application.pid, processStartIdentity: start)
        return try await lanes.run(scope: .process(identity), access: .read, operation: run)
    }

    private func read<T: Encodable & Sendable>(_ run: () async throws -> T) async -> NativeReply<T> {
        do { return .verified(try await run()) }
        catch is CancellationError { return .cancelled }
        catch is NativeDeadline { return .cancelled }
        catch let failure as NativeFailure { return .refused(failure) }
        catch is DesktopOperationLaneError { return .refused(NativeFailure("busy")) }
        catch { return .refused(.unsupported) }
    }

    private func send<T: Encodable>(_ request: Request, result: T) throws {
        let response = Reply(kind: request.kind.rawValue, generation: request.generation, id: request.id, result: result)
        let image = request.kind == .observe || request.kind == .preview
        try write(response, limit: image ? imageReplyLimit : 32 * 1024)
    }

    private func write<T: Encodable>(_ response: Reply<T>, limit: Int) throws {
        var bytes = try encoder.encode(response)
        guard bytes.count <= limit else { throw WireError.frame }
        bytes.append(10)
        try FileHandle.standardOutput.write(contentsOf: bytes)
    }
}

@MainActor
private func run(_ args: [String]) async throws {
    guard args.count == 3, args[1] == "--coordination-root", args[2].hasPrefix("/") else { throw WireError.argument }
    let root = URL(fileURLWithPath: args[2], isDirectory: true)
    var properties = stat()
    guard lstat(root.path, &properties) == 0, properties.st_mode & S_IFMT == S_IFDIR,
          properties.st_uid == getuid(), properties.st_mode & 0o077 == 0 else { throw WireError.argument }

    signal(SIGPIPE, SIG_IGN)
    let connection = Connection(root: root)
    do {
        for try await request in input() { try connection.receive(request) }
    } catch {
        await connection.close()
        throw error
    }
    await connection.close()
}

// AppKit dispatches the non-activating panel's buttons on the same main run loop as the event tap.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
Task { @MainActor in
    do {
        try await run(CommandLine.arguments)
        exit(EXIT_SUCCESS)
    } catch {
        exit(EXIT_FAILURE)
    }
}
application.run()
exit(EXIT_FAILURE)
