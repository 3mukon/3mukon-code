import AppKit
import Carbon

// ⌃⌥⌘. as a hot key of macOS's own, which comes from any application and needs no permission. The
// key is the one that types a period on the user's keyboard.
@MainActor
final class StopShortcut {
    private static let signature: OSType = 0x33_6D_6B_6E
    private let pressed: () -> Void
    private var key: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init(pressed: @escaping () -> Void) {
        self.pressed = pressed
    }

    // Whether macOS registers it.
    static func available() -> Bool {
        guard let key = registered() else { return false }
        UnregisterEventHotKey(key)
        return true
    }

    func listen() {
        guard key == nil else { return }
        if handler == nil {
            var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let context = Unmanaged.passUnretained(self).toOpaque()
            InstallEventHandler(GetApplicationEventTarget(), { _, event, data in
                var id = EventHotKeyID()
                guard let event, let data, GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                                             nil, MemoryLayout<EventHotKeyID>.size, nil, &id) == noErr,
                      id.signature == StopShortcut.signature else { return OSStatus(eventNotHandledErr) }
                MainActor.assumeIsolated { Unmanaged<StopShortcut>.fromOpaque(data).takeUnretainedValue().pressed() }
                return noErr
            }, 1, &pressed, context, &handler)
        }
        key = Self.registered()
    }

    func stopListening() {
        if let key { UnregisterEventHotKey(key) }
        key = nil
    }

    private static func registered() -> EventHotKeyRef? {
        var key: EventHotKeyRef?
        let id = EventHotKeyID(signature: signature, id: 1)
        let status = RegisterEventHotKey(periodKey(), UInt32(controlKey | optionKey | cmdKey), id, GetApplicationEventTarget(), 0, &key)
        return status == noErr ? key : nil
    }

    // An input method stands on a keyboard layout, which says what each key types.
    private static func periodKey() -> UInt32 {
        let usual = UInt32(kVK_ANSI_Period)
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return usual }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
        let found = data.withUnsafeBytes { bytes -> UInt32? in
            guard let layout = bytes.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return nil }
            // The keys of the main block come before the number pad's, which also types a period.
            return (0..<UInt16(kVK_ANSI_KeypadDecimal)).first { code in
                var dead: UInt32 = 0
                var length = 0
                var characters = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                            OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, characters.count, &length, &characters)
                return status == noErr && length == 1 && characters[0] == 46
            }.map(UInt32.init)
        }
        return found ?? usual
    }
}
