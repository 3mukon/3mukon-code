import ApplicationServices
import Carbon
import Foundation

@MainActor
final class ForegroundInput {
    private static let pointerEvents: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp,
        .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .leftMouseDragged,
        .rightMouseDragged, .otherMouseDragged, .scrollWheel]
    private let marker = Int64.random(in: 1...Int64.max)
    private let operation: NativeOperation
    private let isControlPointer: (CGEvent) -> Bool
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var lost = false
    private var secureReported = false

    init(operation: NativeOperation, isControlPointer: @escaping (CGEvent) -> Bool) {
        self.operation = operation
        self.isControlPointer = isControlPointer
    }

    func start() throws {
        try checkSecureInput()
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged] + Self.pointerEvents
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                         eventsOfInterest: mask, callback: { _, type, event, data in
            if let data {
                MainActor.assumeIsolated {
                    let monitor = Unmanaged<ForegroundInput>.fromOpaque(data).takeUnretainedValue()
                    monitor.receive(type, event: event)
                }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context), let source = CFMachPortCreateRunLoopSource(nil, tap, 0) else {
            throw CGPreflightListenEventAccess() ? NativeFailure.unsupported : NativeFailure.input
        }
        self.tap = tap
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        try check()
    }

    func stop() {
        if let tap { CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }

    func check() throws {
        try operation.check()
        try checkSecureInput()
        guard let tap, CGEvent.tapIsEnabled(tap: tap), !lost else {
            takeOver()
            throw CancellationError()
        }
    }

    func post(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        event.post(tap: .cghidEventTap)
    }

    private func checkSecureInput() throws {
        if IsSecureEventInputEnabled() {
            if !secureReported {
                secureReported = true
                operation.emit("secure-input")
            }
            throw NativeFailure.needsUser
        }
    }

    private func receive(_ type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            takeOver()
            return
        }
        if event.getIntegerValueField(.eventSourceUserData) == marker { return }
        if Self.pointerEvents.contains(type) && isControlPointer(event) { return }
        takeOver()
    }

    private func takeOver() {
        if !lost {
            lost = true
            operation.emit("takeover")
        }
    }
}
