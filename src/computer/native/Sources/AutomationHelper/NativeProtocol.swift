import CoreGraphics
import Foundation

struct NativePoint: Decodable, Sendable {
    let x: Double
    let y: Double
}

struct NativeBounds: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init?(_ rect: CGRect) {
        guard (-100_000...100_000).contains(rect.minX), (-100_000...100_000).contains(rect.minY),
              rect.width > 0, rect.width <= 32_768, rect.height > 0, rect.height <= 32_768 else { return nil }
        x = rect.minX
        y = rect.minY
        width = rect.width
        height = rect.height
    }

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct NativeInput: Decodable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case click, type, scroll, drag, press, window
        case pointClick = "point-click"
        case pointScroll = "point-scroll"
    }
    struct WindowChange: Decodable, Sendable {
        enum Kind: String, Decodable, Sendable { case minimize, restore, move, resize }
        let kind: Kind
        let x: Double?
        let y: Double?
        let width: Double?
        let height: Double?
    }
    let kind: Kind
    let element: Int?
    let text: String?
    let direction: String?
    let point: NativePoint?
    let from: NativePoint?
    let to: NativePoint?
    let deltaY: Int32?
    let key: String?
    let holdMs: Int?
    let change: WindowChange?

    var foreground: Bool {
        switch kind {
        case .pointClick, .pointScroll, .drag, .press: return true
        default: return false
        }
    }
}

struct NativeControlSurface: Sendable {
    let windowId: CGWindowID
    let bounds: NativeBounds
}

struct NativeControlFrame: Decodable, Sendable {
    struct Button: Decodable, Sendable {
        let command: String
        let label: String
        let bounds: NativeBounds
        let enabled: Bool
        let hover: Data?
        let pressed: Data?
    }
    struct Size: Decodable, Sendable {
        let width: Double
        let height: Double
    }
    let image: Data
    let window: UUID
    let size: Size
    let buttons: [Button]
}

struct NativeFailure: Error, Sendable {
    let code: String
    let permission: String?

    init(_ code: String, permission: String? = nil) {
        self.code = code
        self.permission = permission
    }

    static let stale = Self("stale-target")
    static let changed = Self("stale-observation")
    static let unsupported = Self("background-unavailable")
    static let needsUser = Self("needs-user-action")
    static let accessibility = Self("setup-required", permission: "accessibility")
    static let screen = Self("setup-required", permission: "screen-recording")
    static let input = Self("setup-required", permission: "input-monitoring")
}

struct NativeNull: Encodable, Sendable {
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        try value.encodeNil()
    }
}

struct NativeDeadline: Error {}

enum NativeReply<T: Encodable & Sendable>: Encodable, Sendable {
    case verified(T), refused(NativeFailure), cancelled, dispatched, indeterminate(String)

    private enum Key: String, CodingKey { case status, value, code, permission, reason }

    func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Key.self)
        switch self {
        case .verified(let value):
            try fields.encode("verified", forKey: .status)
            try fields.encode(value, forKey: .value)
        case .refused(let failure):
            try fields.encode("refused", forKey: .status)
            try fields.encode(failure.code, forKey: .code)
            try fields.encodeIfPresent(failure.permission, forKey: .permission)
        case .cancelled:
            try fields.encode("cancelled-before-dispatch", forKey: .status)
        case .dispatched:
            try fields.encode("dispatched", forKey: .status)
        case .indeterminate(let reason):
            try fields.encode("indeterminate", forKey: .status)
            try fields.encode(reason, forKey: .reason)
        }
    }
}

@MainActor
struct NativeOperation: Sendable {
    let deadline: ContinuousClock.Instant
    let emit: @MainActor @Sendable (String) -> Void

    func check() throws {
        try Task.checkCancellation()
        guard ContinuousClock.now < deadline else { throw NativeDeadline() }
    }
}
