import AppKit
import ApplicationServices
import PeekabooAutomationKit

enum NativeAX {
    static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        value(element, attribute) as? String
    }

    static func ref(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let item = value(element, attribute), CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(item, to: AXUIElement.self)
    }

    static func children(_ element: AXUIElement, _ attribute: String, limit: Int) -> [AXUIElement] {
        var result: CFArray?
        guard AXUIElementCopyAttributeValues(element, attribute as CFString, 0, limit, &result) == .success else {
            return []
        }
        return result as? [AXUIElement] ?? []
    }

    static func pid(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success && pid > 0 ? pid : nil
    }

    static func bounded(_ element: AXUIElement) -> AXUIElement {
        AXUIElementSetMessagingTimeout(element, 0.18)
        return element
    }

    static func bounds(_ element: AXUIElement) -> NativeBounds? {
        guard let position = axValue(element, kAXPositionAttribute),
              let size = axValue(element, kAXSizeAttribute) else { return nil }
        var origin = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
        return NativeBounds(CGRect(origin: origin, size: dimensions))
    }

    private static func axValue(_ element: AXUIElement, _ attribute: String) -> AXValue? {
        guard let value = value(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXValue.self)
    }

    static func actions(_ element: AXUIElement) -> [String] {
        var values: CFArray?
        guard AXUIElementCopyActionNames(element, &values) == .success else { return [] }
        return values as? [String] ?? []
    }

    static func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var allowed = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &allowed) == .success && allowed.boolValue
    }

    static func secure(_ element: AXUIElement) -> Bool {
        string(element, kAXRoleAttribute) == kAXSecureTextFieldSubrole ||
            string(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
    }

    static func inWindow(_ element: AXUIElement, window: AXUIElement, pid: pid_t) -> Bool {
        guard self.pid(element) == pid else { return false }
        var ancestor: AXUIElement? = element
        for _ in 0..<16 {
            guard let node = ancestor else { return false }
            if CFEqual(node, window) { return true }
            if let linked = ref(node, kAXWindowAttribute) { return CFEqual(linked, window) }
            ancestor = ref(node, kAXParentAttribute).map(bounded)
        }
        return false
    }
}

struct NativeWindowDescription: Encodable, Sendable {
    let id: UUID
    let title: String
    let bounds: NativeBounds
    let minimized: Bool
}

struct NativeWindowList: Encodable, Sendable {
    let windows: [NativeWindowDescription]
    let truncated: Bool
}

@MainActor
final class NativeWindowCatalog {
    struct Window {
        let id: UUID
        let application: NativeApplication
        let number: CGWindowID
        let element: AXUIElement
    }
    struct Live {
        let window: Window
        let bounds: NativeBounds
        let minimized: Bool
    }

    private var windows: [UUID: Window] = [:]
    private var order: [UUID] = []

    func list(_ application: NativeApplication, operation: NativeOperation) async throws -> NativeWindowList {
        guard RunningApplications.resolve(application) != nil else { throw NativeFailure.stale }
        guard AXIsProcessTrusted() else { throw NativeFailure.accessibility }
        let app = NativeAX.bounded(AXUIElementCreateApplication(application.pid))
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count)
        if status == .noValue || status == .attributeUnsupported {
            return NativeWindowList(windows: [], truncated: false)
        }
        guard status == .success else { throw NativeFailure.unsupported }
        let elements = NativeAX.children(app, kAXWindowsAttribute, limit: min(count, 32))
        var found: [NativeWindowDescription] = []
        var unsettled = false
        for element in elements {
            await Task.yield()
            try operation.check()
            guard let number = AXWindowIDResolver.windowID(of: NativeAX.bounded(element)), number != 0 else { continue }
            let state: (bounds: NativeBounds, minimized: Bool)
            do {
                state = try self.state(element, number: number, application: application)
            } catch let failure as NativeFailure where failure.code == NativeFailure.changed.code {
                unsettled = true
                continue
            } catch {
                continue
            }
            if found.count == 16 { break }

            let prior = windows.values.first { $0.application == application && $0.number == number }
            if let prior, !CFEqual(prior.element, element) { remove(prior.id) }
            let id = prior.flatMap { CFEqual($0.element, element) ? $0.id : nil } ?? UUID()
            windows[id] = Window(id: id, application: application, number: number, element: element)
            order.removeAll { $0 == id }
            order.append(id)
            if order.count > 128 { windows.removeValue(forKey: order.removeFirst()) }
            found.append(NativeWindowDescription(
                id: id, title: nativeLabel(NativeAX.string(element, kAXTitleAttribute)) ?? "Window",
                bounds: state.bounds, minimized: state.minimized
            ))
        }
        try operation.check()
        guard RunningApplications.resolve(application) != nil else { throw NativeFailure.stale }
        let truncated = unsettled || count > elements.count || found.count == 16
        if !truncated {
            let kept = Set(found.map(\.id))
            for old in windows.values.filter({ $0.application == application && !kept.contains($0.id) }) {
                remove(old.id)
            }
        }
        return NativeWindowList(windows: found, truncated: truncated)
    }

    func current(_ id: UUID) throws -> Live {
        guard AXIsProcessTrusted() else { throw NativeFailure.accessibility }
        guard let window = windows[id], RunningApplications.resolve(window.application) != nil else {
            remove(id)
            throw NativeFailure.stale
        }
        do {
            let state = try state(window.element, number: window.number, application: window.application)
            return Live(window: window, bounds: state.bounds, minimized: state.minimized)
        } catch let failure as NativeFailure where failure.code == NativeFailure.stale.code {
            remove(id)
            throw failure
        }
    }

    func foreground(_ live: Live) -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == live.window.application.pid,
              let focus = NativeAX.ref(NativeAX.bounded(AXUIElementCreateApplication(live.window.application.pid)), kAXFocusedWindowAttribute)
        else { return false }
        return CFEqual(focus, live.window.element) && AXWindowIDResolver.windowID(of: focus) == live.window.number
    }

    func focusedElement(_ live: Live) -> AXUIElement? {
        guard foreground(live) else { return nil }
        let system = NativeAX.bounded(AXUIElementCreateSystemWide())
        guard let element = NativeAX.ref(system, kAXFocusedUIElementAttribute),
              NativeAX.inWindow(NativeAX.bounded(element), window: live.window.element, pid: live.window.application.pid),
              !NativeAX.secure(element) else { return nil }
        return element
    }

    func isControlSurface(_ surface: NativeControlSurface) -> Bool {
        guard let window = SystemIdentityResolver.windowIdentity(surface.windowId)
        else { return false }
        return window.ownerProcessIdentifier == getpid() &&
            Int(window.layer) == Int(CGWindowLevelForKey(.statusWindow)) && window.bounds == surface.bounds.rect
    }

    // Ask AppKit for the mouse receiver. Window rectangles alone include transparent and
    // mouse-ignoring overlays, while Accessibility can hit an element behind a receiver.
    func topWindow(at point: CGPoint) -> CGWindowID? {
        let screens = NSScreen.screens
        guard let primary = screens.first?.frame, primary == CGDisplayBounds(CGMainDisplayID()) else { return nil }
        // The primary display is the global origin for both coordinate spaces.
        let appKitPoint = CGPoint(x: point.x, y: primary.maxY - point.y)
        guard screens.contains(where: { $0.frame.contains(appKitPoint) }) else { return nil }
        let number = NSWindow.windowNumber(at: appKitPoint, belowWindowWithWindowNumber: 0)
        return number > 0 ? CGWindowID(exactly: number) : nil
    }

    private func remove(_ id: UUID) {
        windows.removeValue(forKey: id)
        order.removeAll { $0 == id }
    }

    private func state(_ element: AXUIElement, number: CGWindowID, application: NativeApplication)
        throws -> (bounds: NativeBounds, minimized: Bool)
    {
        guard NativeAX.pid(element) == application.pid,
              AXWindowIDResolver.windowID(of: element) == number,
              NativeAX.string(element, kAXRoleAttribute) == kAXWindowRole,
              NativeAX.string(element, kAXSubroleAttribute) == kAXStandardWindowSubrole,
              NativeAX.value(element, kAXModalAttribute) as? Bool != true,
              SystemIdentityResolver.processStartIdentity(application.pid).map(String.init) == application.processStart
        else { throw NativeFailure.stale }
        guard let bounds = NativeAX.bounds(element) else { throw NativeFailure.changed }
        let minimized = NativeAX.value(element, kAXMinimizedAttribute) as? Bool == true
        if let cg = SystemIdentityResolver.windowIdentity(number) {
            guard cg.ownerProcessIdentifier == application.pid, cg.layer == 0 else { throw NativeFailure.stale }
            // Accessibility and the compositor may report different frames during a move or resize.
            // Keep the identity, and require agreement before using any coordinates.
            guard cg.bounds == bounds.rect else { throw NativeFailure.changed }
        } else if !minimized {
            throw NativeFailure.changed
        }
        return (bounds, minimized)
    }
}
