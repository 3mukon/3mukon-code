import ApplicationServices
import Carbon
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct NativeControl: Encodable, Sendable, Equatable {
    let id: Int
    let role: String
    let label: String?
    let bounds: NativeBounds?
    let actions: [String]
}

struct NativeImage: Encodable, Sendable {
    let mediaType: String
    let data: String
    let width: Int
    let height: Int
    let capturedAt: Int64
}

struct NativeObservation: Encodable, Sendable {
    let id: UUID
    let bounds: NativeBounds
    let elements: [NativeControl]
    let truncated: Bool
    let image: NativeImage?
}

struct NativePreview: Encodable, Sendable {
    struct Frame: Encodable, Sendable {
        let id: UUID
        let bounds: NativeBounds
        let image: NativeImage
    }
    enum Reason: String, Encodable, Sendable {
        case applicationQuit = "application-quit"
        case permissionRequired = "permission-required"
        case targetStateUnsupported = "target-state-unsupported"
    }
    var frame: Frame?
    var reason: Reason?
}

@MainActor
final class NativeObservations {
    struct Element {
        let ref: AXUIElement
        let control: NativeControl
    }
    struct Receipt {
        let id: UUID
        let window: UUID
        let bounds: NativeBounds
        let minimized: Bool
        let elements: [Element]
        let imageSize: CGSize?
        let display: [DisplayGeometry]
        let focus: AXUIElement?
    }

    private let catalog: NativeWindowCatalog
    private var receipts: [UUID: Receipt] = [:]
    private var order: [UUID] = []

    init(catalog: NativeWindowCatalog) { self.catalog = catalog }

    func preview(window: UUID, application: NativeApplication, operation: NativeOperation) async throws -> NativePreview {
        try operation.check()
        guard RunningApplications.resolve(application) != nil else { return NativePreview(reason: .applicationQuit) }
        guard CGPreflightScreenCaptureAccess() else { return NativePreview(reason: .permissionRequired) }
        let live = try catalog.current(window)
        guard live.window.application == application else { throw NativeFailure.stale }
        let observed = try await read(window: window, scope: nil, image: true, operation: operation)
        guard let image = observed.image else { return NativePreview(reason: .targetStateUnsupported) }
        return NativePreview(frame: .init(id: observed.id, bounds: observed.bounds, image: image))
    }

    func read(window: UUID, scope: UUID?, image: Bool, operation: NativeOperation) async throws -> NativeObservation {
        let live = try catalog.current(window)
        if scope == nil && !previewable(live) { throw NativeFailure.unsupported }
        if image && !CGPreflightScreenCaptureAccess() { throw NativeFailure.screen }
        let scan = try await elements(live, operation: operation)
        try operation.check()
        let imageData: NativeImage?
        let display = image ? DisplayGeometry.read(live.bounds.rect) : []
        if image {
            guard !scan.secure, !IsSecureEventInputEnabled() else { throw NativeFailure.unsupported }
            imageData = try await capture(live, maxEdge: scope == nil ? 768 : 2048, operation: operation)
        } else {
            imageData = nil
        }
        try operation.check()
        let latest = try catalog.current(window)
        guard live.bounds == latest.bounds, live.minimized == latest.minimized,
              scope != nil || previewable(latest),
              !image || display == DisplayGeometry.read(live.bounds.rect) else { throw NativeFailure.changed }

        let id = UUID()
        if let scope {
            receipts[scope] = Receipt(
                id: id, window: window, bounds: live.bounds, minimized: live.minimized, elements: scan.elements,
                imageSize: imageData.map { CGSize(width: $0.width, height: $0.height) }, display: display,
                focus: catalog.focusedElement(latest)
            )
            order.removeAll { $0 == scope }
            order.append(scope)
            if order.count > 128 { receipts.removeValue(forKey: order.removeFirst()) }
        }
        return NativeObservation(id: id, bounds: live.bounds, elements: scan.elements.map(\.control),
                                 truncated: scan.truncated, image: imageData)
    }

    func current(id: UUID, window: UUID, scope: UUID) throws -> Receipt {
        guard let entry = receipts[scope], entry.id == id, entry.window == window else { throw NativeFailure.changed }
        return entry
    }

    func consume(_ scope: UUID) {
        receipts.removeValue(forKey: scope)
        order.removeAll { $0 == scope }
    }

    func element(id: Int, receipt: Receipt, live: NativeWindowCatalog.Live) throws -> Element {
        guard let saved = receipt.elements.first(where: { $0.control.id == id }),
              NativeAX.inWindow(saved.ref, window: live.window.element, pid: live.window.application.pid),
              let current = describe(saved.ref, id: id), current == saved.control else { throw NativeFailure.changed }
        return saved
    }

    private func elements(_ live: NativeWindowCatalog.Live, operation: NativeOperation) async throws
        -> (elements: [Element], truncated: Bool, secure: Bool)
    {
        let roots = NativeAX.children(live.window.element, kAXChildrenAttribute, limit: 33)
        var pending = Array(roots.prefix(32))
        var truncated = roots.count > 32
        var checked = 0
        var secure = false
        var found: [Element] = []
        while !pending.isEmpty && checked < 128 && found.count < 48 {
            await Task.yield()
            try operation.check()
            let element = NativeAX.bounded(pending.removeFirst())
            checked += 1
            guard NativeAX.pid(element) == live.window.application.pid else { continue }
            if NativeAX.secure(element) {
                secure = true
                continue
            }
            let role = NativeAX.string(element, kAXRoleAttribute)
            if role == kAXWindowRole || role == kAXSheetRole || role == kAXMenuRole { continue }
            if let fact = describe(element, id: found.count + 1) {
                found.append(Element(ref: element, control: fact))
            }
            let remaining = min(24, 128 - checked - pending.count)
            if remaining > 0 {
                let children = NativeAX.children(element, kAXChildrenAttribute, limit: remaining + 1)
                truncated = truncated || children.count > remaining
                pending.append(contentsOf: children.prefix(remaining))
            }
        }
        return (found, truncated || !pending.isEmpty || checked == 128 || found.count == 48, secure)
    }

    private func describe(_ element: AXUIElement, id: Int) -> NativeControl? {
        guard let role = NativeAX.string(element, kAXRoleAttribute), !NativeAX.secure(element) else { return nil }
        let permitted = [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, "AXLink", kAXStaticTextRole,
                         kAXTextFieldRole, kAXTextAreaRole, kAXScrollBarRole, kAXPopUpButtonRole,
                         kAXComboBoxRole, kAXTabGroupRole, kAXImageRole]
        guard permitted.contains(role) else { return nil }
        var actions: [String] = []
        if NativeAX.value(element, kAXEnabledAttribute) as? Bool != false {
            let available = NativeAX.actions(element)
            if available.contains(kAXPressAction) { actions.append("click") }
            if (role == kAXTextFieldRole || role == kAXTextAreaRole) && NativeAX.settable(element, kAXValueAttribute) {
                actions.append("type")
            }
            if role == kAXScrollBarRole && available.contains(kAXIncrementAction) && available.contains(kAXDecrementAction) {
                actions.append("scroll")
            }
        }
        let label = nativeLabel(NativeAX.string(element, kAXTitleAttribute)) ??
            nativeLabel(NativeAX.string(element, kAXDescriptionAttribute))
        return NativeControl(id: id, role: role, label: label, bounds: NativeAX.bounds(element), actions: actions)
    }

    private func previewable(_ live: NativeWindowCatalog.Live) -> Bool {
        guard !live.minimized,
              let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]
        else { return false }
        return rows.contains { row in
            (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == live.window.number &&
                (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == live.window.application.pid
        }
    }

    private func capture(_ live: NativeWindowCatalog.Live, maxEdge: CGFloat, operation: NativeOperation) async throws -> NativeImage {
        let list = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        try operation.check()
        guard let target = list.windows.first(where: {
            $0.windowID == live.window.number && $0.owningApplication?.processID == live.window.application.pid &&
                $0.owningApplication?.bundleIdentifier == live.window.application.bundleId
        }) else { throw NativeFailure.unsupported }
        guard target.frame == live.bounds.rect else { throw NativeFailure.changed }
        let checked = try catalog.current(live.window.id)
        guard checked.bounds == live.bounds, checked.minimized == live.minimized,
              !IsSecureEventInputEnabled() else { throw NativeFailure.changed }

        let filter = SCContentFilter(desktopIndependentWindow: target)
        let scale = min(CGFloat(max(1, filter.pointPixelScale)), maxEdge / max(live.bounds.width, live.bounds.height))
        let config = SCStreamConfiguration()
        config.width = max(1, Int((live.bounds.width * scale).rounded(.down)))
        config.height = max(1, Int((live.bounds.height * scale).rounded(.down)))
        config.showsCursor = false
        config.capturesAudio = false
        config.ignoreShadowsSingleWindow = true
        config.ignoreGlobalClipSingleWindow = true
        if #available(macOS 14.2, *) { config.includeChildWindows = false }
        try operation.check()
        let raster = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let capturedAt = Int64(Date().timeIntervalSince1970 * 1000)
        try operation.check()
        guard !IsSecureEventInputEnabled(), raster.width == config.width, raster.height == config.height else {
            throw NativeFailure.changed
        }
        let data = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw NativeFailure.unsupported
        }
        CGImageDestinationAddImage(encoder, raster, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
        guard CGImageDestinationFinalize(encoder), data.length > 0, data.length <= 768 * 1024 else {
            throw NativeFailure.unsupported
        }
        return NativeImage(mediaType: "image/jpeg", data: data.base64EncodedString(), width: raster.width,
                           height: raster.height, capturedAt: capturedAt)
    }
}

struct DisplayGeometry: Equatable {
    let id: CGDirectDisplayID
    let pixelsWide: Int
    let pixelsHigh: Int
    let bounds: CGRect

    static func read(_ rect: CGRect) -> [DisplayGeometry] {
        var displays = Array(repeating: CGDirectDisplayID(0), count: 16)
        var count: UInt32 = 0
        guard CGGetDisplaysWithRect(rect, UInt32(displays.count), &displays, &count) == .success else { return [] }
        return displays.prefix(Int(count)).sorted().map {
            DisplayGeometry(id: $0, pixelsWide: CGDisplayPixelsWide($0), pixelsHigh: CGDisplayPixelsHigh($0), bounds: CGDisplayBounds($0))
        }
    }
}
