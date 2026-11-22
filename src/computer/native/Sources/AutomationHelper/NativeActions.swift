import AppKit
import ApplicationServices
import Carbon
import PeekabooAutomationKit

@MainActor
final class NativeActions {
    private let catalog: NativeWindowCatalog
    private let observations: NativeObservations
    private let lanes: DesktopOperationLaneCoordinator
    private let controlPanel: ForegroundPanel

    init(catalog: NativeWindowCatalog, observations: NativeObservations,
         lanes: DesktopOperationLaneCoordinator, controlPanel: ForegroundPanel) {
        self.catalog = catalog
        self.observations = observations
        self.lanes = lanes
        self.controlPanel = controlPanel
    }

    func run(window: UUID, scope: UUID, observation: UUID, input: NativeInput,
             controlRevision: Int?, operation: NativeOperation)
        async -> NativeReply<NativeNull>
    {
        do {
            try operation.check()
            let live = try catalog.current(window)
            guard let start = UInt64(live.window.application.processStart) else { throw NativeFailure.stale }
            let process = ApplicationProcessIdentity(processIdentifier: live.window.application.pid, processStartIdentity: start)
            let lane: DesktopOperationScope = input.foreground ? .global : .process(process)
            return try await lanes.run(scope: lane, access: .write) { @Sendable in
                await self.perform(window: window, scope: scope, observation: observation, input: input,
                                   controlRevision: controlRevision, operation: operation)
            }
        } catch is CancellationError {
            return .cancelled
        } catch is NativeDeadline {
            return .cancelled
        } catch let failure as NativeFailure {
            return .refused(failure)
        } catch {
            return .refused(NativeFailure("busy"))
        }
    }

    func reveal(window: UUID, operation: NativeOperation) async -> NativeReply<NativeNull> {
        do {
            try operation.check()
            return try await lanes.run(scope: .global, access: .write) { @Sendable in
                try await self.revealWindow(window, operation: operation)
            }
        } catch is CancellationError {
            return .cancelled
        } catch is NativeDeadline {
            return .cancelled
        } catch let failure as NativeFailure {
            return .refused(failure)
        } catch {
            return .refused(NativeFailure("busy"))
        }
    }

    // This entry point is reached only through the trusted app's user command, not an action.
    private func revealWindow(_ window: UUID, operation: NativeOperation) async throws -> NativeReply<NativeNull> {
        let live = try catalog.current(window)
        if catalog.foreground(live) { return .verified(NativeNull()) }
        guard !live.minimized, NativeAX.actions(live.window.element).contains(kAXRaiseAction)
        else { throw NativeFailure.needsUser }
        try operation.check()
        guard AXUIElementPerformAction(live.window.element, kAXRaiseAction as CFString) == .success
        else { return .indeterminate("backend-lost") }
        guard let process = RunningApplications.resolve(live.window.application)
        else { return .indeterminate("backend-lost") }
        _ = process.activate(options: [])
        try? await Task.sleep(for: .milliseconds(50))
        return catalog.foreground(live) ? .verified(NativeNull()) : .dispatched
    }

    // Only the call that reaches a mutating OS API consumes its receipt. No exception after that
    // boundary is treated as an unexecuted attempt.
    private func perform(window: UUID, scope: UUID, observation: UUID, input: NativeInput,
                         controlRevision: Int?, operation: NativeOperation)
        async -> NativeReply<NativeNull>
    {
        var sent = false
        let dispatch = {
            if !sent { self.observations.consume(scope) }
            sent = true
        }
        do {
            try operation.check()
            let live = try catalog.current(window)
            let receipt = try observations.current(id: observation, window: window, scope: scope)
            guard live.bounds == receipt.bounds, live.minimized == receipt.minimized else { throw NativeFailure.changed }
            let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
            // A receiver can activate itself after a background action. Report that fact without
            // asking the window server to raise or focus the receiver on the background path.
            defer {
                let pid = live.window.application.pid
                if sent && !input.foreground && before != pid && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
                    operation.emit("target-self-activated")
                }
            }
            let result: NativeReply<NativeNull>
            if input.kind == .window, let change = input.change {
                result = try changeWindow(change, live: live, operation: operation, dispatch: dispatch)
            } else if input.foreground {
                guard let controlRevision else { throw NativeFailure.unsupported }
                let surface = try await waitForControlSurface(controlRevision, operation: operation)
                try await foreground(input, live: live, receipt: receipt, controlSurface: surface,
                                     operation: operation, dispatch: dispatch)
                result = .dispatched
            } else {
                result = try semantic(input, live: live, receipt: receipt, operation: operation, dispatch: dispatch)
            }
            if sent && !input.foreground && before != live.window.application.pid &&
                NSWorkspace.shared.frontmostApplication?.processIdentifier != live.window.application.pid {
                // Give the receiver a bounded chance to surface an activation it queued from AX.
                try? await Task.sleep(for: .milliseconds(200))
            }
            return result
        } catch is CancellationError {
            return sent ? .indeterminate("cancelled-after-dispatch") : .cancelled
        } catch is NativeDeadline {
            return sent ? .indeterminate("timeout") : .cancelled
        } catch let failure as NativeFailure {
            return sent ? .indeterminate("backend-lost") : .refused(failure)
        } catch {
            return sent ? .indeterminate("backend-lost") : .refused(.unsupported)
        }
    }

    private func semantic(_ input: NativeInput, live: NativeWindowCatalog.Live, receipt: NativeObservations.Receipt,
                          operation: NativeOperation, dispatch: () -> Void) throws -> NativeReply<NativeNull> {
        guard let id = input.element else { throw NativeFailure.unsupported }
        let element = try observations.element(id: id, receipt: receipt, live: live)
        guard element.control.actions.contains(input.kind.rawValue) else { throw NativeFailure.unsupported }
        let fresh = try catalog.current(live.window.id)
        guard fresh.bounds == receipt.bounds, fresh.minimized == receipt.minimized else { throw NativeFailure.changed }
        guard !IsSecureEventInputEnabled(), !NativeAX.secure(element.ref) else { throw NativeFailure.needsUser }
        try operation.check()
        switch input.kind {
        case .click:
            dispatch()
            return AXUIElementPerformAction(element.ref, kAXPressAction as CFString) == .success
                ? .dispatched : .indeterminate("backend-lost")
        case .type:
            guard let value = input.text, value.utf16.count <= 1000, !value.contains("\0") else { throw NativeFailure.unsupported }
            dispatch()
            guard AXUIElementSetAttributeValue(element.ref, kAXValueAttribute as CFString, value as CFString) == .success
            else { return .indeterminate("backend-lost") }
            guard !IsSecureEventInputEnabled(), !NativeAX.secure(element.ref),
                  NativeAX.inWindow(element.ref, window: live.window.element, pid: live.window.application.pid)
            else { return .dispatched }
            return NativeAX.string(element.ref, kAXValueAttribute) == value ? .verified(NativeNull()) : .dispatched
        case .scroll:
            guard let direction = input.direction, ["up", "down"].contains(direction) else { throw NativeFailure.unsupported }
            dispatch()
            let action = direction == "down" ? kAXIncrementAction : kAXDecrementAction
            return AXUIElementPerformAction(element.ref, action as CFString) == .success
                ? .dispatched : .indeterminate("backend-lost")
        default:
            throw NativeFailure.unsupported
        }
    }

    private func waitForControlSurface(_ revision: Int, operation: NativeOperation) async throws -> NativeControlSurface {
        // WindowServer can order the native panel after AppKit has accepted its frame.
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(250))
        while true {
            try operation.check()
            if let surface = controlPanel.surface(revision: revision), catalog.isControlSurface(surface) { return surface }
            guard ContinuousClock.now < deadline else { throw NativeFailure.unsupported }
            try await Task.sleep(for: .milliseconds(16))
        }
    }

    private func foreground(_ input: NativeInput, live: NativeWindowCatalog.Live, receipt: NativeObservations.Receipt,
                            controlSurface: NativeControlSurface, operation: NativeOperation,
                            dispatch: () -> Void) async throws {
        guard CGPreflightPostEventAccess() else { throw NativeFailure.accessibility }
        let monitor = ForegroundInput(operation: operation) { event in
            let point = event.location
            guard controlSurface.bounds.rect.contains(point), self.catalog.isControlSurface(controlSurface) else { return false }
            let receiver = event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
            if receiver > 0 { return receiver == Int64(controlSurface.windowId) }
            return self.catalog.topWindow(at: point) == controlSurface.windowId
        }
        defer { monitor.stop() }
        try monitor.start()
        let control = {
            try monitor.check()
            let latest = try self.catalog.current(live.window.id)
            guard latest.bounds == receipt.bounds, latest.minimized == receipt.minimized,
                  receipt.display.isEmpty || receipt.display == DisplayGeometry.read(latest.bounds.rect)
            else { throw NativeFailure.changed }
            guard !latest.minimized, self.catalog.focusedElement(latest) != nil else { throw NativeFailure.needsUser }
            try monitor.check()
        }
        await Task.yield()
        try control()
        switch input.kind {
        case .press:
            guard let focus = receipt.focus else { throw NativeFailure.changed }
            try await press(input, monitor: monitor, live: live, focus: focus, dispatch: dispatch)
        case .pointClick, .pointScroll, .drag:
            guard let pixels = receipt.imageSize, !receipt.display.isEmpty,
                  receipt.display == DisplayGeometry.read(live.bounds.rect) else { throw NativeFailure.changed }
            try await pointer(input, live: live, pixels: pixels, monitor: monitor, control: control, dispatch: dispatch)
        default:
            throw NativeFailure.unsupported
        }
    }

    private func press(_ input: NativeInput, monitor: ForegroundInput, live: NativeWindowCatalog.Live, focus: AXUIElement,
                       dispatch: () -> Void) async throws {
        let keys: [String: Int] = ["left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow,
            "down": kVK_DownArrow, "escape": kVK_Escape, "tab": kVK_Tab, "space": kVK_Space, "return": kVK_Return,
            "backspace": kVK_Delete, "home": kVK_Home, "end": kVK_End, "page-up": kVK_PageUp, "page-down": kVK_PageDown]
        let hold = input.holdMs ?? 0
        guard let name = input.key, let value = keys[name], (0...1000).contains(hold),
              let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(value), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(value), keyDown: false) else {
            throw NativeFailure.unsupported
        }
        guard let current = catalog.focusedElement(live), CFEqual(current, focus) else { throw NativeFailure.changed }
        try monitor.check()
        try await withHeldInput(down: {
            dispatch()
            monitor.post(down)
        }, up: { monitor.post(up) }) {
            let deadline = ContinuousClock.now.advanced(by: .milliseconds(max(hold, 20)))
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
                try monitor.check()
                guard let current = catalog.focusedElement(live), CFEqual(current, focus) else { throw NativeFailure.changed }
            }
        }
    }

    private func pointer(_ input: NativeInput, live: NativeWindowCatalog.Live, pixels: CGSize, monitor: ForegroundInput,
                         control: () throws -> Void, dispatch: () -> Void) async throws {
        guard let source = CGEventSource(stateID: .privateState) else { throw NativeFailure.unsupported }
        func point(_ raw: NativePoint?) throws -> CGPoint {
            guard let raw, raw.x >= 0, raw.y >= 0, raw.x < pixels.width, raw.y < pixels.height else { throw NativeFailure.changed }
            return CGPoint(x: live.bounds.x + raw.x * live.bounds.width / pixels.width,
                           y: live.bounds.y + raw.y * live.bounds.height / pixels.height)
        }
        func mouse(_ type: CGEventType, at point: CGPoint) throws -> CGEvent {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
            else { throw NativeFailure.unsupported }
            return event
        }
        func requireHit(_ point: CGPoint) throws {
            try control()
            guard catalog.topWindow(at: point) == live.window.number else { throw NativeFailure.needsUser }
            var hit: AXUIElement?
            let system = NativeAX.bounded(AXUIElementCreateSystemWide())
            guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
                  let hit, NativeAX.inWindow(NativeAX.bounded(hit), window: live.window.element, pid: live.window.application.pid),
                  !NativeAX.secure(hit) else { throw NativeFailure.needsUser }
            guard catalog.topWindow(at: point) == live.window.number else { throw NativeFailure.needsUser }
            try monitor.check()
        }
        let first = try point(input.kind == .drag ? input.from : input.point)
        try requireHit(first)
        if input.kind == .pointScroll {
            guard let delta = input.deltaY, (-800...800).contains(delta), delta != 0,
                  let wheel = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: -delta, wheel2: 0, wheel3: 0)
            else { throw NativeFailure.unsupported }
            let move = try mouse(.mouseMoved, at: first)
            dispatch()
            monitor.post(move)
            try await Task.sleep(for: .milliseconds(30))
            try requireHit(first)
            guard let cursor = CGEvent(source: nil)?.location, hypot(cursor.x - first.x, cursor.y - first.y) <= 2
            else { throw NativeFailure.needsUser }
            wheel.location = first
            monitor.post(wheel)
            return
        }
        let final = try input.kind == .drag ? point(input.to) : first
        try requireHit(final)
        let down = try mouse(.leftMouseDown, at: first)
        let up = try mouse(.leftMouseUp, at: first)
        try requireHit(first)
        try await withHeldInput(down: {
            dispatch()
            monitor.post(down)
        }, up: {
            // Use the actual cursor location for cleanup after the person moves it.
            up.location = CGEvent(source: nil)?.location ?? up.location
            monitor.post(up)
        }) {
            if input.kind == .drag {
                for step in 1...8 {
                    try await Task.sleep(for: .milliseconds(25))
                    let t = CGFloat(step) / 8
                    let next = CGPoint(x: first.x + (final.x - first.x) * t, y: first.y + (final.y - first.y) * t)
                    try requireHit(next)
                    monitor.post(try mouse(.leftMouseDragged, at: next))
                    up.location = next
                }
            } else {
                try await Task.sleep(for: .milliseconds(20))
                try monitor.check()
            }
        }
    }

    private func changeWindow(_ change: NativeInput.WindowChange, live: NativeWindowCatalog.Live, operation: NativeOperation,
                              dispatch: () -> Void) throws -> NativeReply<NativeNull> {
        let element = live.window.element
        let attribute: String
        let value: CFTypeRef
        switch change.kind {
        case .minimize, .restore:
            attribute = kAXMinimizedAttribute
            value = change.kind == .minimize ? kCFBooleanTrue : kCFBooleanFalse
        case .move:
            guard let x = change.x, let y = change.y, (-100_000...100_000).contains(x), (-100_000...100_000).contains(y)
            else { throw NativeFailure.unsupported }
            var point = CGPoint(x: x, y: y)
            guard let ax = AXValueCreate(.cgPoint, &point) else { throw NativeFailure.unsupported }
            attribute = kAXPositionAttribute
            value = ax
        case .resize:
            guard let width = change.width, let height = change.height,
                  width > 0, width <= 32_768, height > 0, height <= 32_768 else { throw NativeFailure.unsupported }
            var size = CGSize(width: width, height: height)
            guard let ax = AXValueCreate(.cgSize, &size) else { throw NativeFailure.unsupported }
            attribute = kAXSizeAttribute
            value = ax
        }
        guard NativeAX.settable(element, attribute) else { throw NativeFailure.unsupported }
        let fresh = try catalog.current(live.window.id)
        guard fresh.bounds == live.bounds, fresh.minimized == live.minimized else { throw NativeFailure.changed }
        try operation.check()
        dispatch()
        guard AXUIElementSetAttributeValue(element, attribute as CFString, value) == .success
        else { return .indeterminate("backend-lost") }
        return NativeAX.value(element, attribute).map { CFEqual(value, $0) } == true ? .verified(NativeNull()) : .dispatched
    }
}
